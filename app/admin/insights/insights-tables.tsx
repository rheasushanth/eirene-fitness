"use client";

import { useEffect, useState } from "react";

type Losing = {
  user_id: number;
  full_name: string;
  first_weight_kg: string;
  latest_weight_kg: string;
  change_kg: string;
};

type Active = {
  user_id: number;
  full_name: string;
  workouts_this_week: string;
  different_exercises: string;
  total_reps: string;
  total_volume_kg: string;
  last_workout: string;
};

type Span = { oldest: string | null; newest: string | null; week_start: string };

const correlatedSql = `SELECT u.user_id, u.full_name,
       (SELECT p.weight_kg FROM progress_logs p
         WHERE p.user_id = u.user_id
         ORDER BY p.logged_on ASC  LIMIT 1) AS first_weight_kg,
       (SELECT p.weight_kg FROM progress_logs p
         WHERE p.user_id = u.user_id
         ORDER BY p.logged_on DESC LIMIT 1) AS latest_weight_kg
  FROM users u
 WHERE (SELECT p.weight_kg FROM progress_logs p
         WHERE p.user_id = u.user_id
         ORDER BY p.logged_on DESC LIMIT 1)
     < (SELECT p.weight_kg FROM progress_logs p
         WHERE p.user_id = u.user_id
         ORDER BY p.logged_on ASC  LIMIT 1)
 ORDER BY change_kg ASC;`;

const havingSql = `SELECT u.user_id, u.full_name,
       COUNT(*) AS workouts_last_7_days,
       SUM(w.sets * w.reps * w.weight_kg) AS total_volume_kg
  FROM workout_logs w
  JOIN users u ON u.user_id = w.user_id
 WHERE w.logged_on > CURRENT_DATE - INTERVAL '7 days'
 GROUP BY u.user_id, u.full_name
HAVING COUNT(*) >= 3
 ORDER BY workouts_last_7_days DESC, total_volume_kg DESC;`;

function Sql({ children }: { children: string }) {
  return (
    <pre className="mb-4 overflow-x-auto rounded-md bg-zinc-100 p-3 text-xs leading-relaxed dark:bg-zinc-900">
      <code>{children}</code>
    </pre>
  );
}

export default function InsightsTables() {
  const [losing, setLosing] = useState<Losing[]>([]);
  const [active, setActive] = useState<Active[]>([]);
  const [span, setSpan] = useState<Span | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/insights")
      .then((r) => r.json())
      .then((d) => {
        setLosing(d.losingWeight ?? []);
        setActive(d.activeThisWeek ?? []);
        setSpan(d.span ?? null);
        setLoading(false);
      });
  }, []);

  if (loading) return <p className="text-sm text-zinc-500">Loading…</p>;

  const staleData = span?.newest != null && span.newest < span.week_start;

  return (
    <div className="space-y-12">
      <section>
        <h2 className="mb-1 font-medium">Users whose weight is down</h2>
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          Correlated subquery — each subquery references <code>u.user_id</code>{" "}
          from the outer query, so it runs once per user.
        </p>
        <Sql>{correlatedSql}</Sql>

        {losing.length === 0 ? (
          <p className="text-sm text-zinc-500">Nobody has lost weight yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm">
              <thead className="border-b border-zinc-200 text-left text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                <tr>
                  <th className="py-2 pr-4 font-medium">User</th>
                  <th className="py-2 pr-4 font-medium">First</th>
                  <th className="py-2 pr-4 font-medium">Latest</th>
                  <th className="py-2 font-medium">Change</th>
                </tr>
              </thead>
              <tbody>
                {losing.map((r) => (
                  <tr key={r.user_id} className="border-b border-zinc-100 dark:border-zinc-900">
                    <td className="py-2 pr-4">{r.full_name}</td>
                    <td className="py-2 pr-4 tabular-nums">{Number(r.first_weight_kg)} kg</td>
                    <td className="py-2 pr-4 tabular-nums">{Number(r.latest_weight_kg)} kg</td>
                    <td className="py-2 tabular-nums text-green-700 dark:text-green-400">
                      {Number(r.change_kg).toFixed(1)} kg
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-medium">Three or more workouts in the last 7 days</h2>
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          <code>WHERE</code> filters rows before grouping;{" "}
          <code>HAVING</code> filters the groups afterwards, which is the only
          place a <code>COUNT</code> can be tested.
        </p>
        <Sql>{havingSql}</Sql>

        {active.length === 0 ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            <p>Nobody has trained three times in the last seven days.</p>
            {staleData && (
              <p className="mt-1 text-xs">
                The newest workout is {span?.newest}, and the window starts{" "}
                {span?.week_start} — the seed data predates it. Re-run{" "}
                <code>seed.sql</code> to regenerate it relative to today.
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="border-b border-zinc-200 text-left text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                <tr>
                  <th className="py-2 pr-4 font-medium">User</th>
                  <th className="py-2 pr-4 font-medium">Workouts</th>
                  <th className="py-2 pr-4 font-medium">Exercises</th>
                  <th className="py-2 pr-4 font-medium">Reps</th>
                  <th className="py-2 pr-4 font-medium">Volume</th>
                  <th className="py-2 font-medium">Last</th>
                </tr>
              </thead>
              <tbody>
                {active.map((r) => (
                  <tr key={r.user_id} className="border-b border-zinc-100 dark:border-zinc-900">
                    <td className="py-2 pr-4">{r.full_name}</td>
                    <td className="py-2 pr-4 tabular-nums">{r.workouts_this_week}</td>
                    <td className="py-2 pr-4 tabular-nums">{r.different_exercises}</td>
                    <td className="py-2 pr-4 tabular-nums">{Number(r.total_reps).toLocaleString()}</td>
                    <td className="py-2 pr-4 tabular-nums">
                      {Number(r.total_volume_kg).toLocaleString()} kg
                    </td>
                    <td className="py-2 tabular-nums">{r.last_workout}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
