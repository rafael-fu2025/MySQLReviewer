# Northwind — W3Schools Try-MySQL sample database

An importable extraction of the sample database used by the
[W3Schools Try-MySQL editor](https://www.w3schools.com/mysql/trymysql.asp?filename=trysql_select_all).

| Table | Rows | Columns |
| --- | ---: | ---: |
| Categories | 8 | 3 |
| Customers | 91 | 7 |
| Employees | 9 | 6 |
| OrderDetails | 2,155 | 4 |
| Orders | 830 | 5 |
| Products | 77 | 6 |
| Shippers | 3 | 3 |
| Suppliers | 29 | 8 |
| **Total** | **3,202** | |

## Files

- `northwind.sql` — complete dump: `CREATE DATABASE northwind`, schema, and data.
- `extraction-report.json` — provenance, backend version, per-table row counts, and the exact `CREATE TABLE` statements returned by the source.

## Import

Using the XAMPP client on Windows:

```bat
C:\xampp\mysql\bin\mysql.exe -u root --default-character-set=utf8mb4 < northwind.sql
```

Or with any MySQL/MariaDB client:

```bash
mysql -u root -p --default-character-set=utf8mb4 < northwind.sql
```

The dump creates the `northwind` schema if it does not exist and **drops/recreates the eight Northwind tables inside it**. Back up or rename an existing `northwind` schema first if you need to keep it.

## What this database is

This is W3Schools' simplified copy of the classic Microsoft Northwind sample:

- Every table has a single-column `AUTO_INCREMENT` primary key.
- There are **no foreign-key constraints** and no secondary indexes.
- Some classic columns are absent — for example, `Employees` has no `ReportsTo`, `Customers` has no `Region`, and `Orders` has no `Freight`.
- Text columns use the older `utf8` (utf8mb3) charset while the table default is `latin1`; the dump preserves the source definitions.

That makes it convenient for practicing `SELECT`/`JOIN`/aggregate queries, but it is not a realistic schema-review subject for constraints, normalization, or index analysis.

## Re-extract

The extractor needs Node.js 18+ (uses the built-in `fetch`) and network access to W3Schools:

```bash
node scripts/extract-northwind.mjs
node scripts/extract-northwind.mjs --out path/to/northwind.sql
```

It sends read-only `SHOW`/`SELECT` statements to the same endpoint the editor uses, detects `NULL` values via `column IS NULL` markers, and writes the dump plus `extraction-report.json`.

## Verification

Extracted on 2026-10-20 from MySQL `5.7.44-rds.20250508`. The dump was imported into a temporary local MariaDB 10.4 schema and every row of all eight tables was compared against the live W3Schools source: **all 3,202 rows matched, and accented text was stored as valid UTF-8**.
