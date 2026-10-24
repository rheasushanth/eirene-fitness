# Eirene — demo script

Everything to run, in order, with the commands ready to copy. Keep this open
in one window and the Neon SQL editor in another.

**Split:** R = Rhea (Training & Users), M = Manasa (Nutrition &
Recommendations). Whoever owns a feature demonstrates it, because the
modification task at the end usually lands on whoever just spoke.

---

## Part 0 — Setup, 30 minutes before

Do this even if everything worked yesterday. The seed generates dates
relative to the day it runs, so stale data makes "this week" read zero.

```bash
git checkout main && git pull && npm install
```

Rebuild both databases, in this order:

```bash
node --env-file=.env.local scripts/run-sql.mjs db/sql/schema.sql
node --env-file=.env.local scripts/run-sql.mjs db/sql/seed.sql
node --env-file=.env.local scripts/run-sql.mjs db/sql/triggers.sql
node --env-file=.env.local scripts/run-sql.mjs db/sql/procedures.sql
node --env-file=.env.local scripts/run-sql.mjs db/sql/views.sql
node --env-file=.env.local scripts/run-sql.mjs db/sql/security.sql
node --env-file=.env.local scripts/sync-neo4j.mjs
```

Then start the app and warm it up — Neon sleeps after a few minutes idle and
the first query is slow:

```bash
npm run dev
curl http://localhost:3000/api/health
```

`/api/health` should return `"status":"ok"` with both databases green. If
Neo4j is red, the recommendations demo will not work.

**Have open:** this file, the Neon SQL editor, Neo4j Browser, the app, and
`docs/er-diagram-chen.png` + `docs/relational-schema.png`.

**Log in as** `admin@eirene.test` in one browser window and
`meera@eirene.test` in a private window — Meera has both a lower back strain
and a peanut allergy, so she demonstrates both safety rules. Password for
every seeded account is `password123`.

---

## Part 1 — How many users (R)

**In the database:**

```sql
SELECT role, COUNT(*) AS users
FROM users
GROUP BY role
ORDER BY role;
```

```sql
SELECT user_id, full_name, email, role, height_cm, last_workout_on
FROM users
ORDER BY user_id;
```

**In the UI:** sign in as admin → **Insights**. Same data, read through the
application.

> Nine accounts: one admin and eight users. The admin page reads them through
> the same database, just with the role check in front.

---

## Part 2 — ER diagram and the relational schema (R)

Open `docs/er-diagram-chen.png` first, then `docs/relational-schema.png`.

> The first is the conceptual model in Chen notation — eight entities, ten
> relationships. The second is what it becomes as tables.

**The conversion rule, which is the likely question:**

> Each entity becomes a table. A one-to-many relationship becomes a foreign
> key on the many side — `users.goal_id` points at `goals`. A many-to-many
> relationship cannot be a foreign key, so it becomes its own table with a
> composite primary key. We have four of those: `user_injuries`,
> `exercise_injuries`, `user_allergies` and `food_ingredients`.
>
> So eight entities plus seven many-to-many relationships gives fifteen
> tables.

Point at `PROGRESS_LOG` — double rectangle, a weak entity:

> A weigh-in cannot exist without the user it belongs to, and `logged_on`
> only identifies it within one user — two people can weigh in on the same
> day. So it is identified by `USER` plus the date.

Point at the `PART_OF` loop on `INGREDIENT`:

> That is the point of the project. Satay sauce contains peanut butter, which
> contains peanut. A flat food-to-ingredient model misses it.

---

## Part 3 — DDL and constraints (R)

Show `db/sql/schema.sql`. The three DDL verbs are all in it:

```sql
-- CREATE
CREATE TABLE workout_logs ( ... );
-- ALTER — height_cm is collected after registration, not at signup
ALTER TABLE users ADD COLUMN IF NOT EXISTS height_cm INT;
ALTER TABLE users ADD CONSTRAINT chk_users_height
    CHECK (height_cm IS NULL OR height_cm BETWEEN 50 AND 260);
-- DROP — at the top, so the file can be re-run
DROP TABLE IF EXISTS workout_logs CASCADE;
```

**List the constraints from the catalog rather than the file:**

```sql
SELECT conrelid::regclass AS table_name,
       conname            AS constraint_name,
       CASE contype WHEN 'p' THEN 'PRIMARY KEY'
                    WHEN 'f' THEN 'FOREIGN KEY'
                    WHEN 'u' THEN 'UNIQUE'
                    WHEN 'c' THEN 'CHECK' END AS type
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
ORDER BY conrelid::regclass::text, contype;
```

**Then prove they work — run these and let them fail:**

```sql
-- role must be admin or user
INSERT INTO users (email, password_hash, full_name, role)
VALUES ('x@y.com', 'h', 'Test', 'superuser');

-- reps must be between 1 and 500
INSERT INTO workout_logs (user_id, exercise_id, sets, reps)
VALUES (2, 13, 3, 0);

-- a weigh-in cannot be in the future
INSERT INTO progress_logs (user_id, weight_kg, logged_on)
VALUES (2, 70, CURRENT_DATE + 1);

-- one weigh-in per user per day
INSERT INTO progress_logs (user_id, weight_kg, logged_on)
VALUES (2, 70, CURRENT_DATE);
```

> Every one is refused by the database, not by the application. The app could
> be bypassed; this cannot.

---

## Part 4 — Role-based access (R)

**Three layers. Show each.**

**1. The page.** As Meera, go to `/admin/exercises` → redirected to
`/dashboard?denied=admin`.

**2. The API, reached directly** — past the page:

```bash
curl -i http://localhost:3000/api/admin/exercises
# 401 signed out
```

**3. The database.** This is the strongest one. In the SQL editor:

```sql
-- as the application's owning role: everything
SELECT count(*) FROM workout_logs;

-- as a signed-in user: only their own rows
BEGIN;
  SET LOCAL ROLE eirene_user;
  SELECT set_config('app.user_id', '2', true);
  SELECT count(*) AS user_2_sees FROM workout_logs;
  SELECT DISTINCT user_id FROM workout_logs;
COMMIT;

BEGIN;
  SET LOCAL ROLE eirene_user;
  SELECT set_config('app.user_id', '3', true);
  SELECT count(*) AS user_3_sees FROM workout_logs;
COMMIT;

-- forgot to set the user: sees nothing, rather than everything
BEGIN;
  SET LOCAL ROLE eirene_user;
  SELECT count(*) AS no_user_set FROM workout_logs;
ROLLBACK;

-- a user cannot write a row owned by someone else
BEGIN;
  SET LOCAL ROLE eirene_user;
  SELECT set_config('app.user_id', '2', true);
  INSERT INTO workout_logs (user_id, exercise_id, sets, reps, weight_kg)
  VALUES (3, 13, 1, 1, 0);   -- refused by WITH CHECK
ROLLBACK;

-- a user cannot edit the catalog, an admin can
BEGIN;
  SET LOCAL ROLE eirene_user;
  SELECT set_config('app.user_id', '2', true);
  UPDATE exercises SET name = 'hacked' WHERE exercise_id = 1;  -- refused
ROLLBACK;
```

> Row-level security means the filtering is not a `WHERE` clause we remembered
> to write. The database refuses to return the rows at all.

---

## Part 5 — CRUD in the UI, mapped to the database (R exercises, M foods)

Keep the SQL editor beside the browser and run the query after each action.

**Create.** Admin → Exercises → add *Demo Squat Hold*, muscle group *Legs*,
tick **Knee Pain**. Then:

```sql
SELECT * FROM exercises ORDER BY exercise_id DESC LIMIT 1;
SELECT * FROM exercise_injuries WHERE exercise_id =
    (SELECT max(exercise_id) FROM exercises);
```

**Read.** The catalog table on the page is this query:

```sql
SELECT e.exercise_id, e.name, e.muscle_group, e.equipment, e.difficulty,
       array_agg(ei.injury_id) FILTER (WHERE ei.injury_id IS NOT NULL)
FROM exercises e
LEFT JOIN exercise_injuries ei ON ei.exercise_id = e.exercise_id
GROUP BY e.exercise_id
ORDER BY e.muscle_group, e.name;
```

**Update.** Edit it, untick Knee Pain, save. Re-run the `exercise_injuries`
query — the row is gone, because editing replaces the set rather than merging.

**Delete.** Delete *Demo Squat Hold* — it works, because nobody has logged it.
Then try deleting *Barbell Squat*:

> Refused. `workout_logs.exercise_id` has no `ON DELETE CASCADE` on purpose —
> removing something from the catalog should not erase everyone's training
> history. The foreign key refuses, and the page explains why.

---

## Part 6 — Search in the UI (R exercises, M foods)

Admin → Exercises → type in the search box. Try `squat`, then `Barbell`, then
`cardio`.

> The filtering is done by the database, not the browser. The clause is shown
> under the box: `WHERE name ILIKE '%squat%' OR muscle_group ILIKE … OR
> equipment ILIKE …`. The term is a bound parameter, so it cannot be used for
> SQL injection — try typing a quote and it just finds nothing.

`Barbell` is the good one: it matches on **equipment**, not the name, which
shows it is searching more than one column.

---

## Part 7 — Triggers, both timings (R)

**The app-specific rule:** a user with an injury cannot log an exercise that
strains it.

Show the two triggers exist:

```sql
SELECT tgname, CASE WHEN tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END AS timing
FROM pg_trigger
WHERE tgrelid = 'workout_logs'::regclass AND NOT tgisinternal;
```

**In the UI:** as Meera, Workouts → choose *Deadlift* (strains her lower
back) → the form warns before you submit → submit anyway → the error names
the injury.

**Then show it is the database, not the page.** In the SQL editor:

```sql
INSERT INTO workout_logs (user_id, exercise_id, sets, reps, weight_kg)
VALUES (3, 4, 3, 10, 60);
-- ERROR: Unsafe workout: Deadlift strains your recorded injury (Lower Back Strain)
-- SQLSTATE 23514
```

> The form and the API both check, but those can be bypassed. This is a
> direct insert with no application involved, and it is still refused.

**Now the AFTER trigger.** Note the audit count, log a safe workout, note it
again:

```sql
SELECT count(*) FROM workout_audit WHERE user_id = 3;

CALL log_workout(3, 13, 3, 12, 25);   -- Crunches: strains nothing

SELECT audit_id, log_id, user_id, exercise_id, volume_kg, recorded_by
FROM workout_audit ORDER BY audit_id DESC LIMIT 1;
```

**The line that answers the question:**

> `BEFORE` can refuse the insert, but `NEW.log_id` is empty — the serial has
> not been drawn yet. `AFTER` cannot refuse anything by then, but `log_id`
> exists, which is exactly what an audit row needs. And because BEFORE runs
> first, the audit only ever contains workouts that passed the safety check.

Prove that last part — the unsafe insert above left the audit count unchanged.

---

## Part 8 — Procedure and function (R procedure, M function)

**Procedure (R):**

```sql
CALL log_workout(3, 13, 4, 10, 30);
SELECT * FROM workout_logs WHERE user_id = 3 ORDER BY log_id DESC LIMIT 1;
SELECT last_workout_on FROM users WHERE user_id = 3;
```

> It does two things that must happen together: insert the log and move the
> streak date. Called inside a transaction, so if the trigger fires neither
> lands.

**Function (M):**

```sql
SELECT daily_calories(3, CURRENT_DATE)       AS today,
       daily_calories(3, CURRENT_DATE - 1)   AS yesterday;
```

> A procedure performs an action and is `CALL`ed. A function returns a value
> and is used inside a `SELECT`. That is the difference they usually ask for.

---

## Part 9 — Advanced queries (R: 1, 2 · M: 3, 4, 5)

All five are in `db/sql/queries.sql` with comments. Run each in the editor.

**1. Correlated subquery (R)** — users whose latest weight is below their
first. Each subquery references `u.user_id` from the outer query, so it runs
once per user.

**2. GROUP BY with HAVING (R)** — users with three or more workouts this week.

> `WHERE` filters rows before grouping; `HAVING` filters the groups after. The
> count cannot be tested in `WHERE` because the groups do not exist yet.

Both are also on **Admin → Insights**, with the SQL shown beside the results.

**3. Recursive CTE (M)** — every allergen reachable from a food through
nested ingredients. The output shows the path and the depth, so you can point
at `Satay Sauce -> Peanut Butter -> Peanut`.

**4. Nested subquery (M)** — foods nobody has logged. The inner query runs
once and does not reference the outer row, which is the difference from (1).

**5. JOIN with aggregates (M)** — average daily calories per goal.

---

## Part 10 — The NoSQL database (R exercises, M foods)

If they call it a vector database, correct it gently:

> The brief asked for SQL plus NoSQL. We used Neo4j, which is a graph
> database, because our core questions are about paths rather than values.

**Read** — in Neo4j Browser:

```cypher
// what the app runs for the safe exercise list
MATCH (e:Exercise)
WHERE NOT EXISTS {
  MATCH (u:User {id: 3})-[:HAS_INJURY]->(:Injury)<-[:STRAINS]-(e)
}
RETURN e.name ORDER BY e.name;

// the opposite, with the reason
MATCH (u:User {id: 3})-[:HAS_INJURY]->(i:Injury)<-[:STRAINS]-(e:Exercise)
RETURN e.name, collect(i.name) AS blocked_by;
```

**The hidden allergen — the best one to show (M):**

```cypher
MATCH (f:Food {name: 'Chicken Satay Skewers'})-[:CONTAINS*1..]->(i:Ingredient)
      -[:HAS_ALLERGEN]->(a:Allergen)
RETURN f.name, i.name AS found_in, a.name AS allergen;
```

> `CONTAINS*1..` follows the chain to any depth. The same question in SQL is
> the recursive CTE — about twenty lines. Both are in the project.

**Create / Update / Delete** — do this from the admin page so both databases
move together, then show the graph:

1. Admin → Exercises → add an exercise, tick an injury
2. In Neo4j Browser:
   ```cypher
   MATCH (e:Exercise)-[:STRAINS]->(i:Injury)
   WHERE e.name STARTS WITH 'Demo'
   RETURN e, i;
   ```
3. Edit it, untick the injury, re-run — the `STRAINS` edge is gone
4. Delete it, re-run — the node is gone

> PostgreSQL is the source of truth. Every write goes there first, then we
> mirror it to the graph. If they ever disagree, the sync script rebuilds the
> graph from PostgreSQL.

**Fail-closed (M)** — restart with a wrong `NEO4J_PASSWORD` and open
recommendations:

> It shows nothing and says the list is unavailable, rather than an unchecked
> list. Showing everything is how someone ends up squatting on an injured knee.

---

## Part 11 — Next.js and how the UI maps to the database

Likely questions and short answers.

**How is the app structured?**
> Next.js App Router. Each folder under `app/` is a route. `page.tsx` is a
> page, `route.ts` is an API endpoint. Pages that need data query the database
> on the server, so credentials never reach the browser.

**Where does the database connection live?**
> `lib/db.ts`. One connection pool, created on first use. Every query is
> parameterised — values go through `$1, $2`, never string concatenation.

**How do you know a request is from a signed-in user?**
> A signed JWT in an httpOnly cookie. `proxy.ts` checks it before the page
> loads. Next.js 16 renamed the `middleware.ts` convention to `proxy.ts`.

**How does the UI map to the database?** Pick the dashboard:
> The weekly table is `v_weekly_progress`. The three tiles are counts from
> the same view and `user_injuries`. The page runs those inside `withUser()`,
> which sets the database role and user id, so row-level security applies to
> the page exactly as it does to the API.

**Why no ORM?**
> Every query is visible SQL, which is the point of the module.

---

## Part 12 — Likely modification tasks (3 marks)

They will ask for a live change. Rehearse these — the pattern matters more
than the specific one.

**Add a column with a constraint**

```sql
ALTER TABLE exercises ADD COLUMN notes VARCHAR(200);
ALTER TABLE exercises ADD CONSTRAINT chk_exercises_notes
    CHECK (notes IS NULL OR length(trim(notes)) > 0);
-- prove it
INSERT INTO exercises (name, muscle_group, notes)
VALUES ('Test', 'Legs', '   ');   -- refused
```

**Add a CHECK to an existing column**

```sql
ALTER TABLE workout_logs ADD CONSTRAINT chk_sets_max_10 CHECK (sets <= 10);
INSERT INTO workout_logs (user_id, exercise_id, sets, reps)
VALUES (2, 13, 20, 10);           -- refused
ALTER TABLE workout_logs DROP CONSTRAINT chk_sets_max_10;
```

**Change the trigger rule** — say, only block severe injuries. In
`triggers.sql`, add to the `WHERE`:

```sql
AND ui.severity = 'severe'
```

then re-run the file and show a moderate injury no longer blocks.

**Add a query** — "users who have never logged a workout":

```sql
SELECT u.user_id, u.full_name
FROM users u
WHERE NOT EXISTS (SELECT 1 FROM workout_logs w WHERE w.user_id = u.user_id)
ORDER BY u.user_id;
```

**Add a node or edge in Neo4j**

```cypher
MERGE (e:Exercise {id: 999})
SET e.name = 'Demo Exercise', e.muscleGroup = 'Legs';

MATCH (e:Exercise {id: 999}), (i:Injury {name: 'Knee Pain'})
MERGE (e)-[:STRAINS]->(i);

MATCH (e:Exercise {id: 999}) DETACH DELETE e;
```

**Know where everything lives:**

| What | File |
| --- | --- |
| Tables, constraints, indexes | `db/sql/schema.sql` |
| Both triggers | `db/sql/triggers.sql` |
| Procedure and function | `db/sql/procedures.sql` |
| Three views | `db/sql/views.sql` |
| All five report queries | `db/sql/queries.sql` |
| Roles and row-level security | `db/sql/security.sql` |
| Graph constraints | `db/neo4j/constraints.cypher` |
| Connection pool and `withUser()` | `lib/db.ts` |
| Session and JWT | `lib/auth.ts` |
| Route protection | `proxy.ts` |
| Graph queries | `lib/graph-training.ts`, `lib/recommendations.ts` |

---

## Part 13 — Questions you should expect

**Why two databases?**
> The brief asked for SQL plus NoSQL, but they also suit different questions.
> PostgreSQL holds the data and enforces it — transactions, foreign keys,
> constraints. Neo4j answers path questions: is this safe for me, what worked
> for people like me. The hidden allergen is the clearest case — in Cypher it
> is `CONTAINS*1..`, one line, and it does not get longer as the nesting
> deepens.

**Couldn't you do all of it in SQL?**
> Yes, and we did — the recursive CTE is in `queries.sql`. It works, but it
> grows as the chain lengthens and the recommendation query would need several
> more joins. PostgreSQL stays the source of truth either way.

**What if the two disagree?**
> PostgreSQL wins. Every write goes there first and is mirrored afterwards, so
> a graph failure never costs a saved workout. `sync-neo4j.mjs` rebuilds the
> graph from PostgreSQL.

**Why is the safety rule a trigger and not application code?**
> Because application code can be bypassed. We demonstrate that with a direct
> insert.

**How do you stop one user reading another's data?**
> Row-level security, which we show live. Not a `WHERE` clause we have to
> remember to write.

**What was hardest?**
> Row-level security. Two faults only showed up when we tested the database
> directly: a view runs with its owner's privileges by default and the owner
> is exempt from the policies, so `v_weekly_progress` was returning every
> user's rows — fixed with `security_invoker`. And on a pooled connection the
> session setting resets to an empty string rather than NULL, so the policy
> raised an error instead of returning nothing — fixed with `NULLIF`. Both
> looked fine from the interface, because each user only ever asks for their
> own data.

---

## Part 14 — Afterwards

Undo anything created during the demo so the repository and the data match
what was submitted:

```sql
DELETE FROM workout_audit WHERE exercise_id > 25;
DELETE FROM workout_logs  WHERE exercise_id > 25;
DELETE FROM exercises     WHERE exercise_id > 25;
```

```cypher
MATCH (e:Exercise) WHERE e.id > 25 DETACH DELETE e;
```

Or just re-run `seed.sql` and the sync script.
