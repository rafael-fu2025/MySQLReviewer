import type { ExplainResult, StaticReviewResult } from '../../shared/types';
import { AppError, mapDbError } from '../errors';
import { getSettings } from '../store/settings';
import { getSchemaSnapshot } from '../db/introspection';
import { runExplain } from '../db/explain';
import { assertDatabaseAllowed, assertSqlScope } from '../db/scope';
import { classifySql } from './sql-classifier';
import { buildContextInfo, buildRuleContext } from './context';
import { dedupeFindings } from './findings';
import { scoreFindings } from './scoring';
import { suggestIndexes } from './index-advisor';
import { runQuerySchemaRules, runSqlRules } from './rules';

export interface StaticReviewInput {
  profileId?: string | null;
  database?: string | null;
  sql: string;
  includeSchema?: boolean;
  includeExplain?: boolean;
  analyze?: boolean;
  /** Narrows a member session to their sandbox databases. */
  scopeOverride?: { allowed: string[] };
}

export async function runStaticReview(input: StaticReviewInput): Promise<StaticReviewResult> {
  const sql = input.sql.trim();
  if (!sql) throw new AppError('EMPTY_SQL', 'There is no SQL to review.', 400);
  const classified = classifySql(sql);
  if (classified.empty) throw new AppError('EMPTY_SQL', 'There is no SQL to review.', 400);
  if (input.profileId) {
    await assertSqlScope(input.profileId, sql, input.database ?? null, input.scopeOverride);
    // The schema snapshot is a database read of its own: it has to be inside
    // the same scope as the statement under review.
    if (input.database) {
      await assertDatabaseAllowed(input.profileId, input.database, input.scopeOverride);
    }
  }

  const settings = await getSettings();
  const warnings: string[] = [];
  let schema = null;

  if (input.profileId && input.database && input.includeSchema !== false) {
    try {
      schema = await getSchemaSnapshot(input.profileId, input.database);
    } catch (error) {
      warnings.push(`Schema context unavailable: ${mapDbError(error).message}`);
    }
  }

  const context = buildRuleContext({
    sql,
    schema,
  });

  const findings = [...runSqlRules(context), ...runQuerySchemaRules(context)];
  let explain: ExplainResult | null = null;

  if (input.includeExplain && input.profileId) {
    try {
      explain = await runExplain(input.profileId, sql, input.database ?? null, {
        analyze: Boolean(input.analyze),
        scopeOverride: input.scopeOverride,
      });
      findings.push(...explain.insights);
    } catch (error) {
      warnings.push(`EXPLAIN unavailable: ${mapDbError(error).message}`);
    }
  }

  const suggestions = suggestIndexes(context);
  if (explain) explain.suggestions = suggestions;

  const unique = dedupeFindings(findings);
  const score = scoreFindings(unique);
  const contextInfo = buildContextInfo(
    context.tables,
    input.database ?? null,
    8,
    settings.aiContextChars,
  );

  return {
    sql,
    statements: classified.statements.map((statement) => ({
      sql: statement.sql,
      kind: statement.classification.kind,
      line: statement.line,
    })),
    findings: unique,
    score,
    context: contextInfo,
    explain,
    suggestions,
    warnings,
  };
}
