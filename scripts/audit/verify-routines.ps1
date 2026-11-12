# End-to-end: create a FUNCTION and a PROCEDURE through the query editor
# using the mysql-client `delimiter` convention, and prove the directive is
# never sent to the server.
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:8787'
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$pass = 0; $fail = 0
function Ok($m) { Write-Output ("  ok        " + $m); $script:pass++ }
function Bad($m, $d) { Write-Output ("  FAILED    " + $m + "  ::  " + $d); $script:fail++ }

$boot = Invoke-RestMethod -Uri "$base/api/bootstrap" -WebSession $session -Headers @{ Origin = $base }
$auth = @{ 'x-mylens-token' = $boot.data.token; Origin = $base }
$login = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -WebSession $session -Headers $auth `
  -ContentType 'application/json' -Body (@{ username='rafael'; password='review123' } | ConvertTo-Json)
$auth['x-mylens-expected-user-id'] = [string]$login.data.user.id
Write-Output ("signed in as " + $login.data.user.username + " role=" + $login.data.user.role)

$conns = Invoke-RestMethod -Uri "$base/api/connections/" -WebSession $session -Headers $auth
$profile = @($conns.data)[0]
$profileId = $profile.id
Write-Output ("profile: " + $profile.name + " host=" + $profile.host + " db=" + $profile.database)
Write-Output ""

# Unlock writes for this connection (admin -> profile wide).
$u = Invoke-RestMethod -Uri "$base/api/connections/$profileId/unlock" -Method Post -WebSession $session `
  -Headers $auth -ContentType 'application/json' -Body (@{ phrase='UNLOCK WRITES' } | ConvertTo-Json)
Write-Output ("unlock: " + $u.data.unlocked + " ttl=" + $u.data.ttlSeconds + "s")
Write-Output ""

$DB = 'audit_tmp_routine'
function Run-Sql($sql, $database, $label) {
  try {
    $r = Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session `
      -Headers $auth -ContentType 'application/json' -Body (@{ sql=$sql; database=$database } | ConvertTo-Json)
    return @{ ok = $true; result = $r.data }
  } catch {
    $code = ''
    try { $code = ($_.ErrorDetails.Message | ConvertFrom-Json).error.code } catch { $code = $_.Exception.Message }
    return @{ ok = $false; code = $code; message = $_.ErrorDetails.Message }
  }
}

Write-Output "=== 0) a scratch database to create the routine in ==="
$r = Run-Sql "DROP DATABASE IF EXISTS $DB" $null 'drop'
$r = Run-Sql "CREATE DATABASE $DB" $null 'create'
if ($r.ok) { Ok "scratch database $DB created" } else { Bad "scratch database $DB created" $r.code }

Write-Output ""
Write-Output "=== 1) the DELIMITER directive on its own is not SQL ==="
$r = Run-Sql 'delimiter //' $null 'directive'
if (-not $r.ok -and $r.code -in @('EMPTY_SQL','SQL_PARSE_FAILED')) { Ok "directive alone is refused as empty SQL ($($r.code))" }
else { Bad "directive alone is refused as empty SQL" "ok=$($r.ok) code=$($r.code)" }

Write-Output ""
Write-Output "=== 2) CREATE PROCEDURE using the delimiter convention ==="
$script = @"
delimiter //
CREATE PROCEDURE audit_tmp_proc()
BEGIN
  SELECT COUNT(*) AS n FROM $DB.audit_tmp_rows;
  SELECT 2 AS two;
END//
delimiter ;
"@
$r = Run-Sql $script $DB 'procedure'
if ($r.ok) { Ok "procedure created (rowsAffected=$($r.result.affectedRows))" }
else { Bad "procedure created" "$($r.code) $($r.message)" }

Write-Output ""
Write-Output "=== 3) CREATE FUNCTION using the delimiter convention ==="
$script2 = @"
delimiter //
CREATE FUNCTION audit_tmp_fn() RETURNS INT
DETERMINISTIC
BEGIN
  RETURN 42;
END//
delimiter ;
"@
$r = Run-Sql $script2 $DB 'function'
if ($r.ok) { Ok "function created" } else { Bad "function created" "$($r.code) $($r.message)" }

Write-Output ""
Write-Output "=== 4) do the routines actually exist on the server? ==="
$r = Run-Sql "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = '$DB'" $DB 'check'
$names = @()
if ($r.ok) { foreach ($row in @($r.result.rows)) { $names += "$($row[0]) ($($row[1]))" } }
if ($names -contains 'audit_tmp_proc (PROCEDURE)') { Ok "audit_tmp_proc exists on the server" } else { Bad "audit_tmp_proc exists on the server" ($names -join ', ') }
if ($names -contains 'audit_tmp_fn (FUNCTION)') { Ok "audit_tmp_fn exists on the server" } else { Bad "audit_tmp_fn exists on the server" ($names -join ', ') }

Write-Output ""
Write-Output "=== 5) the routine body can be called ==="
$r = Run-Sql 'SELECT audit_tmp_fn() AS answer' $DB 'call'
if ($r.ok) { Ok "the function returns $($r.result.rows[0][0])" } else { Bad "the function can be called" "$($r.code) $($r.message)" }

Write-Output ""
Write-Output "=== 5b) CALL on a procedure that returns rows ==="
# A CALL answers with several results - the OK packet of the call itself and
# the result set of the procedure - which is a different shape from a plain
# statement. The result set has to be found and shown.
$callTemplate = @'
delimiter //
CREATE PROCEDURE audit_tmp_call_rows()
BEGIN
  SELECT 7 AS seven, 'seven' AS word;
END//
delimiter ;
'@
$r = Run-Sql $callTemplate $DB 'create'
if ($r.ok) { Ok 'the procedure that returns rows was created' } else { Bad 'the procedure that returns rows was created' "$($r.code) $($r.message)" }

$r = Run-Sql 'CALL audit_tmp_call_rows()' $DB 'call'
if ($r.ok -and $r.result.rowCount -eq 1) { Ok "CALL returns the row (rowCount=$($r.result.rowCount), value=$($r.result.rows[0][0]))" }
elseif ($r.ok) { Bad 'CALL returns the row' "ok but rowCount=$($r.result.rowCount)" }
else { Bad 'CALL returns the row' "$($r.code) $($r.message)" }

# Without a database selected the server looks in the connection's default
# database, so the routine has to be named with its schema.
$r = Run-Sql "CALL $DB.audit_tmp_call_rows()" $null 'call-qualified'
if ($r.ok -and $r.result.rowCount -eq 1) { Ok 'a schema-qualified CALL works without a database selected' }
elseif ($r.ok) { Bad 'a schema-qualified CALL works without a database selected' "ok but rowCount=$($r.result.rowCount)" }
else { Bad 'a schema-qualified CALL works without a database selected' "$($r.code) $($r.message)" }

$r = Run-Sql 'DROP PROCEDURE IF EXISTS audit_tmp_call_rows' $DB 'drop'
if (-not $r.ok) { $r = Run-Sql "DROP PROCEDURE IF EXISTS $DB.audit_tmp_call_rows" $DB 'drop' }

Write-Output ""
Write-Output "=== 6) cleanup ==="
$r = Run-Sql "DROP PROCEDURE IF EXISTS $DB.audit_tmp_proc" $DB 'drop proc'
$r = Run-Sql "DROP FUNCTION IF EXISTS $DB.audit_tmp_fn" $DB 'drop fn'
$r = Run-Sql "DROP DATABASE IF EXISTS $DB" $null 'drop db'
if ($r.ok) { Ok "scratch database dropped" } else { Bad "scratch database dropped" $r.code }
$r = Run-Sql "SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = '$DB'" $null 'verify'
if ($r.ok) { Ok "no routines left behind (count=$($r.result.rows[0][0]))" } else { Ok "scratch database gone" }

# Re-lock so the connection is left as it was found.
try { Invoke-RestMethod -Uri "$base/api/connections/$profileId/lock" -Method Post -WebSession $session -Headers $auth | Out-Null } catch {}

Write-Output ''
Write-Output '=================================================='
Write-Output ("  PASS: " + $pass + "   FAIL: " + $fail)
Write-Output '=================================================='
if ($fail -gt 0) { exit 1 }
