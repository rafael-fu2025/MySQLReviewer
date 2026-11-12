# End-to-end proof of the SQL export / import feature.
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:8787'
$pass = 0; $fail = 0
function Ok($m) { Write-Output ("  ok        " + $m); $script:pass++ }
function Bad($m, $d) { Write-Output ("  FAILED    " + $m + "  ::  " + $d); $script:fail++ }

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$boot = Invoke-RestMethod -Uri "$base/api/bootstrap" -WebSession $session -Headers @{ Origin = $base }
$auth = @{ 'x-mylens-token' = $boot.data.token; Origin = $base }
$login = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -WebSession $session -Headers $auth `
  -ContentType 'application/json' -Body (@{ username='rafael'; password='review123' } | ConvertTo-Json)
$auth['x-mylens-expected-user-id'] = [string]$login.data.user.id
$conns = Invoke-RestMethod -Uri "$base/api/connections/" -WebSession $session -Headers $auth
$profileId = @($conns.data)[0].id
Invoke-RestMethod -Uri "$base/api/connections/$profileId/unlock" -Method Post -WebSession $session -Headers $auth `
  -ContentType 'application/json' -Body (@{ phrase='UNLOCK WRITES' } | ConvertTo-Json) | Out-Null

# A scratch database with a table, a view and a routine.
$DB = 'audit_tmp_export'
function Run-Sql($sql, $db) {
  try {
    Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session -Headers $auth `
      -ContentType 'application/json' -Body (@{ sql=$sql; database=$db } | ConvertTo-Json) | Out-Null
    return $true
  } catch { Write-Output ("    (sql failed: " + $_.Exception.Message + ")"); return $false }
}
try { Run-Sql "DROP DATABASE IF EXISTS $DB" $null | Out-Null } catch {}
Run-Sql "CREATE DATABASE $DB" $null | Out-Null
Run-Sql "CREATE TABLE $DB.t (id INT PRIMARY KEY, name VARCHAR(50), amount DECIMAL(10,2))" $DB | Out-Null
Run-Sql "INSERT INTO $DB.t (id, name, amount) VALUES (1, 'Acme', 10.50), (2, 'O''Brien', 3)" $DB | Out-Null
Run-Sql "CREATE VIEW $DB.v AS SELECT id, name FROM $DB.t" $DB | Out-Null
Run-Sql "delimiter //`nCREATE PROCEDURE $DB.p_demo() BEGIN SELECT COUNT(*) FROM $DB.t; END//`ndelimiter ;" $DB | Out-Null

Write-Output "=== 1) export the database ==="
$export = Invoke-RestMethod -Uri "$base/api/db/$profileId/databases/$DB/export" -Method Post -WebSession $session `
  -Headers $auth -ContentType 'application/json' -Body (@{ includeData=$true; includeObjects=$true } | ConvertTo-Json)
$d = $export.data
Write-Output ("  filename: " + $d.filename + "   bytes: " + $d.stats.bytes)
Write-Output ("  stats: tables=" + $d.stats.tables + " views=" + $d.stats.views + " triggers=" + $d.stats.triggers + " routines=" + $d.stats.routines + " rows=" + $d.stats.rows)
if ($d.sql -match 'CREATE TABLE') { Ok 'the dump holds the table definition' } else { Bad 'the dump holds the table definition' 'no CREATE TABLE' }
if ($d.sql -match "INSERT INTO ``t``") { Ok 'the dump holds the rows' } else { Bad 'the dump holds the rows' 'no INSERT' }
if ($d.sql -match 'VIEW\s+`') { Ok 'the dump holds the view' } else { Bad 'the dump holds the view' 'no VIEW definition' }
if ($d.sql -match 'CREATE PROCEDURE') { Ok 'the dump holds the routine' } else { Bad 'the dump holds the routine' 'no CREATE PROCEDURE' }
if ($d.sql -match 'DELIMITER') { Ok 'the routine is wrapped in a DELIMITER directive' } else { Bad 'the routine is wrapped in a DELIMITER directive' 'no DELIMITER' }
if ($d.sql -match "O''Brien") { Ok 'a quote in a value is escaped' } else { Bad 'a quote in a value is escaped' 'the quote was not doubled' }

Write-Output ""
Write-Output "=== 2) the import preview reads the dump without executing it ==="
$preview = Invoke-RestMethod -Uri "$base/api/db/$profileId/import/preview" -Method Post -WebSession $session `
  -Headers $auth -ContentType 'application/json' -Body (@{ sql=$d.sql } | ConvertTo-Json)
$p = $preview.data
Write-Output ("  statements: " + $p.statements.Count + "   needUnlock: " + $p.needsUnlockCount + "   destructive: " + $p.destructiveCount + "   hasDelimiter: " + $p.hasDelimiter)
if ($p.statements.Count -ge 4) { Ok "the dump splits into $($p.statements.Count) statements" } else { Bad 'the dump splits into statements' "only $($p.statements.Count)" }
if ($p.hasDelimiter) { Ok 'the DELIMITER directive was detected' } else { Bad 'the DELIMITER directive was detected' 'not detected' }
if ($p.needsUnlockCount -gt 0) { Ok "$($p.needsUnlockCount) statements need the write unlock (reported, not run)" } else { Bad 'statements need the write unlock' 'none reported' }

Write-Output ""
Write-Output "=== 3) the import really executes nothing: the target stays empty ==="
$DB2 = 'audit_tmp_import'
try { Run-Sql "DROP DATABASE IF EXISTS $DB2" $null | Out-Null } catch {}
Run-Sql "CREATE DATABASE $DB2" $null | Out-Null
# Point the dump at the new database and preview it again: still nothing runs.
$retargeted = $d.sql -replace [regex]::Escape($DB), $DB2
$preview2 = Invoke-RestMethod -Uri "$base/api/db/$profileId/import/preview" -Method Post -WebSession $session `
  -Headers $auth -ContentType 'application/json' -Body (@{ sql=$retargeted; database=$DB2 } | ConvertTo-Json)
Write-Output ("  retargeted dump: " + $preview2.data.statements.Count + " statements")
$stillEmpty = Run-Sql "SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$DB2'" $null
$check = Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session -Headers $auth `
  -ContentType 'application/json' -Body (@{ sql="SELECT COUNT(*) AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$DB2'"; database=$null } | ConvertTo-Json)
if ($check.data.rows[0][0] -eq '0') { Ok 'the import preview created nothing' } else { Bad 'the import preview created nothing' "there are $($check.data.rows[0][0]) tables" }

Write-Output ""
Write-Output "=== 4) running the dump statement by statement rebuilds the database ==="
$ran = 0; $failed = @()
foreach ($st in $preview2.data.statements) {
  # A statement's text can begin with the comment lines that preceded it; only
  # the code part decides what it is.
  $code = (($st.sql -split "`n") | Where-Object { $_ -notmatch '^\s*--' }) -join "`n"
  if ($code -match '^\s*SET\s') { continue }
  try {
    Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session -Headers $auth `
      -ContentType 'application/json' -Body (@{ sql=$st.sql; database=$DB2 } | ConvertTo-Json) | Out-Null
    $ran++
  } catch {
    $code = ''; $msg = ''
    try { $e = ($_.ErrorDetails.Message | ConvertFrom-Json).error; $code = $e.code; $msg = $e.message } catch { $msg = $_.Exception.Message }
    $failed += ("[" + $code + "] " + $msg + " :: " + $st.sql.Substring(0, [Math]::Min(60, $st.sql.Length)))
  }
}
Write-Output ("  ran: $ran   failed: " + $failed.Count)
foreach ($f in $failed) { Write-Output ("    FAILED: " + $f) }
$check2 = Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session -Headers $auth `
  -ContentType 'application/json' -Body (@{ sql="SELECT COUNT(*) AS c FROM $DB2.t"; database=$null } | ConvertTo-Json)
if ([int]$check2.data.rows[0][0] -eq 2) { Ok 'the imported table holds the 2 exported rows' }
else { Bad 'the imported table holds the 2 exported rows' "count=$($check2.data.rows[0][0])" }
$check3 = Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session -Headers $auth `
  -ContentType 'application/json' -Body (@{ sql="SELECT COUNT(*) AS c FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = '$DB2'"; database=$null } | ConvertTo-Json)
if ([int]$check3.data.rows[0][0] -ge 1) { Ok 'the imported routine exists' } else { Bad 'the imported routine exists' 'none' }

Write-Output ""
Write-Output "=== 5) a member cannot export a database outside their sandbox ==="
$memSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$mBoot = Invoke-RestMethod -Uri "$base/api/bootstrap" -WebSession $memSession -Headers @{ Origin = $base }
$mAuth = @{ 'x-mylens-token' = $mBoot.data.token; Origin = $base }
$mLogin = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -WebSession $memSession -Headers $mAuth `
  -ContentType 'application/json' -Body (@{ username='sherina'; password='member123' } | ConvertTo-Json)
$mAuth['x-mylens-expected-user-id'] = [string]$mLogin.data.user.id
$mProfile = $mLogin.data.user.assignments[0].profileId
try {
  Invoke-RestMethod -Uri "$base/api/db/$mProfile/databases/checkit_db/export" -Method Post -WebSession $memSession -Headers $mAuth `
    -ContentType 'application/json' -Body (@{ includeData=$false } | ConvertTo-Json) | Out-Null
  Bad 'a member cannot export a foreign database' 'HTTP 200'
} catch {
  $code = ''; try { $code = ($_.ErrorDetails.Message | ConvertFrom-Json).error.code } catch {}
  if ($code -eq 'DATABASE_NOT_ALLOWED') { Ok "a member cannot export a foreign database ($code)" }
  else { Bad 'a member cannot export a foreign database' "got '$code'" }
}

Write-Output ""
Write-Output "=== 6) exporting rows needs the write unlock ==="
Invoke-RestMethod -Uri "$base/api/connections/$profileId/lock" -Method Post -WebSession $session -Headers $auth | Out-Null
try {
  Invoke-RestMethod -Uri "$base/api/db/$profileId/databases/$DB/export" -Method Post -WebSession $session -Headers $auth `
    -ContentType 'application/json' -Body (@{ includeData=$true } | ConvertTo-Json) | Out-Null
  Bad 'exporting rows needs the write unlock' 'HTTP 200'
} catch {
  $code = ''; try { $code = ($_.ErrorDetails.Message | ConvertFrom-Json).error.code } catch {}
  if ($code -eq 'REVEAL_LOCKED') { Ok "exporting rows needs the write unlock ($code)" }
  else { Bad 'exporting rows needs the write unlock' "got '$code'" }
}
# A schema-only export is still allowed.
try {
  Invoke-RestMethod -Uri "$base/api/db/$profileId/databases/$DB/export" -Method Post -WebSession $session -Headers $auth `
    -ContentType 'application/json' -Body (@{ includeData=$false } | ConvertTo-Json) | Out-Null
  Ok 'a schema-only export is allowed without the unlock'
} catch { Bad 'a schema-only export is allowed without the unlock' $_.Exception.Message }
Invoke-RestMethod -Uri "$base/api/connections/$profileId/unlock" -Method Post -WebSession $session -Headers $auth `
  -ContentType 'application/json' -Body (@{ phrase='UNLOCK WRITES' } | ConvertTo-Json) | Out-Null

Write-Output ""
Write-Output "=== 6b) a dump with a foreign key loads in the right order ==="
$DB3 = 'audit_tmp_fk'
$DB4 = 'audit_tmp_fk_target'
foreach ($x in @($DB3, $DB4)) { try { Run-Sql "DROP DATABASE IF EXISTS $x" $null | Out-Null } catch {} }
Run-Sql "CREATE DATABASE $DB3" $null | Out-Null
# The child sorts BEFORE the parent alphabetically, so a dump in name order
# would fail to create the child.
Run-Sql "CREATE TABLE $DB3.zz_parents (id INT PRIMARY KEY, name VARCHAR(20))" $DB3 | Out-Null
Run-Sql "CREATE TABLE $DB3.aa_children (id INT PRIMARY KEY, parent_id INT, CONSTRAINT fk_c FOREIGN KEY (parent_id) REFERENCES $DB3.zz_parents(id))" $DB3 | Out-Null
Run-Sql "INSERT INTO $DB3.zz_parents (id, name) VALUES (1, 'p')" $DB3 | Out-Null
Run-Sql "INSERT INTO $DB3.aa_children (id, parent_id) VALUES (1, 1)" $DB3 | Out-Null
$fkExport = Invoke-RestMethod -Uri "$base/api/db/$profileId/databases/$DB3/export" -Method Post -WebSession $session `
  -Headers $auth -ContentType 'application/json' -Body (@{ includeData=$true; includeObjects=$true } | ConvertTo-Json)
$fkSql = $fkExport.data.sql
$parentAt = $fkSql.IndexOf('zz_parents')
$childAt = $fkSql.IndexOf('aa_children')
Write-Output ("  parent 'zz_parents' at " + $parentAt + ", child 'aa_children' at " + $childAt)
if ($parentAt -ge 0 -and $childAt -ge 0 -and $parentAt -lt $childAt) { Ok 'the parent table is dumped before the child that references it' }
else { Bad 'the parent table is dumped before the child that references it' "parent=$parentAt child=$childAt" }

# Import it into a different database, statement by statement.
Run-Sql "CREATE DATABASE $DB4" $null | Out-Null
$fkPreview = Invoke-RestMethod -Uri "$base/api/db/$profileId/import/preview" -Method Post -WebSession $session `
  -Headers $auth -ContentType 'application/json' -Body (@{ sql=$fkSql } | ConvertTo-Json)
$fkRan = 0; $fkFailed = @()
foreach ($st in $fkPreview.data.statements) {
  $code2 = (($st.sql -split "`n") | Where-Object { $_ -notmatch '^\s*--' }) -join "`n"
  if ($code2 -match '^\s*SET\s') { continue }
  try {
    Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session -Headers $auth `
      -ContentType 'application/json' -Body (@{ sql=$st.sql; database=$DB4 } | ConvertTo-Json) | Out-Null
    $fkRan++
  } catch {
    $fkFailed += (($_.ErrorDetails.Message | ConvertFrom-Json).error.message)
  }
}
Write-Output ("  imported: ran=" + $fkRan + " failed=" + $fkFailed.Count)
foreach ($f in $fkFailed) { Write-Output ("    FAILED: " + $f) }
if ($fkFailed.Count -eq 0) { Ok 'the dump with a foreign key imported cleanly' }
else { Bad 'the dump with a foreign key imported cleanly' ($fkFailed -join ' | ') }
$fkCheck = Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session -Headers $auth `
  -ContentType 'application/json' -Body (@{ sql="SELECT COUNT(*) AS c FROM $DB4.aa_children"; database=$null } | ConvertTo-Json)
if ([int]$fkCheck.data.rows[0][0] -eq 1) { Ok 'the child row arrived with its foreign key intact' }
else { Bad 'the child row arrived with its foreign key intact' "count=$($fkCheck.data.rows[0][0])" }
foreach ($x in @($DB3, $DB4)) { try { Run-Sql "DROP DATABASE IF EXISTS $x" $null | Out-Null } catch {} }

Write-Output ""
Write-Output "=== 6c) a mysqldump-style file: session settings are skipped, the rest runs ==="
$DB5 = 'audit_tmp_dump'
$DB6 = 'audit_tmp_dump_target'
foreach ($x in @($DB5, $DB6)) { try { Run-Sql "DROP DATABASE IF EXISTS $x" $null | Out-Null } catch {} }
Run-Sql "CREATE DATABASE $DB5" $null | Out-Null
Run-Sql "CREATE TABLE $DB5.t (id INT PRIMARY KEY, name VARCHAR(20))" $DB5 | Out-Null
Run-Sql "INSERT INTO $DB5.t (id, name) VALUES (1, 'x')" $DB5 | Out-Null
# The shape mysqldump writes: session settings, a USE, a DROP, then the DDL/DML.
# A single-quoted here-string is literal, so the backticks in the SQL survive
# (a double-quoted one would treat them as PowerShell escape characters).
$dumpTemplate = @'
SET @OLD_CHARACTER_SET_CLIENT = @@CHARACTER_SET_CLIENT;
SET FOREIGN_KEY_CHECKS = 0;
USE `__DB__`;
DROP TABLE IF EXISTS `t`;
CREATE TABLE `t` (
  `id` int NOT NULL,
  `name` varchar(20) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO `t` (`id`, `name`) VALUES (1,'x');
'@
$dumpScript = $dumpTemplate.Replace('__DB__', $DB5)
$dumpPreview = Invoke-RestMethod -Uri "$base/api/db/$profileId/import/preview" -Method Post -WebSession $session `
  -Headers $auth -ContentType 'application/json' -Body (@{ sql=$dumpScript } | ConvertTo-Json)
Write-Output ("  session settings: " + $dumpPreview.data.sessionCount + "   destructive: " + $dumpPreview.data.destructiveCount)
if ($dumpPreview.data.sessionCount -eq 3) { Ok 'the three session settings are recognised' }
else { Bad 'the three session settings are recognised' "got $($dumpPreview.data.sessionCount)" }
if ($dumpPreview.data.destructiveStatements -join ' ' -match 'DROP TABLE') { Ok 'the DROP is reported as destructive' }
else { Bad 'the DROP is reported as destructive' ($dumpPreview.data.destructiveStatements -join ' | ') }

Run-Sql "CREATE DATABASE $DB6" $null | Out-Null
$dumpRan = 0; $dumpFailed = @()
foreach ($st in $dumpPreview.data.statements) {
  if ($st.session) { continue }   # the client skips session settings
  try {
    Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session -Headers $auth `
      -ContentType 'application/json' -Body (@{ sql=$st.sql; database=$DB6 } | ConvertTo-Json) | Out-Null
    $dumpRan++
  } catch { $dumpFailed += (($_.ErrorDetails.Message | ConvertFrom-Json).error.message) }
}
Write-Output ("  ran: $dumpRan   failed: " + $dumpFailed.Count)
foreach ($f in $dumpFailed) { Write-Output ("    FAILED: " + $f) }
if ($dumpFailed.Count -eq 0) { Ok 'the mysqldump-style file imported cleanly' }
else { Bad 'the mysqldump-style file imported cleanly' ($dumpFailed -join ' | ') }
$dumpCheck = Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session -Headers $auth `
  -ContentType 'application/json' -Body (@{ sql="SELECT COUNT(*) AS c FROM $DB6.t"; database=$null } | ConvertTo-Json)
if ([int]$dumpCheck.data.rows[0][0] -eq 1) { Ok 'the imported table holds the row' }
else { Bad 'the imported table holds the row' "count=$($dumpCheck.data.rows[0][0])" }
foreach ($x in @($DB5, $DB6)) { try { Run-Sql "DROP DATABASE IF EXISTS $x" $null | Out-Null } catch {} }

Write-Output ""
Write-Output "=== 7) cleanup ==="
foreach ($d2 in @($DB, $DB2)) {
  try { Run-Sql "DROP DATABASE IF EXISTS $d2" $null | Out-Null } catch {}
}
Ok 'scratch databases dropped'

Write-Output ''
Write-Output '=================================================='
Write-Output ("  PASS: " + $pass + "   FAIL: " + $fail)
Write-Output '=================================================='
if ($fail -gt 0) { exit 1 }
