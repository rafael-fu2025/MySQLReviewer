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
import { assertDatabaseAllowed } from '../db/scope';
import { isWritesUnlocked } from '../db/manager';
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

explorerRouter.use(
  '/:profileId/databases/:database',
  asyncHandler(async (req, _res, next) => {
    await assertDatabaseAllowed(req.params.profileId, req.params.database);
    next();
  }),
);

explorerRouter.get(
  '/:profileId/databases',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    res.json({ data: await listDatabases(profileId) });
  }),
);

explorerRouter.post(
  '/:profileId/databases',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    if (!isWritesUnlocked(profileId)) {
      throw new AppError(
        'WRITE_LOCKED',
        'Creating a database requires unlocking writes for this connection.',
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

explorerRouter.post(
  '/:profileId/databases/:database/tables/:table/data',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const database = param(req, 'database');
    const table = param(req, 'table');
    const body = parseBody(TableDataSchema, req);
    res.json({ data: await getTableData(profileId, database, table, body) });
  }),
);

explorerRouter.get(
  '/:profileId/schema',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const query = parseQuery(SchemaQuery, req);
    await assertDatabaseAllowed(profileId, query.database);
    res.json({ data: await getSchemaSummary(profileId, query.database) });
  }),
);

explorerRouter.get(
  '/:profileId/schema/full',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const query = parseQuery(SchemaQuery, req);
    await assertDatabaseAllowed(profileId, query.database);
    res.json({ data: await getSchemaSnapshot(profileId, query.database) });
  }),
);

explorerRouter.post(
  '/:profileId/schema/refresh',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const body = parseBody(RefreshBody, req);
    if (body.database) {
      await assertDatabaseAllowed(profileId, body.database);
    }
    invalidateSchemaCache(profileId, body.database);
    res.json({ data: { refreshed: true } });
  }),
);

explorerRouter.get(
  '/:profileId/objects/:database/:type/:name',
  asyncHandler(async (req, res) => {
    const profileId = param(req, 'profileId');
    const database = param(req, 'database');
    const type = param(req, 'type').toLowerCase();
    const name = param(req, 'name');
    await assertDatabaseAllowed(profileId, database);
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
        data: await getRoutineDefinition(
          profileId,
          database,
          routineType,
          name,
        ),
      });
      return;
    }
    throw new AppError('VALIDATION', 'Unknown object type.', 400);
  }),
);
