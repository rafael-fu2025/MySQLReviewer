# Verifies that a script holding several statements runs the one under the
# caret - and that the statement that runs is the one that is gated.
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

$DB = 'audit_tmp_caret'
function Run-Sql($sql, $db, $offset, $label) {
  $payload = @{ sql = $sql; database = $db }
  if ($null -ne $offset) { $payload['cursorOffset'] = $offset }
  try {
    $r = Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session -Headers $auth `
      -ContentType 'application/json' -Body ($payload | ConvertTo-Json)
    return @{ ok = $true; affected = $r.data.affectedRows; rows = $r.data.rowCount }
  } catch {
    $code = ''; $msg = ''
    try { $e = ($_.ErrorDetails.Message | ConvertFrom-Json).error; $code = $e.code; $msg = $e.message } catch { $msg = $_.Exception.Message }
    return @{ ok = $false; code = $code; message = $msg }
  }
}

try { Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session -Headers $auth `
  -ContentType 'application/json' -Body (@{ sql="DROP DATABASE IF EXISTS $DB"; database=$null } | ConvertTo-Json) | Out-Null } catch {}
Invoke-RestMethod -Uri "$base/api/db/$profileId/databases" -Method Post -WebSession $session -Headers $auth `
  -ContentType 'application/json' -Body (@{ name=$DB; charset='utf8mb4'; collation='utf8mb4_general_ci' } | ConvertTo-Json) | Out-Null
Run-Sql "CREATE TABLE $DB.t (id INT PRIMARY KEY, name VARCHAR(50))" $DB $null 'setup' | Out-Null

Write-Output "=== 1) a two-statement script with NO caret is still refused ==="
$script = "INSERT INTO $DB.t (id, name) VALUES (1, 'a');`nSELECT COUNT(*) FROM $DB.t;"
$r = Run-Sql $script $DB $null 'no caret'
if (-not $r.ok -and $r.code -eq 'MULTI_STATEMENT') { Ok "refused without a caret ($($r.code))" }
else { Bad 'refused without a caret' "got '$($r.code)'" }

Write-Output ""
Write-Output "=== 2) the caret picks the statement that runs ==="
$insertAt = $script.IndexOf('INSERT')
$r = Run-Sql $script $DB ($insertAt + 2) 'caret in the INSERT'
if ($r.ok -and $r.affected -eq 1) { Ok 'the INSERT under the caret ran (affected 1 row)' }
else { Bad 'the INSERT under the caret ran' "ok=$($r.ok) affected=$($r.affected) code=$($r.code)" }

$selectAt = $script.IndexOf('SELECT')
$r = Run-Sql $script $DB ($selectAt + 2) 'caret in the SELECT'
if ($r.ok -and $r.rows -eq 1) { Ok 'the SELECT under the caret ran (1 row)' }
else { Bad 'the SELECT under the caret ran' "ok=$($r.ok) rows=$($r.rows) code=$($r.code)" }

Write-Output ""
Write-Output "=== 3) the caret in a gap picks the statement it belongs to ==="
# The position right after a terminator is the start of the next statement, so
# the next statement is the one that runs.
$r = Run-Sql $script $DB ($script.IndexOf(';') + 1) 'caret just after the terminator'
if ($r.ok -and $r.rows -eq 1) { Ok 'the caret just after a terminator runs the next statement' }
else { Bad 'the caret just after a terminator runs the next statement' "ok=$($r.ok) rows=$($r.rows)" }

# The caret in the trailing whitespace after the last statement belongs to the
# last statement.
$trailing = $script + "`n   "
$r = Run-Sql $trailing $DB $trailing.Length 'caret in the trailing whitespace'
if ($r.ok -and $r.rows -eq 1) { Ok 'the caret in the trailing whitespace runs the last statement' }
else { Bad 'the caret in the trailing whitespace runs the last statement' "ok=$($r.ok) rows=$($r.rows)" }

Write-Output ""
Write-Output "=== 4) the statement that runs is the one that is gated (write lock) ==="
# The caret sits on a SELECT, but the script also holds an INSERT. The INSERT
# must not run, and the SELECT must be judged as a read.
$mix = "INSERT INTO $DB.t (id, name) VALUES (2, 'b');`nSELECT COUNT(*) FROM $DB.t;"
$r = Run-Sql $mix $DB ($mix.IndexOf('SELECT') + 2) 'caret on the SELECT'
if ($r.ok -and $r.rows -ge 1) { Ok 'the SELECT ran and no INSERT leaked through' }
else { Bad 'the SELECT ran and no INSERT leaked through' "ok=$($r.ok) rows=$($r.rows)" }

# The caret sits on the INSERT: that statement needs the write lock.
Invoke-RestMethod -Uri "$base/api/connections/$profileId/lock" -Method Post -WebSession $session -Headers $auth | Out-Null
$r = Run-Sql $mix $DB ($mix.IndexOf('INSERT') + 2) 'caret on the INSERT, writes locked'
if (-not $r.ok -and $r.code -eq 'WRITE_LOCKED') { Ok "the INSERT under the caret is refused while writes are locked ($($r.code))" }
else { Bad 'the INSERT under the caret is refused while writes are locked' "got '$($r.code)'" }
Invoke-RestMethod -Uri "$base/api/connections/$profileId/unlock" -Method Post -WebSession $session -Headers $auth `
  -ContentType 'application/json' -Body (@{ phrase='UNLOCK WRITES' } | ConvertTo-Json) | Out-Null

Write-Output ""
Write-Output "=== 5) the member scope still applies to the statement under the caret ==="
$memSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$mBoot = Invoke-RestMethod -Uri "$base/api/bootstrap" -WebSession $memSession -Headers @{ Origin = $base }
$mAuth = @{ 'x-mylens-token' = $mBoot.data.token; Origin = $base }
$mLogin = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -WebSession $memSession -Headers $mAuth `
  -ContentType 'application/json' -Body (@{ username='sherina'; password='member123' } | ConvertTo-Json)
$mAuth['x-mylens-expected-user-id'] = [string]$mLogin.data.user.id
$mProfile = $mLogin.data.user.assignments[0].profileId
$mSandbox = $mLogin.data.user.assignments[0].sandbox
$memScript = "SELECT 1;`nSELECT COUNT(*) FROM checkit_db.attendances;"
$memOffset = $memScript.IndexOf('checkit_db') + 2
try {
  Invoke-RestMethod -Uri "$base/api/db/$mProfile/query" -Method Post -WebSession $memSession -Headers $mAuth `
    -ContentType 'application/json' -Body (@{ sql=$memScript; database=$mSandbox; cursorOffset=$memOffset } | ConvertTo-Json) | Out-Null
  Bad 'the foreign statement under the caret is refused' 'HTTP 200 - the scope was bypassed'
} catch {
  $code = ''
  try { $code = ($_.ErrorDetails.Message | ConvertFrom-Json).error.code } catch {}
  if ($code -eq 'DATABASE_NOT_ALLOWED') { Ok "the foreign statement under the caret is refused ($code)" }
  else { Bad 'the foreign statement under the caret is refused' "got '$code'" }
}

Write-Output ""
Write-Output "=== 6) cleanup ==="
try { Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session -Headers $auth `
  -ContentType 'application/json' -Body (@{ sql="DROP DATABASE IF EXISTS $DB"; database=$null } | ConvertTo-Json) | Out-Null; Ok 'scratch database dropped' }
catch { Bad 'scratch database dropped' $_.Exception.Message }

Write-Output ''
Write-Output '=================================================='
Write-Output ("  PASS: " + $pass + "   FAIL: " + $fail)
Write-Output '=================================================='
if ($fail -gt 0) { exit 1 }
