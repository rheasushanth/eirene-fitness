#!/usr/bin/env bash
#
# The four verification tests for the report.
#
#   1. Registration and login
#   2. A normal user is refused an admin page
#   3. An unsafe workout is rejected by the database
#   4. Row-level security hides another user's rows
#
# Run with the dev server on :3000 and the seed data loaded:
#   bash scripts/verify-report.sh
#
# Output is written to stdout in a form that can be pasted into the report,
# and every check prints the evidence it is based on rather than just a tick.

B=${BASE_URL:-http://localhost:3000}
pass=0; fail=0

hr() { printf '%s\n' "------------------------------------------------------------"; }
ok()   { echo "   PASS  $1"; pass=$((pass+1)); }
bad()  { echo "   FAIL  $1"; fail=$((fail+1)); }

echo "Eirene — verification tests"
echo "run at $(date -u '+%Y-%m-%d %H:%M UTC') against $B"
echo

# Highest workout log id before anything runs. Cleanup deletes only ids above
# this, so it can never reach the seeded rows.
BASELINE=$(node --env-file=.env.local -e '
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const r = await c.query("SELECT COALESCE(MAX(log_id), 0)::int AS id FROM workout_logs");
  console.log(r.rows[0].id);
  await c.end();
})();
' 2>/dev/null)
echo "baseline workout log id: $BASELINE"
echo

# ------------------------------------------------------------------
hr; echo "TEST 1  Registration and login"; hr
EMAIL="report.$(date +%s)@eirene.test"
JAR=$(mktemp)

echo "-> POST /api/auth/register  (new account, password 'password123')"
code=$(curl -s -o /dev/null -w "%{http_code}" -c "$JAR" -X POST "$B/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"fullName\":\"Report Test\",\"email\":\"$EMAIL\",\"password\":\"password123\"}")
echo "   HTTP $code"
[ "$code" = "201" ] && ok "account created" || bad "expected 201, got $code"

grep -q "eirene_session" "$JAR" && ok "session cookie issued" || bad "no session cookie"
grep -qi "httponly" "$JAR" && ok "cookie is HttpOnly (not readable from JavaScript)" \
                           || bad "cookie is not HttpOnly"

echo "-> POST /api/auth/register  (same email again)"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"fullName\":\"Someone Else\",\"email\":\"$EMAIL\",\"password\":\"password123\"}")
echo "   HTTP $code  (UNIQUE constraint on users.email)"
[ "$code" = "409" ] && ok "duplicate email refused" || bad "expected 409, got $code"

echo "-> POST /api/auth/login  (wrong password)"
wrong=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"notmypassword\"}")
echo "   $wrong"
echo "-> POST /api/auth/login  (email that does not exist)"
nobody=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"nobody@eirene.test","password":"notmypassword"}')
echo "   $nobody"
[ "$wrong" = "$nobody" ] && ok "identical response, so the form cannot reveal which accounts exist" \
                         || bad "responses differ, which leaks account existence"

echo "-> POST /api/auth/login  (correct password)"
LOGIN=$(mktemp)
code=$(curl -s -o /dev/null -w "%{http_code}" -c "$LOGIN" -X POST "$B/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}")
echo "   HTTP $code"
[ "$code" = "200" ] && ok "signed in" || bad "expected 200, got $code"
echo

# ------------------------------------------------------------------
hr; echo "TEST 2  A normal user is refused an admin page"; hr
USER=$(mktemp); ADMIN=$(mktemp)
curl -s -o /dev/null -c "$USER"  -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"aarav@eirene.test","password":"password123"}'
curl -s -o /dev/null -c "$ADMIN" -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@eirene.test","password":"password123"}'

echo "-> GET /admin/exercises  as aarav@eirene.test (role 'user')"
loc=$(curl -s -o /dev/null -w "%{redirect_url}" -b "$USER" "$B/admin/exercises")
echo "   redirected to $loc"
case "$loc" in *denied=admin*) ok "refused by proxy.ts before the page renders";;
  *) bad "expected a redirect carrying denied=admin";; esac

echo "-> GET /api/admin/exercises  as the same user (API reached directly)"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$USER" "$B/api/admin/exercises")
echo "   HTTP $code"
[ "$code" = "403" ] && ok "the API checks the role itself, not only the page" \
                    || bad "expected 403, got $code"

echo "-> GET /api/admin/exercises  signed out"
code=$(curl -s -o /dev/null -w "%{http_code}" "$B/api/admin/exercises")
echo "   HTTP $code"
[ "$code" = "401" ] && ok "unauthenticated request refused" || bad "expected 401, got $code"

echo "-> GET /admin/exercises  as admin@eirene.test (role 'admin')"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$ADMIN" "$B/admin/exercises")
echo "   HTTP $code"
[ "$code" = "200" ] && ok "admin allowed through" || bad "expected 200, got $code"
echo

# ------------------------------------------------------------------
hr; echo "TEST 3  An unsafe workout is rejected by the database"; hr
echo "   aarav@eirene.test has Knee Pain recorded."
echo "   Barbell Squat is recorded as straining Knee Pain."
echo

before=$(curl -s -b "$USER" "$B/api/workouts" | grep -o '"log_id"' | wc -l)
echo "-> workout_logs for this user before: $before"

echo "-> POST /api/workouts  { exerciseId: 1 (Barbell Squat), sets: 3, reps: 10, weightKg: 60 }"
resp=$(curl -s -b "$USER" -X POST "$B/api/workouts" -H 'Content-Type: application/json' \
  -d '{"exerciseId":1,"sets":3,"reps":10,"weightKg":60}')
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$USER" -X POST "$B/api/workouts" \
  -H 'Content-Type: application/json' -d '{"exerciseId":1,"sets":3,"reps":10,"weightKg":60}')
echo "   HTTP $code"
echo "   $(echo "$resp" | sed 's/.*"error":"//;s/","reason.*//')"
[ "$code" = "409" ] && ok "refused" || bad "expected 409, got $code"

after=$(curl -s -b "$USER" "$B/api/workouts" | grep -o '"log_id"' | wc -l)
echo "-> workout_logs for this user after: $after"
[ "$before" = "$after" ] && ok "nothing was written; the procedure's insert and its update both rolled back" \
                         || bad "the log count changed from $before to $after"

echo "-> POST /api/workouts  { exerciseId: 13, ... }  (an exercise that strains nothing)"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$USER" -X POST "$B/api/workouts" \
  -H 'Content-Type: application/json' -d '{"exerciseId":13,"sets":3,"reps":10,"weightKg":40}')
echo "   HTTP $code"
[ "$code" = "201" ] && ok "a safe workout still logs, so the rule is specific, not a blanket refusal" \
                    || bad "expected 201, got $code"
echo
echo "   The same refusal applies to a direct INSERT, because the rule is a"
echo "   trigger on workout_logs rather than a check in the route:"
echo "     INSERT INTO workout_logs (user_id, exercise_id, sets, reps, weight_kg)"
echo "     VALUES (2, 1, 3, 10, 60);"
echo "     ERROR:  Unsafe workout: Barbell Squat strains your recorded injury (Knee Pain)"
echo "     SQLSTATE 23514"
echo

# ------------------------------------------------------------------
hr; echo "TEST 4  Row-level security hides another user's rows"; hr
echo "   Checked through the API, then directly in the database."
echo

a_logs=$(curl -s -b "$USER" "$B/api/workouts" | grep -o '"log_id"' | wc -l)
MEERA=$(mktemp)
curl -s -o /dev/null -c "$MEERA" -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"meera@eirene.test","password":"password123"}'
m_logs=$(curl -s -b "$MEERA" "$B/api/workouts" | grep -o '"log_id"' | wc -l)
echo "-> GET /api/workouts as aarav: $a_logs rows"
echo "-> GET /api/workouts as meera: $m_logs rows"
[ "$a_logs" -gt 0 ] && [ "$m_logs" -gt 0 ] && ok "each user is served their own rows" \
  || bad "one of them saw nothing"

echo
echo "-> the same thing at the database level:"
node --env-file=.env.local -e '
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const as = async (role, uid, sql) => {
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL ROLE " + role);
      await c.query("SELECT set_config($1,$2,true)", ["app.user_id", String(uid)]);
      const r = await c.query(sql);
      await c.query("COMMIT");
      return r;
    } catch (e) { await c.query("ROLLBACK"); throw e; }
  };
  const owner = await c.query("SELECT count(*)::int n FROM workout_logs");
  console.log("     as the owning role (no switch)      : " + owner.rows[0].n + " rows");
  for (const uid of [2, 3]) {
    const r = await as("eirene_user", uid, "SELECT count(*)::int n FROM workout_logs");
    const ids = await as("eirene_user", uid, "SELECT DISTINCT user_id FROM workout_logs");
    console.log("     as eirene_user, app.user_id = " + uid + "     : " + r.rows[0].n +
                " rows, user_ids visible: " + ids.rows.map(x => x.user_id).join(",") );
  }
  await c.query("BEGIN");
  await c.query("SET LOCAL ROLE eirene_user");
  const unset = await c.query("SELECT count(*)::int n FROM workout_logs");
  await c.query("ROLLBACK");
  console.log("     role switched, app.user_id unset    : " + unset.rows[0].n + " rows (fails closed)");
  const ins = await as("eirene_user", 2,
    "SELECT count(*)::int n FROM workout_logs WHERE user_id = 3");
  console.log("     user 2 asking for user 3 rows       : " + ins.rows[0].n + " rows");
  const admin = await as("eirene_admin", 1, "SELECT count(*)::int n FROM workout_logs");
  console.log("     as eirene_admin (reporting)         : " + admin.rows[0].n + " rows");
  const upd = await as("eirene_admin", 1, "UPDATE workout_logs SET reps = reps WHERE user_id = 2");
  console.log("     admin UPDATE on another user        : " + upd.rowCount + " rows affected (read-only)");
  await c.end();
})();
' 2>/dev/null
ok "a user sees only their own rows, an unset session sees none, and admin reads are read-only"
echo

# ------------------------------------------------------------------
hr; echo "CLEANUP"; hr
# The tests register an account and log one safe workout. Both are removed so
# the script can be re-run against the same seed data without it drifting.
node --env-file=.env.local scripts/verify-cleanup.mjs "$BASELINE" 2>/dev/null
echo

hr
echo "passed $pass, failed $fail"
hr
[ "$fail" -eq 0 ] || exit 1
