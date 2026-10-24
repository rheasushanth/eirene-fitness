import { redirect } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { getSession } from "@/lib/auth";
import { withUser } from "@/lib/db";
import NavBar from "@/app/nav-bar";

export const metadata: Metadata = { title: "Dashboard — Eirene" };

type Week = {
  week_start: string;
  workout_count: string;
  exercises_used: string;
  total_reps: string;
  total_volume_kg: string;
  avg_weight_kg: string | null;
};

type WeighIn = { logged_on: string; weight_kg: string; body_fat_pct: string | null };

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string }>;
}) {
  const session = await getSession();

  // proxy.ts already redirects signed-out visitors. This is the second check:
  // the page never renders user data on the strength of a redirect alone.
  if (!session) redirect("/login");

  const { denied } = await searchParams;

  // All three run as eirene_user with app.user_id set, so the row-level
  // security policies apply to the dashboard the same as to the API.
  const [weeks, weighIns, injuries, recent] = await withUser(session, (q) =>
    Promise.all([
      q<Week>(
      `SELECT week_start, workout_count, exercises_used,
              total_reps, total_volume_kg, avg_weight_kg
         FROM v_weekly_progress
        WHERE user_id = $1
        ORDER BY week_start DESC
        LIMIT 8`,
        [session.userId]
      ),
      q<WeighIn>(
      `SELECT logged_on, weight_kg, body_fat_pct
         FROM progress_logs
        WHERE user_id = $1
        ORDER BY logged_on DESC
        LIMIT 5`,
        [session.userId]
      ),
      q<{ name: string; severity: string }>(
      `SELECT i.name, ui.severity
         FROM user_injuries ui
         JOIN injuries i ON i.injury_id = ui.injury_id
        WHERE ui.user_id = $1
        ORDER BY i.name`,
        [session.userId]
      ),
      // The tiles use a rolling seven days rather than the calendar week the
      // table below is grouped by. A calendar week restarts at midnight on
      // Monday, so "this week" reads near zero every Monday morning even for
      // someone training daily. The table keeps calendar weeks, because
      // comparing one week against the next is what it is for.
      q<{ workout_count: string; total_volume_kg: string | null }>(
      `SELECT COUNT(*)                                   AS workout_count,
              COALESCE(SUM(sets * reps * weight_kg), 0)  AS total_volume_kg
         FROM workout_logs
        WHERE user_id = $1
          AND logged_on > CURRENT_DATE - INTERVAL '7 days'`,
        [session.userId]
      ),
    ])
  );

  const lastSeven = recent.rows[0];
  const peakVolume = weeks.rows.reduce(
    (max, w) => Math.max(max, Number(w.total_volume_kg)),
    0
  );

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
      <NavBar role={session.role} />

      <h1 className="mb-1 text-2xl font-semibold tracking-tight">
        Hello, {session.fullName}
      </h1>
      <p className="mb-8 text-sm text-zinc-600 dark:text-zinc-400">
        {session.email} · role <span className="font-medium">{session.role}</span>
      </p>

      {denied === "admin" && (
        <p
          role="alert"
          className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          That page is for administrators only.
        </p>
      )}

      <section className="mb-10 grid gap-4 sm:grid-cols-3">
        <Stat
          label="Workouts, last 7 days"
          value={lastSeven?.workout_count ?? "0"}
        />
        <Stat
          label="Volume, last 7 days"
          value={`${Number(lastSeven?.total_volume_kg ?? 0).toLocaleString()} kg`}
        />
        <Stat
          label="Injuries recorded"
          value={String(injuries.rows.length)}
          tone={injuries.rows.length > 0 ? "warn" : "plain"}
        />
      </section>

      <section className="mb-10">
        <h2 className="mb-3 font-medium">Weekly progress</h2>
        {weeks.rows.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No workouts logged yet.{" "}
            <Link href="/workouts" className="underline underline-offset-4">
              Log your first one
            </Link>
            .
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="border-b border-zinc-200 text-left text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                <tr>
                  <th className="py-2 pr-4 font-medium">Week of</th>
                  <th className="py-2 pr-4 font-medium">Workouts</th>
                  <th className="py-2 pr-4 font-medium">Exercises</th>
                  <th className="py-2 pr-4 font-medium">Reps</th>
                  <th className="py-2 pr-4 font-medium">Volume</th>
                  <th className="py-2 font-medium">Relative</th>
                </tr>
              </thead>
              <tbody>
                {weeks.rows.map((w) => {
                  const volume = Number(w.total_volume_kg);
                  const share = peakVolume > 0 ? (volume / peakVolume) * 100 : 0;
                  return (
                    <tr key={w.week_start} className="border-b border-zinc-100 dark:border-zinc-900">
                      <td className="py-2 pr-4 tabular-nums">{w.week_start}</td>
                      <td className="py-2 pr-4 tabular-nums">{w.workout_count}</td>
                      <td className="py-2 pr-4 tabular-nums">{w.exercises_used}</td>
                      <td className="py-2 pr-4 tabular-nums">{Number(w.total_reps).toLocaleString()}</td>
                      <td className="py-2 pr-4 tabular-nums">{volume.toLocaleString()} kg</td>
                      <td className="py-2">
                        {/* Bar relative to the user's own best week, so the
                            trend reads at a glance without a chart library. */}
                        <span className="flex h-2 w-24 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                          <span
                            className="h-full rounded-full bg-zinc-900 dark:bg-zinc-100"
                            style={{ width: `${share}%` }}
                          />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-zinc-500">
              Volume is sets × reps × weight, from the v_weekly_progress view.
            </p>
          </div>
        )}
      </section>

      <div className="grid gap-8 sm:grid-cols-2">
        <section>
          <h2 className="mb-3 font-medium">Recent weigh-ins</h2>
          {weighIns.rows.length === 0 ? (
            <p className="text-sm text-zinc-500">None recorded.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {weighIns.rows.map((w) => (
                <li key={w.logged_on} className="flex justify-between tabular-nums">
                  <span className="text-zinc-600 dark:text-zinc-400">{w.logged_on}</span>
                  <span>
                    {Number(w.weight_kg)} kg
                    {w.body_fat_pct && (
                      <span className="ml-2 text-zinc-500">{Number(w.body_fat_pct)}% bf</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-3 font-medium">Your injuries</h2>
          {injuries.rows.length === 0 ? (
            <p className="text-sm text-zinc-500">
              None recorded.{" "}
              <Link href="/profile" className="underline underline-offset-4">
                Add one
              </Link>
              .
            </p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {injuries.rows.map((i) => (
                <li key={i.name} className="flex justify-between">
                  <span>{i.name}</span>
                  <span className="text-zinc-500">{i.severity}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  tone = "plain",
}: {
  label: string;
  value: string;
  tone?: "plain" | "warn";
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        tone === "warn"
          ? "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
          : "border-zinc-200 dark:border-zinc-800"
      }`}
    >
      <p className="text-xs text-zinc-600 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
