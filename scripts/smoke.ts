import mysql from 'mysql2/promise';
import { classifyStatement } from '../server/review/sql-classifier';

const host = process.env.MYSQL_HOST ?? '127.0.0.1';
const port = Number(process.env.MYSQL_PORT ?? 3306);
const user = process.env.MYSQL_USER ?? 'root';
const password = process.env.MYSQL_PASSWORD ?? '';
const database = process.env.MYSQL_DATABASE ?? undefined;

async function main(): Promise<void> {
  console.log(`MyLens smoke test → ${user}@${host}:${port}${database ? `/${database}` : ''}`);
  const connection = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    connectTimeout: 8_000,
  });
  try {
    const [versionRows] = await connection.query(
      'SELECT VERSION() AS version, @@version_comment AS comment, @@sql_mode AS sql_mode',
    );
    const version = (versionRows as Record<string, string>[])[0];
    console.log(`  server: ${version.version} (${version.comment})`);
    console.log(`  sql_mode: ${version.sql_mode || '(empty)'}`);

    const [schemaRows] = await connection.query(
      `SELECT COUNT(*) AS schema_count FROM information_schema.SCHEMATA`,
    );
    const [tableRows] = await connection.query(
      `SELECT COUNT(*) AS table_count FROM information_schema.TABLES
       WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')`,
    );
    console.log(
      `  schemas: ${(schemaRows as Record<string, number>[])[0].schema_count} · user tables: ${(tableRows as Record<string, number>[])[0].table_count}`,
    );

    const [one] = await connection.query('SELECT 1 AS ok');
    if ((one as Record<string, number>[])[0].ok !== 1) {
      throw new Error('SELECT 1 returned an unexpected result.');
    }

    const read = classifyStatement('SELECT 1');
    const write = classifyStatement('DELETE FROM example');
    if (!read.readOnly || read.needsUnlock) {
      throw new Error('Classifier failed to mark SELECT as read-only.');
    }
    if (!write.needsUnlock || !write.destructive) {
      throw new Error('Classifier failed to gate DELETE.');
    }
    console.log('  classifier: SELECT is read-only · DELETE requires unlock');

    console.log('  result: OK (read-only verification)');
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(`  result: FAILED — ${(error as Error).message}`);
  process.exitCode = 1;
});
