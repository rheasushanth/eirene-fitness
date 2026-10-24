// Removes the rows verify-report.sh creates, so it can be re-run against the
// same seed data without the counts drifting.
//
// Scoped by id, not by time. An earlier version deleted anything inserted in
// the last ten minutes, which also matched the seed whenever seed.sql had
// been run recently — it emptied workout_logs more than once. The script now
// takes the highest log id that existed before the tests ran and deletes only
// what came after it.
//
// Run with:
//   node --env-file=.env.local scripts/verify-cleanup.mjs <baseline_log_id>

import { Client } from "pg";

const baseline = Number(process.argv[2]);

if (!Number.isInteger(baseline) || baseline < 0) {
  console.error(
    "   cleanup skipped: needs the baseline log id captured before the tests ran"
  );
  process.exit(1);
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  // Audit rows first: they reference the logs, and the table is append-only
  // so nothing else will tidy them.
  const audit = await client.query("DELETE FROM workout_audit WHERE log_id > $1", [
    baseline,
  ]);
  const logs = await client.query("DELETE FROM workout_logs WHERE log_id > $1", [
    baseline,
  ]);
  const users = await client.query("DELETE FROM users WHERE email LIKE $1", [
    "report.%@eirene.test",
  ]);

  const left = await client.query(
    `SELECT (SELECT count(*)::int FROM workout_logs)  AS workout_logs,
            (SELECT count(*)::int FROM workout_audit) AS workout_audit,
            (SELECT count(*)::int FROM users)         AS users,
            (SELECT count(*)::int FROM progress_logs) AS progress_logs`
  );

  const l = left.rows[0];
  console.log(
    `   removed ${logs.rowCount} test log(s), ${audit.rowCount} audit row(s), ${users.rowCount} test account(s)`
  );
  console.log(
    `   seed data: ${l.workout_logs} workout_logs, ${l.workout_audit} audit, ${l.users} users, ${l.progress_logs} progress_logs`
  );
} finally {
  await client.end();
}
