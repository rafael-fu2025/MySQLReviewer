/**
 * One-off handoff cleanup: removes the demo accounts/sessions/activity files
 * and the two sandbox clones created during verification, so the app boots
 * into its own first-run setup screen for the real admin.
 */
import fs from 'node:fs';
import mysql from 'mysql2/promise';

const CLONES = ['northwind_3', 'northwind_4'];

const conn = await mysql.createConnection({
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '',
});

// Only drop databases that are provably clones of northwind (same table set).
const [source] = await conn.query(
  'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
  ['northwind'],
);
const sourceTables = new Set(source.map((row) => String(row.TABLE_NAME)));

for (const name of CLONES) {
  const [tables] = await conn.query(
    'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?',
    [name],
  );
  if (tables.length === 0) continue;
  const cloneTables = new Set(tables.map((row) => String(row.TABLE_NAME)));
  const identical =
    cloneTables.size === sourceTables.size &&
    [...cloneTables].every((table) => sourceTables.has(table));
  if (identical) {
    await conn.query(`DROP DATABASE \`${name}\``);
    console.log(`dropped verified clone ${name}`);
  } else {
    console.log(`kept ${name} — table set differs from northwind, review manually`);
  }
}

await conn.end();

for (const file of ['data/users.json', 'data/sessions.json', 'data/activity.json']) {
  if (fs.existsSync(file)) {
    fs.rmSync(file);
    console.log(`removed ${file}`);
  }
}
