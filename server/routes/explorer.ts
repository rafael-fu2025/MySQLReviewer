import { Router } from 'express';
import { z } from 'zod';
import {
  getDatabaseObjects,
  getEventDefinition,
  getRoutineDefinition,
  getSchemaSnapshot,
  getSchemaSummary,
  getTableData,
  getTableDetail,
  getTriggerDefinition,
  getViewDefinition,
  invalidateSchemaCache,
  listDatabases,
  listTables,
} from '../db/introspection';
import { createDatabase, listCharsets } from '../db/create-database';
import { exportDatabaseSql, previewImportScript } from '../db/import-export';
import { assertDatabaseAllowed } from '../db/scope';
import { assertProfileAssigned, requireAdmin, sandboxScopeOverride } from '../auth';
import { resolveWriteUnlock } from '../store/users';
import { AppError } from '../errors';
import { asyncHandler, parseBody, parseQuery, param } from './util';

const TableDataSchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  orderBy: z.string().max(200).nullable().optional(),
  orderDir: z.enum(['asc', 'desc']).optional(),
  revealSensitive: z.boolean().optional(),
  filters: z
    .array(
      z.object({
        column: z.string().min(1).max(200),
        operator: z.enum([
          '=',
          '!=',
          '>',
          '>=',
          '<',
          '<=',
          'LIKE',
          'NOT LIKE',
          'IS NULL',
          'IS NOT NULL',
        ]),
        value: z.string().max(20_000).optional(),
      }),
    )
    .max(20)
    .optional(),
});

const CreateDatabaseSchema = z.object({
  name: z.string().min(1).max(64),
  charset: z.string().min(1).max(64),
  collation: z.string().min(1).max(128),
  addToScope: z.boolean().optional(),
});

const SchemaQuery = z.object({
  database: z.string().min(1).max(200),
});

const RefreshBody = z.object({
  database: z.string().min(1).max(200).optional(),
});

export const explorerRouter = Router();

// Members may only browse profiles assigned to them; the per-database
// scope below then narrows them to their sandboxes.
explorerRouter.use('/:profileId', (req, _res, next) => {
  try {
    assertProfileAssigned(req, req.params.profileId);
    next();
  } catch (error) {
    next(error);
  }
});

// Register the schema cache-control route before the generic
// `/:profileId/databases/:database` middleware. A member may refresh only an
// assigned database key; invalidating every database cached for a profile is
// an administrator-only shared-runtime operation.
explorerRouter.post(
  '/:profileId/schema/refresh',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const body = parseBody(RefreshBody, req);
    if (body.database) {
      await assertDatabaseAllowed(
        profileId,
        body.database,
        sandboxScopeOverride(req.user, profileId),
      );
    } else {
      requireAdmin(req);
    }
    invalidateSchemaCache(profileId, body.database);
    res.json({ data: { refreshed: true } });
  }),
);

explorerRouter.use(
  '/:profileId/databases/:database',
  asyncHandler(async (req, _res, next) => {
    await assertDatabaseAllowed(
      req.params.profileId,
      req.params.database,
      sandboxScopeOverride(req.user, req.params.profileId),
    );
    next();
  }),
);

explorerRouter.get(
  '/:profileId/databases',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    res.json({
      data: await listDatabases(profileId, sandboxScopeOverride(req.user, profileId)),
    });
  }),
);

explorerRouter.post(
  '/:profileId/databases',
  asyncHandler(async (req, res) => {
    // Members work inside their sandboxes; new databases on the server are
    // an admin action.
    const user = requireAdmin(req);
    const profileId = param(req, 'profileId');
    const writeAccess = await resolveWriteUnlock(profileId, user.id);
    if (!writeAccess.allowed) {
      throw new AppError(
        'WRITE_LOCKED',
        writeAccess.blocker
          ? writeAccess.message
          : 'Creating a database requires unlocking writes for this connection.',
        403,
      );
    }
    const body = parseBody(CreateDatabaseSchema, req);
    res.status(201).json({ data: await createDatabase(profileId, body) });
  }),
);

explorerRouter.get(
  '/:profileId/charsets',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    res.json({ data: await listCharsets(profileId) });
  }),
);

explorerRouter.get(
  '/:profileId/databases/:database/tables',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const database = param(req, 'database');
    res.json({ data: await listTables(profileId, database) });
  }),
);

explorerRouter.get(
  '/:profileId/databases/:database/objects',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const database = param(req, 'database');
    res.json({ data: await getDatabaseObjects(profileId, database) });
  }),
);

explorerRouter.get(
  '/:profileId/databases/:database/tables/:table',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const database = param(req, 'database');
    const table = param(req, 'table');
    res.json({ data: await getTableDetail(profileId, database, table) });
  }),
);

const ExportSchema = z.object({
  includeData: z.boolean().optional(),
  includeObjects: z.boolean().optional(),
  rowLimit: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

/**
 * Export one database as a `.sql` script.
 *
 * The dump is a script, not a data channel: it is reviewed and then run
 * statement by statement through the ordinary gates. A dump that carries rows
 * holds the raw value of every column, so it is a write-level action and the
 * reveal lock applies, exactly as it does for the table browser.
 */
explorerRouter.post(
  '/:profileId/databases/:database/export',
  asyncHandler(async (req, res) => {
    const user = assertProfileAssigned(req, param(req, 'profileId'));
    const profileId = param(req, 'profileId');
    const database = param(req, 'database');
    const body = parseBody(ExportSchema, req);
    // The dump names one database; the member scope still decides whether
    // this connection may read it.
    await assertDatabaseAllowed(profileId, database, sandboxScopeOverride(req.user, profileId));
    if (body.includeData === true) {
      const writeAccess = await resolveWriteUnlock(profileId, user.id);
      if (!writeAccess.allowed) {
        throw new AppError(
          'REVEAL_LOCKED',
          writeAccess.blocker
            ? writeAccess.message
            : 'Unlock writes for this connection before exporting the rows of a database.',
          403,
        );
      }
    }
    res.json({ data: await exportDatabaseSql(profileId, database, body) });
  }),
);

const ImportSchema = z.object({
  sql: z.string().min(1).max(20_000_000),
  database: z.string().max(200).nullable().optional(),
});

/**
 * Read an imported script and report the statements it holds.
 *
 * Nothing is executed here. The caller shows the statements and then runs
 * them one at a time through the ordinary query path, so every gate still
 * applies to each one.
 */
explorerRouter.post(
  '/:profileId/import/preview',
  asyncHandler(async (req, res) => {
    assertProfileAssigned(req, param(req, 'profileId'));
    const body = parseBody(ImportSchema, req);
    res.json({ data: previewImportScript(body.sql) });
  }),
);

explorerRouter.post(
  '/:profileId/databases/:database/tables/:table/data',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const database = param(req, 'database');
    const table = param(req, 'table');
    const body = parseBody(TableDataSchema, req);
    // Revealing masked values is a write-level action; the route rejects it
    // before the data path can serve cleartext secrets.
    if (body.revealSensitive === true) {
      const writeAccess = await resolveWriteUnlock(profileId, req.user?.id);
      if (!writeAccess.allowed) {
        throw new AppError(
          'REVEAL_LOCKED',
          writeAccess.blocker
            ? writeAccess.message
            : 'Unlock writes for this connection before revealing masked values.',
          403,
        );
      }
    }
    res.json({
      data: await getTableData(profileId, database, table, { ...body, userId: req.user?.id }),
    });
  }),
);

explorerRouter.get(
  '/:profileId/schema',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const query = parseQuery(SchemaQuery, req);
    await assertDatabaseAllowed(
      profileId,
      query.database,
      sandboxScopeOverride(req.user, profileId),
    );
    res.json({ data: await getSchemaSummary(profileId, query.database) });
  }),
);

explorerRouter.get(
  '/:profileId/schema/full',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const query = parseQuery(SchemaQuery, req);
    await assertDatabaseAllowed(
      profileId,
      query.database,
      sandboxScopeOverride(req.user, profileId),
    );
    res.json({ data: await getSchemaSnapshot(profileId, query.database) });
  }),
);

explorerRouter.get(
  '/:profileId/objects/:database/:type/:name',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const database = param(req, 'database');
    const type = param(req, 'type').toLowerCase();
    const name = param(req, 'name');
    await assertDatabaseAllowed(profileId, database, sandboxScopeOverride(req.user, profileId));
    if (type === 'view') {
      res.json({ data: await getViewDefinition(profileId, database, name) });
      return;
    }
    if (type === 'trigger') {
      res.json({ data: await getTriggerDefinition(profileId, database, name) });
      return;
    }
    if (type === 'event') {
      res.json({ data: await getEventDefinition(profileId, database, name) });
      return;
    }
    if (type === 'routine') {
      const routineType = String(req.query.routineType ?? 'PROCEDURE').toUpperCase();
      if (routineType !== 'FUNCTION' && routineType !== 'PROCEDURE') {
        throw new AppError('VALIDATION', 'routineType must be FUNCTION or PROCEDURE.', 400);
      }
      res.json({
        data: await getRoutineDefinition(profileId, database, routineType, name),
      });
      return;
    }
    throw new AppError('VALIDATION', 'Unknown object type.', 400);
  }),
);
