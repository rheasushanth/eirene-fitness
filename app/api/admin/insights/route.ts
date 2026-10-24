import { NextResponse } from "next/server";
import { withUser } from "@/lib/db";
import { getSession } from "@/lib/auth";

// GET /api/admin/insights — the two reporting queries from queries.sql,
// run across all users. Admin-only, because they read other people's rows.
//
// These run as eirene_admin inside withUser(). The per-user policies apply to
// that role too, so security.sql adds a second, SELECT-only policy granted
// TO eirene_admin that widens its reads to every row. Policies are OR'd, so
// eirene_user stays exactly as restricted as before.
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (session.role !== "admin") {
    return NextResponse.json({ error: "Administrators only" }, { status: 403 });
  }

  // Correlated subquery: each subquery references u.user_id from the outer
  // query, so it is evaluated once per user.
  const losingWeight = `
    SELECT u.user_id, u.full_name,
           (SELECT p.weight_kg FROM progress_logs p
             WHERE p.user_id = u.user_id ORDER BY p.logged_on ASC  LIMIT 1) AS first_weight_kg,
           (SELECT p.weight_kg FROM progress_logs p
             WHERE p.user_id = u.user_id ORDER BY p.logged_on DESC LIMIT 1) AS latest_weight_kg,
           (SELECT p.weight_kg FROM progress_logs p
             WHERE p.user_id = u.user_id ORDER BY p.logged_on DESC LIMIT 1)
         - (SELECT p.weight_kg FROM progress_logs p
             WHERE p.user_id = u.user_id ORDER BY p.logged_on ASC  LIMIT 1) AS change_kg
      FROM users u
     WHERE (SELECT p.weight_kg FROM progress_logs p
             WHERE p.user_id = u.user_id ORDER BY p.logged_on DESC LIMIT 1)
         < (SELECT p.weight_kg FROM progress_logs p
             WHERE p.user_id = u.user_id ORDER BY p.logged_on ASC  LIMIT 1)
     ORDER BY change_kg ASC`;

  // GROUP BY with HAVING: WHERE filters rows before grouping, HAVING filters
  // the groups after, which is the only place a COUNT can be tested.
  const activeThisWeek = `
    SELECT u.user_id, u.full_name,
           COUNT(*)                           AS workouts_this_week,  -- last 7 days
           COUNT(DISTINCT w.exercise_id)      AS different_exercises,
           SUM(w.sets * w.reps)               AS total_reps,
           SUM(w.sets * w.reps * w.weight_kg) AS total_volume_kg,
           MAX(w.logged_on)                   AS last_workout
      FROM workout_logs w
      JOIN users u ON u.user_id = w.user_id
     WHERE w.logged_on > CURRENT_DATE - INTERVAL '7 days'
     GROUP BY u.user_id, u.full_name
    HAVING COUNT(*) >= 3
     ORDER BY workouts_this_week DESC, total_volume_kg DESC`;

  const data = await withUser(session, async (q) => {
    const [losing, active, span] = await Promise.all([
      q(losingWeight),
      q(activeThisWeek),
      // Shown alongside the empty state: if the newest log predates the
      // window, "nobody trained three times" is about the data, not the query.
      q(`SELECT MIN(logged_on) AS oldest, MAX(logged_on) AS newest,
                (CURRENT_DATE - INTERVAL '7 days')::date AS week_start
           FROM workout_logs`),
    ]);
    return {
      losingWeight: losing.rows,
      activeThisWeek: active.rows,
      span: span.rows[0],
    };
  });

  return NextResponse.json(data);
}
