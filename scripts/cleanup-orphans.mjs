/**
 * One-off cleanup: the two empty orphan databases created by the failed
 * provisioning attempts during development (northwind_1, northwind_2).
 * Only drops a database when it matches the sandbox naming pattern AND has
 * zero tables, so real data can never be lost.
 */
import mysql from 'mysql2/promise';

const ORPHANS = ['northwind_1', 'northwind_2'];

const conn = await mysql.createConnection({
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
});

for (const name of ORPHANS) {
  const [tables] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [name],
  );
  const count = Number(tables[0].n);
  if (count === 0) {
    await conn.query(`DROP DATABASE \`${name}\``);
    console.log(`dropped empty orphan ${name}`);
  } else {
    console.log(`kept ${name} (${count} tables — not empty)`);
  }
}

await conn.end();
