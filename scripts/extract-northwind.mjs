#!/usr/bin/env node
/**
 * Extract the sample "Northwind" database used by the W3Schools Try-MySQL
 * editor (https://www.w3schools.com/mysql/trymysql.asp).
 *
 * The editor posts each SQL statement to tryit.w3schools.com, which executes
 * it against a read-only MySQL 5.7 instance and returns an HTML table. This
 * script only issues SHOW/SELECT statements, then writes an importable dump.
 *
 * Usage: node scripts/extract-northwind.mjs [--out <file>]
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(PROJECT_ROOT, 'data', 'northwind', 'northwind.sql');
const SOURCE_PAGE = 'https://www.w3schools.com/mysql/trymysql.asp?filename=trysql_select_all';
const ENDPOINT = 'https://tryit.w3schools.com/trymysql_view.php';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BATCH_SIZE = 100;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code =
        entity[1].toLowerCase() === 'x'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function cellText(html) {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).trim();
}

function parseResult(html, label) {
  if (/<h3>Error in SQL:<\/h3>/i.test(html)) {
    const message = html
      .split(/<h3>Error in SQL:<\/h3>/i)[1]
      .split('</body>')[0]
      .replace(/<[^>]*>/g, ' ')
      .trim();
    throw new Error(`${label}: server returned an SQL error: ${message}`);
  }

  const tableMatch = /<table class='w3-table-all notranslate'>(.*?)<\/table>/is.exec(html);
  if (!tableMatch) {
    throw new Error(`${label}: response did not contain a result table`);
  }

  const header = [...tableMatch[1].matchAll(/<th align='left'>(.*?)<\/th>/gis)].map((match) =>
    cellText(match[1]),
  );

  const rows = [];
  for (const rowMatch of tableMatch[1].matchAll(/<tr>(.*?)<\/tr>/gis)) {
    const cells = [...rowMatch[1].matchAll(/<td valign='top'>(.*?)<\/td>/gis)].map((match) =>
      cellText(match[1]),
    );
    if (cells.length > 0) rows.push(cells);
  }

  const reported = Number.parseInt(/Number of Records: (\d+)/i.exec(html)?.[1] ?? '', 10);
  if (Number.isFinite(reported) && reported !== rows.length) {
    throw new Error(`${label}: server reported ${reported} rows but ${rows.length} were parsed`);
  }

  return { header, rows, reported: Number.isFinite(reported) ? reported : rows.length };
}

async function runSql(sql, label) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(`${ENDPOINT}?x=${Math.random()}`, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          Referer: SOURCE_PAGE,
          Accept: 'text/html,application/xhtml+xml',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ code: sql, bt: '1' }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      return parseResult(html, label);
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(1_000 * attempt);
    }
  }
  throw new Error(`Failed ${label} after 4 attempts: ${lastError?.message ?? lastError}`);
}

function assertIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to use unexpected identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

function quoteIdentifier(name) {
  return `\`${assertIdentifier(name)}\``;
}

function escapeSqlString(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\0/g, '\\0')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\x1a/g, '\\Z');
}

const NUMERIC_TYPE =
  /^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|bool|boolean)\b/i;

function sqlLiteral(value, type) {
  if (value === null) return 'NULL';
  if (NUMERIC_TYPE.test(type)) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
      throw new Error(`Expected a numeric value for ${type}, got ${JSON.stringify(value)}`);
    }
    return value;
  }
  return `'${escapeSqlString(value)}'`;
}

function buildInsert(table, columns, rows, types) {
  if (rows.length === 0) return [];
  const columnList = columns.map(quoteIdentifier).join(', ');
  const lines = [];
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const values = batch
      .map((row) => `(${row.map((value, index) => sqlLiteral(value, types[index])).join(', ')})`)
      .join(',\n');
    lines.push(
      `INSERT INTO ${quoteIdentifier(table)} (${columnList}) VALUES\n${values};\n`,
    );
  }
  return lines;
}

async function extractTable(table) {
  assertIdentifier(table);

  const ddlResult = await runSql(`SHOW CREATE TABLE ${quoteIdentifier(table)}`, `SHOW CREATE TABLE ${table}`);
  const createSql = ddlResult.rows[0]?.[1];
  if (!createSql) throw new Error(`No CREATE TABLE statement returned for ${table}`);
  const ddl = createSql.replace(/\s+AUTO_INCREMENT=\d+/i, '').trim();

  const columnsResult = await runSql(`SHOW COLUMNS FROM ${quoteIdentifier(table)}`, `SHOW COLUMNS ${table}`);
  const columns = columnsResult.rows.map((row) => ({
    name: assertIdentifier(row[0]),
    type: row[1],
    nullable: row[2].toUpperCase() === 'YES',
    key: row[3],
    extra: row[5] ?? '',
  }));
  if (columns.length === 0) throw new Error(`No columns returned for ${table}`);

  const nullableColumns = columns.filter((column) => column.nullable);
  const nullMarkers = nullableColumns.map(
    (column, index) => `${quoteIdentifier(column.name)} IS NULL AS ${quoteIdentifier(`__null_${index}`)}`,
  );
  const selectSql =
    nullMarkers.length > 0
      ? `SELECT *, ${nullMarkers.join(', ')} FROM ${quoteIdentifier(table)}`
      : `SELECT * FROM ${quoteIdentifier(table)}`;

  const dataResult = await runSql(selectSql, `SELECT ${table}`);
  const expectedHeader = [
    ...columns.map((column) => column.name),
    ...nullableColumns.map((_, index) => `__null_${index}`),
  ];
  if (
    dataResult.header.length !== expectedHeader.length ||
    dataResult.header.some((name, index) => name !== expectedHeader[index])
  ) {
    throw new Error(
      `${table}: unexpected column layout (${dataResult.header.join(', ')})`,
    );
  }

  const rows = dataResult.rows.map((row, rowIndex) => {
    if (row.length !== expectedHeader.length) {
      throw new Error(`${table}: row ${rowIndex + 1} has ${row.length} cells, expected ${expectedHeader.length}`);
    }
    return columns.map((column, columnIndex) => {
      if (!column.nullable) return row[columnIndex];
      const nullIndex = nullableColumns.indexOf(column);
      return row[columns.length + nullIndex] === '1' ? null : row[columnIndex];
    });
  });

  return {
    table,
    ddl,
    columns,
    rows,
    reported: dataResult.reported,
  };
}

function buildDump(tables, meta) {
  const lines = [
    '-- Northwind sample database',
    `-- Source: ${SOURCE_PAGE}`,
    `-- Backend: MySQL ${meta.serverVersion} (W3Schools Try-MySQL)`,
    `-- Extracted: ${meta.extractedAt}`,
    `-- Tables: ${tables.map((table) => `${table.table} (${table.rows.length})`).join(', ')}`,
    '--',
    '-- This dump recreates the database `northwind`. Existing tables with the',
    '-- same names in that schema are dropped. Import with:',
    '--   mysql -u root -p --default-character-set=utf8mb4 < northwind.sql',
    '',
    'SET NAMES utf8mb4;',
    'SET FOREIGN_KEY_CHECKS = 0;',
    '',
    'CREATE DATABASE IF NOT EXISTS `northwind` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;',
    'USE `northwind`;',
    '',
  ];

  for (const table of tables) {
    lines.push(`-- ------------------------------------------------------------`);
    lines.push(`-- ${table.table}: ${table.rows.length} rows`);
    lines.push(`-- ------------------------------------------------------------`);
    lines.push(`DROP TABLE IF EXISTS ${quoteIdentifier(table.table)};`);
    lines.push(`${table.ddl};`);
    lines.push('');
    lines.push(
      ...buildInsert(
        table.table,
        table.columns.map((column) => column.name),
        table.rows,
        table.columns.map((column) => column.type),
      ),
    );
  }

  lines.push('SET FOREIGN_KEY_CHECKS = 1;');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const outIndex = process.argv.indexOf('--out');
  const outFile = outIndex >= 0 ? resolve(process.argv[outIndex + 1]) : DEFAULT_OUT;
  const extractedAt = new Date().toISOString();

  console.log(`Source: ${SOURCE_PAGE}`);

  const versionResult = await runSql('SELECT VERSION() AS version', 'SELECT VERSION()');
  const serverVersion = versionResult.rows[0]?.[0] ?? 'unknown';
  console.log(`Backend: MySQL ${serverVersion}`);

  const tablesResult = await runSql('SHOW TABLES', 'SHOW TABLES');
  const tableNames = tablesResult.rows.map((row) => row[0]).sort();
  console.log(`Tables: ${tableNames.join(', ')}`);

  const tables = [];
  for (const tableName of tableNames) {
    const extracted = await extractTable(tableName);
    tables.push(extracted);
    console.log(`  ${tableName}: ${extracted.rows.length} rows, ${extracted.columns.length} columns`);
    await sleep(300);
  }

  const dump = buildDump(tables, { serverVersion, extractedAt });
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, dump, 'utf8');

  const report = {
    source: SOURCE_PAGE,
    endpoint: ENDPOINT,
    backendVersion: serverVersion,
    extractedAt,
    outFile,
    bytes: Buffer.byteLength(dump, 'utf8'),
    tables: Object.fromEntries(
      tables.map((table) => [
        table.table,
        {
          rows: table.rows.length,
          columns: table.columns.length,
          createSql: table.ddl,
        },
      ]),
    ),
  };
  await writeFile(join(dirname(outFile), 'extraction-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`\nWrote ${outFile} (${(report.bytes / 1024).toFixed(1)} KiB)`);
  console.log(`Rows total: ${tables.reduce((sum, table) => sum + table.rows.length, 0)}`);
}

await main();
