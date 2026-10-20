import type { StatementKind } from '../../shared/types';
import {
  containsWord,
  findTopLevelSequence,
  significantTokens,
  splitStatements,
  tokenUpper,
  type Token,
} from './tokenizer';

export interface StatementInfo {
  sql: string;
  tokens: Token[];
  line: number;
  classification: StatementClassification;
}

export interface StatementClassification {
  kind: StatementKind;
  readOnly: boolean;
  destructive: boolean;
  needsUnlock: boolean;
  lockRead: boolean;
  executesQuery: boolean;
  reason?: string;
}

export interface ClassifiedSql {
  statements: StatementInfo[];
  overall: StatementClassification;
  multiStatement: boolean;
  empty: boolean;
}

const READ_KEYWORDS = new Set([
  'SELECT',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'TABLE',
  'VALUES',
  'HELP',
]);

const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE']);
const DDL_KEYWORDS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME']);
const ADMIN_KEYWORDS = new Set([
  'SET',
  'USE',
  'CALL',
  'KILL',
  'FLUSH',
  'RESET',
  'PURGE',
  'GRANT',
  'REVOKE',
  'ANALYZE',
  'OPTIMIZE',
  'REPAIR',
  'CHECK',
  'CHECKSUM',
  'LOAD',
  'HANDLER',
  'INSTALL',
  'UNINSTALL',
  'SHUTDOWN',
  'CHANGE',
  'START',
  'STOP',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'LOCK',
  'UNLOCK',
  'PREPARE',
  'EXECUTE',
  'DEALLOCATE',
  'SIGNAL',
  'RESIGNAL',
  'GET',
  'XA',
  'BINLOG',
  'CACHE',
  'DO',
  'DELIMITER',
]);

const RISK_RANK: Record<StatementKind, number> = {
  unknown: 5,
  ddl: 4,
  write: 3,
  admin: 2,
  read: 1,
};

const RISK_LABEL: Record<StatementKind, string> = {
  unknown: 'Unknown statement',
  ddl: 'Schema change',
  write: 'Data change',
  admin: 'Administrative statement',
  read: 'Read-only query',
};

function base(kind: StatementKind): StatementClassification {
  return {
    kind,
    readOnly: kind === 'read',
    destructive: false,
    needsUnlock: kind !== 'read',
    lockRead: false,
    executesQuery: kind !== 'ddl',
  };
}

function findMainKeyword(tokens: Token[]): Token | null {
  if (tokens.length === 0) return null;
  const first = tokenUpper(tokens[0]);
  if (first !== 'WITH') return tokens[0];

  const candidates = new Set([
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'REPLACE',
    'TABLE',
    'VALUES',
  ]);
  for (const token of tokens) {
    if (token.kind !== 'word') continue;
    if (token.depth !== 0) continue;
    const upper = tokenUpper(token);
    if (candidates.has(upper)) return token;
  }
  return tokens[0];
}

function classifyKeyword(keyword: string, tokens: Token[]): StatementClassification {
  const upper = keyword.toUpperCase();

  if (READ_KEYWORDS.has(upper)) {
    const result = base('read');
    result.executesQuery = true;
    if (upper === 'SELECT') {
      const fileWrite = containsWord(tokens, 'OUTFILE') || containsWord(tokens, 'DUMPFILE');
      if (fileWrite) {
        result.kind = 'admin';
        result.readOnly = false;
        result.destructive = true;
        result.needsUnlock = true;
        result.reason = 'SELECT ... INTO OUTFILE/DUMPFILE writes a file on the MySQL server.';
        return result;
      }
      const forUpdate = findTopLevelSequence(tokens, 'FOR', 'UPDATE') >= 0;
      const forShare = findTopLevelSequence(tokens, 'FOR', 'SHARE') >= 0;
      const lockInShare = findTopLevelSequence(tokens, 'LOCK', 'IN', 'SHARE', 'MODE') >= 0;
      if (forUpdate || forShare || lockInShare) {
        result.lockRead = true;
        result.needsUnlock = true;
        result.reason = forUpdate
          ? 'SELECT ... FOR UPDATE takes row locks.'
          : 'A shared lock read takes row locks.';
      }
    }
    return result;
  }

  if (WRITE_KEYWORDS.has(upper)) {
    const result = base('write');
    result.executesQuery = true;
    result.destructive = upper !== 'INSERT';
    result.reason =
      upper === 'REPLACE'
        ? 'REPLACE deletes conflicting rows before inserting.'
        : `${upper} changes data.`;
    return result;
  }

  if (DDL_KEYWORDS.has(upper)) {
    const result = base('ddl');
    result.executesQuery = false;
    result.destructive =
      upper === 'DROP' ||
      upper === 'TRUNCATE' ||
      (upper === 'ALTER' &&
        (containsWord(tokens, 'DROP') || containsWord(tokens, 'CHANGE')));
    result.reason = `${upper} changes the schema.`;
    return result;
  }

  if (upper === 'EXPLAIN') {
    let index = 1;
    const second = tokenUpper(tokens[index]);
    const analyze = second === 'ANALYZE';
    if (analyze) index += 1;

    if (tokenUpper(tokens[index]) === 'FORMAT') {
      index += 1;
      if (tokens[index]?.value === '=') index += 1;
      index += 1; // JSON / TREE
    }

    const underlying = tokens[index];
    if (!underlying) {
      const result = base('admin');
      result.reason = 'EXPLAIN without a statement.';
      return result;
    }

    const inner = classifyKeyword(underlying.value, tokens.slice(index));
    if (analyze) {
      inner.executesQuery = true;
      if (!inner.readOnly) {
        inner.reason = `EXPLAIN ANALYZE executes the ${underlying.value.toUpperCase()} statement.`;
        inner.needsUnlock = true;
      } else {
        inner.reason = 'EXPLAIN ANALYZE executes the query and collects runtime statistics.';
      }
      return inner;
    }

    const result: StatementClassification = {
      ...inner,
      // Plain EXPLAIN does not execute the underlying statement.
      readOnly: true,
      needsUnlock: false,
      destructive: false,
      executesQuery: false,
      lockRead: false,
      reason: 'EXPLAIN does not execute the statement.',
    };
    return result;
  }

  if (ADMIN_KEYWORDS.has(upper)) {
    const result = base('admin');
    result.executesQuery = true;
    result.reason =
      upper === 'USE'
        ? 'Use the database selector instead of USE; pooled connections do not keep session state.'
        : `${upper} is an administrative statement.`;
    if (upper === 'SHUTDOWN' || upper === 'RESET' || upper === 'PURGE') {
      result.destructive = true;
    }
    return result;
  }

  const result = base('unknown');
  result.needsUnlock = true;
  result.reason = 'The statement type could not be classified safely.';
  return result;
}

export function classifyStatement(sql: string): StatementClassification {
  return classifySql(sql).overall;
}

function mergeClassification(items: StatementClassification[]): StatementClassification {
  if (items.length === 0) {
    return {
      kind: 'unknown',
      readOnly: false,
      destructive: false,
      needsUnlock: false,
      lockRead: false,
      executesQuery: false,
      reason: 'Empty statement.',
    };
  }
  if (items.length === 1) return items[0];

  let kind: StatementKind = 'read';
  for (const item of items) {
    if (RISK_RANK[item.kind] > RISK_RANK[kind]) kind = item.kind;
  }
  return {
    kind,
    readOnly: items.every((item) => item.readOnly && !item.lockRead),
    destructive: items.some((item) => item.destructive),
    needsUnlock: items.some((item) => item.needsUnlock),
    lockRead: items.some((item) => item.lockRead),
    executesQuery: items.some((item) => item.executesQuery),
    reason: 'Multiple statements are reviewed together but must be executed one at a time.',
  };
}

export function classifySql(sql: string): ClassifiedSql {
  const parts = splitStatements(sql);
  const statements: StatementInfo[] = parts.map((part) => {
    const tokens = significantTokens(part.tokens);
    const main = findMainKeyword(tokens);
    return {
      sql: part.sql,
      tokens,
      line: part.line,
      classification: main
        ? classifyKeyword(main.value, tokens)
        : {
            kind: 'unknown',
            readOnly: false,
            destructive: false,
            needsUnlock: true,
            lockRead: false,
            executesQuery: false,
            reason: 'The statement type could not be classified safely.',
          },
    };
  });

  return {
    statements,
    overall: mergeClassification(statements.map((statement) => statement.classification)),
    multiStatement: statements.length > 1,
    empty: statements.length === 0,
  };
}

export function classifySummary(classification: StatementClassification): string {
  const parts = [RISK_LABEL[classification.kind]];
  if (classification.destructive) parts.push('destructive');
  if (classification.lockRead) parts.push('takes locks');
  if (classification.needsUnlock) parts.push('requires unlock');
  if (classification.reason) parts.push(classification.reason);
  return parts.join(' · ');
}
