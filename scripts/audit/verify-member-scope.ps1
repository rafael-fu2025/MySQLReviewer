#requires -Version 5
<#
.SYNOPSIS
  End-to-end verification that a MyLens member cannot escape their sandbox.

.DESCRIPTION
  Drives the running MyLens API as a real MEMBER account and asserts that the
  member database scope holds. Every check below corresponds to a finding from
  docs/AUDIT-2026-10-27-codebase-analysis.md that was reproduced against the
  live application.

  Run the app first, then from the repo root:

      npm start
      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\audit\verify-member-scope.ps1

  The script exits 0 when every check holds, 1 when any check fails.

.NOTES
  It needs a member account whose credentials exist in the local data set
  (the seeded demo account is sherina / member123). It only ever issues
  SELECT-shaped probes plus statements that the scope checker is expected to
  refuse before execution, so no data is modified.
#>
$ErrorActionPreference = 'Continue'
$base = if ($env:MYLENS_BASE) { $env:MYLENS_BASE } else { 'http://127.0.0.1:8787' }
$memberUser = if ($env:MYLENS_MEMBER_USER) { $env:MYLENS_MEMBER_USER } else { 'sherina' }
$memberPass = if ($env:MYLENS_MEMBER_PASS) { $env:MYLENS_MEMBER_PASS } else { 'member123' }

$script:passCount = 0
$script:failCount = 0

function Write-Head($title) { Write-Output ''; Write-Output "=== $title ===" }
function Write-Pass($label) { Write-Output ("  ok        " + $label); $script:passCount++ }
function Write-Fail($label, $detail) { Write-Output ("  FAILED    " + $label + "  ::  " + $detail); $script:failCount++ }

# ---------------------------------------------------------------- authenticate
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try {
  $boot = Invoke-RestMethod -Uri "$base/api/bootstrap" -WebSession $session -Headers @{ Origin = $base }
} catch {
  Write-Output "Cannot reach $base - start the app with 'npm start' first."
  exit 1
}
$token = $boot.data.token
$auth = @{ 'x-mylens-token' = $token; Origin = $base }
try {
  $login = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -WebSession $session -Headers $auth `
    -ContentType 'application/json' -Body (@{ username = $memberUser; password = $memberPass } | ConvertTo-Json)
  $auth['x-mylens-expected-user-id'] = [string]$login.data.user.id
} catch {
  $detail = ''
  try { $detail = ($_.ErrorDetails.Message | ConvertFrom-Json).error.code } catch { $detail = $_.Exception.Message }
  Write-Output "Cannot sign in as '$memberUser' ($detail)."
  Write-Output 'If the account is temporarily locked by the login rate limiter, wait it out'
  Write-Output 'or set MYLENS_MEMBER_USER / MYLENS_MEMBER_PASS.'
  exit 1
}
$assignment = $login.data.user.assignments | Select-Object -First 1
$profileId = $assignment.profileId
$sandbox = $assignment.sandbox
Write-Output ("member=$memberUser role=" + $login.data.user.role + " sandbox=$sandbox")

function Invoke-Scope($sql) {
  # Returns 'allowed' or the refusal code.
  try {
    Invoke-RestMethod -Uri "$base/api/db/$profileId/query" -Method Post -WebSession $session -Headers $auth `
      -ContentType 'application/json' -Body (@{ sql = $sql; database = $sandbox } | ConvertTo-Json) | Out-Null
    return 'allowed'
  } catch {
    try { return ($_.ErrorDetails.Message | ConvertFrom-Json).error.code } catch { return 'error' }
  }
}

function Must-Refuse($sql, $label, $codes) {
  $result = Invoke-Scope $sql
  if ($codes -contains $result) { Write-Pass $label } else { Write-Fail $label "got '$result', expected one of $($codes -join ',')" }
}
function Must-Allow($sql, $label) {
  $result = Invoke-Scope $sql
  if ($result -eq 'allowed') { Write-Pass $label } else { Write-Fail $label "refused with '$result'" }
}

# ------------------------------------------------------- F-04: bootstrap leak
Write-Head 'F-04: the anonymous bootstrap must not disclose anything'
$anon = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$boot2 = Invoke-RestMethod -Uri "$base/api/bootstrap" -WebSession $anon -Headers @{ Origin = $base }
if (-not $boot2.data.token) { Write-Pass 'no master token' } else { Write-Fail 'no master token' 'a token was returned' }
if (@($boot2.data.profiles).Count -eq 0) { Write-Pass 'no connection profiles' } else { Write-Fail 'no connection profiles' "$(@($boot2.data.profiles).Count) returned" }
if (@($boot2.data.providers).Count -eq 0) { Write-Pass 'no AI providers' } else { Write-Fail 'no AI providers' "$(@($boot2.data.providers).Count) returned" }

# --------------------------------------------------- F-01: the EXPLAIN path
Write-Head 'F-01: the EXPLAIN path must enforce the member sandbox'
$explainForeign = $false
try {
  Invoke-RestMethod -Uri "$base/api/db/$profileId/explain" -Method Post -WebSession $session -Headers $auth `
    -ContentType 'application/json' `
    -Body (@{ sql = 'SELECT * FROM checkit_db.attendances'; database = $sandbox; analyze = $false } | ConvertTo-Json) | Out-Null
  $explainForeign = $true
} catch { }
if ($explainForeign) { Write-Fail 'EXPLAIN refuses a foreign database' 'HTTP 200 - the scope was not applied' }
else { Write-Pass 'EXPLAIN refuses a foreign database' }

# ------------------------------------------- F-02 / D-03: executable comments
Write-Head 'F-02 / D-03: MySQL and MariaDB version comments must not escape the scope'
Must-Refuse 'SELECT COUNT(*) AS c FROM /*!checkit_db*/.attendances'      '/*! version comment'        @('EXECUTABLE_COMMENT_NOT_ALLOWED')
Must-Refuse 'SELECT COUNT(*) AS c FROM /*!50000checkit_db*/.attendances' '/*!50000 version comment'   @('EXECUTABLE_COMMENT_NOT_ALLOWED')
Must-Refuse 'SELECT 1 /*M!50000UNION SELECT 2*/'                        '/*M! MariaDB comment'       @('EXECUTABLE_COMMENT_NOT_ALLOWED')
Must-Refuse 'SELECT 5--3 /*!50000UNION SELECT 2*/'                      '-- hides a /*! comment'     @('EXECUTABLE_COMMENT_NOT_ALLOWED')

# ------------------------------------- C-1: the `--` comment rule divergence
Write-Head 'C-1: a `--` that is not a comment must not hide the statement'
Must-Refuse 'SELECT COUNT(*)--1 FROM checkit_db.attendances'      'COUNT(*)--1 FROM a foreign db'        @('DATABASE_NOT_ALLOWED')
Must-Refuse 'SELECT COUNT(*)--1 FROM information_schema.tables'  'COUNT(*)--1 FROM information_schema'   @('DATABASE_NOT_ALLOWED')

# ------------------------------------- H-2: statement shapes naming a database
Write-Head 'H-2: every statement shape that names a foreign database must be refused'
foreach ($probe in @(
  @('CREATE INDEX ix ON checkit_db.t (a)',          'CREATE INDEX ... ON a foreign db'),
  @('DROP INDEX ix ON checkit_db.t',                 'DROP INDEX ... ON a foreign db'),
  @('DROP DATABASE checkit_db',                     'DROP DATABASE a foreign db'),
  @('RENAME TABLE northwind_1.a TO checkit_db.b',   'RENAME TABLE into a foreign db'),
  @('LOCK TABLES checkit_db.t READ',                'LOCK TABLES on a foreign table'),
  @('SHOW FULL TABLES FROM northwind_1, checkit_db','SHOW TABLES naming two databases')
)) {
  Must-Refuse $probe[0] $probe[1] @('DATABASE_NOT_ALLOWED')
}
Must-Refuse "GRANT ALL PRIVILEGES ON *.* TO 'x'@'%'" 'GRANT ALL ON *.*' @('PRIVILEGE_STATEMENT_NOT_ALLOWED')

# --------------------------------------------- F-03: the review routes
Write-Head 'F-03: the review routes must refuse an unassigned profile or a foreign database'
foreach ($case in @(
  @{ p = $profileId; d = 'checkit_db'; n = 'own profile, foreign database' },
  @{ p = '6dee72a7-9fe4-4db6-b52e-ea433d8bcfa7'; d = 'checkit_db'; n = 'unassigned profile, foreign database' }
)) {
  $allowed = $false
  try {
    Invoke-RestMethod -Uri "$base/api/review/static" -Method Post -WebSession $session -Headers $auth `
      -ContentType 'application/json' `
      -Body (@{ sql = 'SELECT id FROM attendances'; profileId = $case.p; database = $case.d; includeSchema = $true } | ConvertTo-Json) | Out-Null
    $allowed = $true
  } catch { }
  if ($allowed) { Write-Fail ("review/static refuses: " + $case.n) 'HTTP 200' } else { Write-Pass ("review/static refuses: " + $case.n) }
}

# --------------------------------------------- F-19 / F-11: AI route gates
Write-Head 'F-19 / F-11: the AI routes must be admin-gated'
foreach ($ep in @('providers', 'chat')) {
  $allowed = $false
  try {
    if ($ep -eq 'chat') {
      Invoke-RestMethod -Uri "$base/api/ai/$ep" -Method Post -WebSession $session -Headers $auth `
        -ContentType 'application/json' -Body (@{ message = 'hello' } | ConvertTo-Json) | Out-Null
    } else {
      Invoke-RestMethod -Uri "$base/api/ai/$ep" -WebSession $session -Headers $auth | Out-Null
    }
    $allowed = $true
  } catch { }
  if ($allowed) { Write-Fail ("member refused: /api/ai/$ep") 'HTTP 200' } else { Write-Pass ("member refused: /api/ai/$ep") }
}

# --------------------------------------------- D-04: the reveal lock
Write-Head 'D-04: the table-data path must honour the reveal lock'
try {
  Invoke-RestMethod -Uri "$base/api/db/$profileId/databases/$sandbox/tables/customers/data" -Method Post -WebSession $session -Headers $auth `
    -ContentType 'application/json' -Body (@{ revealSensitive = $true } | ConvertTo-Json) | Out-Null
  Write-Fail 'table data refuses reveal without unlock' 'HTTP 200'
} catch {
  $code = ''
  try { $code = ($_.ErrorDetails.Message | ConvertFrom-Json).error.code } catch { }
  if ($code -eq 'REVEAL_LOCKED') { Write-Pass 'table data refuses reveal without unlock' }
  else { Write-Fail 'table data refuses reveal without unlock' "refused with '$code'" }
}

# --------------------------------------------- the member can still work
Write-Head 'the member can still work inside their sandbox'
Must-Allow "SELECT COUNT(*) FROM categories" 'a plain in-scope query'
Must-Allow "SELECT COUNT(*) FROM categories FORCE INDEX (primary)" 'a query the SQL parser cannot read'

Write-Output ''
Write-Output '=================================================='
Write-Output ("  PASS: " + $script:passCount + "   FAIL: " + $script:failCount)
Write-Output '=================================================='
if ($script:failCount -gt 0) { exit 1 }
