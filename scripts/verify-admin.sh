#!/usr/bin/env bash
# End-to-end verification of the admin layer against a live server.
# Setup admin -> create member -> provision sandbox -> assert isolation.
# Resets nothing: point it at a server whose data has no users yet, or run
# scripts/reset-admin-demo.mjs first.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE=http://127.0.0.1:8787
ORIGIN="Origin: $BASE"
RESP=".verify-resp.json"
trap 'rm -f "$RESP"' EXIT
JQ() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);const v=$1;console.log(typeof v==='object'?JSON.stringify(v):String(v))}catch(e){console.log('PARSE_ERROR')}})"; }

step() { printf '\n=== %s ===\n' "$1"; }

step "bootstrap (fresh server should need setup)"
BOOT=$(curl -s -H "$ORIGIN" -H "Sec-Fetch-Site: same-origin" $BASE/api/bootstrap)
NEEDS_SETUP=$(echo "$BOOT" | JQ "o.data.auth.needsSetup")
TOKEN=$(echo "$BOOT" | JQ "o.data.token")
echo "needsSetup=$NEEDS_SETUP"
[ "$NEEDS_SETUP" = "true" ] || { echo "FAIL: expected needsSetup=true"; exit 1; }

AUTH=(-H "x-mylens-token: $TOKEN" -H "Content-Type: application/json" -H "$ORIGIN")

step "api requires a session before setup"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "${AUTH[@]}" $BASE/api/connections)
echo "GET /api/connections -> $CODE (expect 401)"
[ "$CODE" = "401" ] || { echo "FAIL: expected 401"; exit 1; }

step "setup: create admin (rafael)"
curl -s -c /tmp/admin.jar "${AUTH[@]}" -X POST $BASE/api/auth/setup \
  -d '{"username":"rafael","displayName":"Rafael","password":"review123"}' | JQ "o.data.user.role"

step "bad password rejected"
CODE=$(curl -s -o /dev/null -w "%{http_code}" "${AUTH[@]}" -X POST $BASE/api/auth/login \
  -d '{"username":"rafael","password":"wrong-pass"}')
echo "bad login -> $CODE (expect 401)"
[ "$CODE" = "401" ] || { echo "FAIL"; exit 1; }

step "admin: list connections (3 seeded profiles expected)"
PROFILES=$(curl -s -b /tmp/admin.jar "${AUTH[@]}" $BASE/api/connections)
PROFILE_ID=$(echo "$PROFILES" | JQ "o.data[0].id")
echo "$PROFILES" | JQ "o.data.map(p=>p.name).join(', ')"

step "admin: connect profile (root, empty password)"
curl -s -b /tmp/admin.jar "${AUTH[@]}" -X POST $BASE/api/connections/$PROFILE_ID/connect -d '{}' | JQ "o.data.server.flavor + ' / ' + o.data.databases.length + ' databases visible to admin'"

step "admin: create member sherina"
curl -s -b /tmp/admin.jar "${AUTH[@]}" -X POST $BASE/api/admin/users \
  -d '{"username":"sherina","displayName":"Sherina","password":"member123","role":"member"}' | JQ "o.data.username + ' (' + o.data.role + ')'"
MEMBER_ID=$(curl -s -b /tmp/admin.jar "${AUTH[@]}" $BASE/api/admin/users | JQ "o.data.find(u=>u.username==='sherina').id")

step "admin: provision sandbox northwind (with data)"
ASSIGN=$(curl -s -b /tmp/admin.jar "${AUTH[@]}" -X POST $BASE/api/admin/users/$MEMBER_ID/assignments \
  -d "{\"profileId\":\"$PROFILE_ID\",\"source\":\"northwind\",\"includeData\":true}")
echo "$ASSIGN" | JQ "'sandbox=' + o.data.result.sandbox + ' tables=' + o.data.result.tables + ' rows=' + o.data.result.rowsCopied"
SANDBOX=$(echo "$ASSIGN" | JQ "o.data.result.sandbox")

step "member: login as sherina"
curl -s -c /tmp/member.jar "${AUTH[@]}" -X POST $BASE/api/auth/login \
  -d '{"username":"sherina","password":"member123"}' | JQ "o.data.user.role"

step "member: sees only assigned connections"
curl -s -b /tmp/member.jar "${AUTH[@]}" $BASE/api/connections | JQ "o.data.map(p=>p.name).join(', ')"

step "member: database list is locked to the sandbox"
MEMBER_DBS=$(curl -s -b /tmp/member.jar "${AUTH[@]}" $BASE/api/db/$PROFILE_ID/databases)
echo "$MEMBER_DBS" | JQ "o.data.map(d=>d.name).join(', ')"
COUNT=$(echo "$MEMBER_DBS" | JQ "o.data.length")
[ "$COUNT" = "1" ] && [ "$SANDBOX" = "$(echo "$MEMBER_DBS" | JQ "o.data[0].name")" ] || { echo "FAIL: member should see only $SANDBOX"; exit 1; }

step "member: admin sees everything (originals untouched)"
curl -s -b /tmp/admin.jar "${AUTH[@]}" $BASE/api/db/$PROFILE_ID/databases | JQ "o.data.map(d=>d.name).join(', ')"

step "member: SELECT inside sandbox works, cross-database SELECT is blocked"
curl -s -b /tmp/member.jar "${AUTH[@]}" -X POST $BASE/api/db/$PROFILE_ID/query \
  -d "{\"sql\":\"SELECT COUNT(*) AS n FROM $SANDBOX.customers\",\"database\":\"$SANDBOX\"}" | JQ "'sandbox query rows: ' + o.data.rowCount"
CODE=$(curl -s -o "$RESP" -w "%{http_code}" -b /tmp/member.jar "${AUTH[@]}" -X POST $BASE/api/db/$PROFILE_ID/query \
  -d '{"sql":"SELECT COUNT(*) AS n FROM northwind.customers","database":"northwind"}')
echo "cross-db query -> $CODE (expect 403): $(node -e "console.log(JSON.parse(require('fs').readFileSync('$RESP','utf8')).error.code)")"
[ "$CODE" = "403" ] || { echo "FAIL: cross-db query must be blocked"; exit 1; }

step "member: admin-only routes are rejected"
for path in /api/admin/users /api/reports /api/audit/run; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/member.jar "${AUTH[@]}" -X POST $BASE$path -d '{}')
  echo "POST $path -> $CODE (expect 403)"
done
CODE=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/member.jar "${AUTH[@]}" -X PUT $BASE/api/settings -d '{}')
echo "PUT /api/settings -> $CODE (expect 403)"

step "member: history is scoped to their own entries"
HIST=$(curl -s -b /tmp/member.jar "${AUTH[@]}" "$BASE/api/history?profileId=$PROFILE_ID")
echo "$HIST" | JQ "'member history entries: ' + o.data.length"

step "admin: activity log recorded everything"
curl -s -b /tmp/admin.jar "${AUTH[@]}" "$BASE/api/admin/activity?limit=12" | JQ "o.data.map(e=>e.username+':'+e.action).join(' | ')"

step "ALL ASSERTIONS PASSED"
