# End-to-end proof of the write-unlock policy:
#   * the global switch, set by an administrator, locks every account
#   * the per-member switch, set by an administrator, locks one account
#   * a member's own unlock is refused with a specific error code
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:8787'
$pass = 0; $fail = 0
function Ok($m) { Write-Output ("  ok        " + $m); $script:pass++ }
function Bad($m, $d) { Write-Output ("  FAILED    " + $m + "  ::  " + $d); $script:fail++ }

function New-Session {
  $s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $boot = Invoke-RestMethod -Uri "$base/api/bootstrap" -WebSession $s -Headers @{ Origin = $base }
  $h = @{ 'x-mylens-token' = $boot.data.token; Origin = $base }
  return @{ Session = $s; Headers = $h }
}
function Login($ctx, $user, $pw) {
  $r = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -WebSession $ctx.Session -Headers $ctx.Headers `
    -ContentType 'application/json' -Body (@{ username = $user; password = $pw } | ConvertTo-Json)
  $ctx.Headers['x-mylens-expected-user-id'] = [string]$r.data.user.id
  return @{ Ctx = $ctx; User = $r.data.user }
}
function Try-Post($ctx, $url, $body) {
  try {
    $r = Invoke-RestMethod -Uri "$url" -Method Post -WebSession $ctx.Session -Headers $ctx.Headers `
      -ContentType 'application/json' -Body ($body | ConvertTo-Json)
    return @{ ok = $true; data = $r.data }
  } catch {
    $code = ''
    try { $code = ($_.ErrorDetails.Message | ConvertFrom-Json).error.code } catch { $code = '' }
    return @{ ok = $false; code = $code; message = $_.ErrorDetails.Message }
  }
}
function Try-Put($ctx, $url, $body) {
  try {
    $r = Invoke-RestMethod -Uri "$url" -Method Put -WebSession $ctx.Session -Headers $ctx.Headers `
      -ContentType 'application/json' -Body ($body | ConvertTo-Json)
    return @{ ok = $true; data = $r.data }
  } catch {
    $code = ''
    try { $code = ($_.ErrorDetails.Message | ConvertFrom-Json).error.code } catch { $code = '' }
    return @{ ok = $false; code = $code }
  }
}

$admin = Login (New-Session) 'rafael' 'review123'
Write-Output ("admin: " + $admin.User.username)
$conns = Invoke-RestMethod -Uri "$base/api/connections/" -WebSession $admin.Ctx.Session -Headers $admin.Ctx.Headers
$profileId = @($conns.data)[0].id
$member = $admin.User.id
Write-Output ("profile: " + $profileId)
Write-Output ""

Write-Output "=== 1) the default is permissive: an admin can unlock ==="
$r = Try-Post $admin.Ctx "$base/api/connections/$profileId/unlock" @{ phrase = 'UNLOCK WRITES' }
if ($r.ok -and $r.data.unlocked) { Ok 'the admin unlocked the connection' } else { Bad 'the admin unlocked the connection' $r.code }

Write-Output ""
Write-Output "=== 2) the global switch locks every account, admins included ==="
$r = Try-Put $admin.Ctx "$base/api/admin/settings/write-unlock" @{ enabled = $false }
if ($r.ok) { Ok 'the global switch was turned off' } else { Bad 'the global switch was turned off' $r.code }

$r = Try-Post $admin.Ctx "$base/api/connections/$profileId/unlock" @{ phrase = 'UNLOCK WRITES' }
if (-not $r.ok -and $r.code -eq 'WRITE_UNLOCK_DISABLED') { Ok "the admin's own unlock is refused ($($r.code))" }
else { Bad "the admin's own unlock is refused" "got '$($r.code)'" }

$r = Try-Post $admin.Ctx "$base/api/db/$profileId/query" @{ sql = "UPDATE northwind_1.customers SET name = 'x'"; database = 'northwind_1' }
if (-not $r.ok -and $r.code -eq 'WRITE_LOCKED') { Ok "a write is refused while the switch is off ($($r.code))" }
else { Bad 'a write is refused while the switch is off' "got '$($r.code)'" }

$r = Try-Post $admin.Ctx "$base/api/db/$profileId/query" @{ sql = 'SELECT 1'; database = 'northwind_1'; revealSensitive = $true }
if (-not $r.ok -and $r.code -eq 'REVEAL_LOCKED') { Ok "revealing masked values is refused too ($($r.code))" }
else { Bad 'revealing masked values is refused too' "got '$($r.code)'" }

Write-Output ""
Write-Output "=== 3) turning the switch back on restores the normal behaviour ==="
$r = Try-Put $admin.Ctx "$base/api/admin/settings/write-unlock" @{ enabled = $true }
if ($r.ok) { Ok 'the global switch was turned back on' } else { Bad 'the global switch was turned back on' $r.code }
$r = Try-Post $admin.Ctx "$base/api/connections/$profileId/unlock" @{ phrase = 'UNLOCK WRITES' }
if ($r.ok -and $r.data.unlocked) { Ok 'the admin can unlock again' } else { Bad 'the admin can unlock again' $r.code }

Write-Output ""
Write-Output "=== 4) the per-member switch locks one account only ==="
$adminCtx = $admin.Ctx
$adminHeaders = $admin.Ctx.Headers
$adminSession = $admin.Ctx.Session

# Find the member account id from the admin API.
$users = Invoke-RestMethod -Uri "$base/api/admin/users" -WebSession $adminSession -Headers $adminHeaders
$memberUser = @($users.data) | Where-Object { $_.username -eq 'sherina' } | Select-Object -First 1
Write-Output ("member account: " + $memberUser.username + " (" + $memberUser.id + ")")

$r = Try-Put $adminCtx "$base/api/admin/users/$($memberUser.id)/write-unlock" @{ disabled = $true }
if ($r.ok) { Ok 'the member was blocked' } else { Bad 'the member was blocked' $r.code }

$mem = Login (New-Session) 'sherina' 'member123'
$memProfile = $mem.User.assignments[0].profileId
$r = Try-Post $mem.Ctx "$base/api/connections/$memProfile/unlock" @{ phrase = 'UNLOCK WRITES' }
if (-not $r.ok -and $r.code -eq 'WRITE_UNLOCK_DISABLED') { Ok "the blocked member's unlock is refused ($($r.code))" }
else { Bad "the blocked member's unlock is refused" "got '$($r.code)'" }

$r = Try-Post $mem.Ctx "$base/api/db/$memProfile/query" @{ sql = 'SELECT 1'; database = 'northwind_1'; revealSensitive = $true }
if (-not $r.ok -and $r.code -eq 'REVEAL_LOCKED') { Ok 'the blocked member cannot reveal masked values' }
else { Bad 'the blocked member cannot reveal masked values' "got '$($r.code)'" }

# The block is per ACCOUNT, not per connection: the administrator can still
# unlock the very same profile that the blocked member is assigned to.
$r = Try-Post $adminCtx "$base/api/connections/$memProfile/unlock" @{ phrase = 'UNLOCK WRITES' }
if ($r.ok -and $r.data.unlocked) { Ok 'the administrator is unaffected on the very same profile' }
else { Bad 'the administrator is unaffected on the very same profile' "got '$($r.code)'" }
try { Invoke-RestMethod -Uri "$base/api/connections/$memProfile/lock" -Method Post -WebSession $adminSession -Headers $adminHeaders | Out-Null } catch {}

Write-Output ""
Write-Output "=== 5) restore the member ==="
$r = Try-Put $adminCtx "$base/api/admin/users/$($memberUser.id)/write-unlock" @{ disabled = $false }
if ($r.ok) { Ok 'the member was unblocked' } else { Bad 'the member was unblocked' $r.code }
$r = Try-Post $mem.Ctx "$base/api/connections/$memProfile/unlock" @{ phrase = 'UNLOCK WRITES' }
if ($r.ok -and $r.data.unlocked) { Ok 'the member can unlock again' } else { Bad 'the member can unlock again' "got '$($r.code)'" }
try { Invoke-RestMethod -Uri "$base/api/connections/$memProfile/lock" -Method Post -WebSession $mem.Ctx.Session -Headers $mem.Ctx.Headers | Out-Null } catch {}

Write-Output ""
Write-Output "=== 6) the per-connection switch makes one connection read-only for members ==="
# The administrator closes write access on the member's own connection, after it
# was created.
$all = Invoke-RestMethod -Uri "$base/api/connections/" -WebSession $adminSession -Headers $adminHeaders
$target = @($all.data) | Where-Object { $_.id -eq $memProfile } | Select-Object -First 1
$body = @{
  name = $target.name; host = $target.host; port = $target.port; user = $target.user
  database = $target.database; writeAccess = 'locked'
}
$r = Try-Put $adminCtx "$base/api/connections/$memProfile" $body
if ($r.ok -and $r.data.writeAccess -eq 'locked') { Ok 'the administrator closed write access on the connection' }
else { Bad 'the administrator closed write access on the connection' "$($r.code)" }

# The member cannot unlock a connection that is read-only for them.
$r = Try-Post $mem.Ctx "$base/api/connections/$memProfile/unlock" @{ phrase = 'UNLOCK WRITES' }
if (-not $r.ok -and $r.code -eq 'WRITE_UNLOCK_DISABLED') { Ok "the member's unlock is refused ($($r.code))" }
else { Bad "the member's unlock is refused" "got '$($r.code)'" }

# And the member cannot write.
$r = Try-Post $mem.Ctx "$base/api/db/$memProfile/query" @{ sql = "UPDATE northwind_1.customers SET name = 'x'"; database = 'northwind_1' }
if (-not $r.ok -and $r.code -eq 'WRITE_LOCKED') { Ok "the member's write is refused ($($r.code))" }
else { Bad "the member's write is refused" "got '$($r.code)'" }

# The administrator is not affected on the very same connection.
$r = Try-Post $adminCtx "$base/api/connections/$memProfile/unlock" @{ phrase = 'UNLOCK WRITES' }
if ($r.ok -and $r.data.unlocked) { Ok 'the administrator keeps write access on the locked connection' }
else { Bad 'the administrator keeps write access on the locked connection' "got '$($r.code)'" }
try { Invoke-RestMethod -Uri "$base/api/connections/$memProfile/lock" -Method Post -WebSession $adminSession -Headers $adminHeaders | Out-Null } catch {}

# The connection can be opened again.
$body.writeAccess = 'full'
$r = Try-Put $adminCtx "$base/api/connections/$memProfile" $body
if ($r.ok -and $r.data.writeAccess -eq 'full') { Ok 'the administrator opened the connection again' }
else { Bad 'the administrator opened the connection again' "$($r.code)" }
$r = Try-Post $mem.Ctx "$base/api/connections/$memProfile/unlock" @{ phrase = 'UNLOCK WRITES' }
if ($r.ok -and $r.data.unlocked) { Ok 'the member can unlock the connection again' }
else { Bad 'the member can unlock the connection again' "got '$($r.code)'" }
try { Invoke-RestMethod -Uri "$base/api/connections/$memProfile/lock" -Method Post -WebSession $mem.Ctx.Session -Headers $mem.Ctx.Headers | Out-Null } catch {}

Write-Output ''
Write-Output '=================================================='
Write-Output ("  PASS: " + $pass + "   FAIL: " + $fail)
Write-Output '=================================================='
if ($fail -gt 0) { exit 1 }
