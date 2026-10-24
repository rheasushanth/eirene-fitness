# Eirene — Project Report

**DBMS Experiential Learning, Level 3 Project**

A safety-aware fitness and diet recommender built with Next.js, PostgreSQL and
Neo4j (Option 1: SQL + NoSQL).

| | |
| --- | --- |
| Team | Rhea Sushanth (Training & Users), Manasa K Yadav (Nutrition & Recommendations) |
| Repository | https://github.com/rheasushanth/eirene-fitness |
| Stack | Next.js 16 (App Router, TypeScript), PostgreSQL on Neon, Neo4j AuraDB |

## Contents

1. Introduction and objectives
2. Functional requirements
3. Database design
4. Database choice and justification
5. System architecture
6. Data dictionary
7. Authentication and roles
8. The workout module
9. Nutrition SQL
10. Training SQL
11. The Neo4j model
12. Recommendation logic
13. Application screenshots
14. Test results
15. Conclusion
16. Individual contributions

---

## 1. Introduction and objectives

### 1.1 The problem

Generic fitness apps suggest workouts and meals without checking a person's
injuries or allergies. That can cause real harm: squats for someone with a knee
injury, or a satay dish for someone allergic to peanuts, where the peanut is
not a listed ingredient of the dish but sits inside the sauce, inside the
peanut butter.

### 1.2 What Eirene does

Eirene stores users, workouts, meals and progress, and checks every suggestion
against what it knows about the user:

- excludes exercises that strain one of the user's injuries;
- excludes foods that contain one of the user's allergens, including allergens
  hidden inside nested ingredients;
- recommends exercises and foods that worked for users with the same goal,
  with the unsafe ones already removed;
- shows progress over time (weekly training volume, weight, daily calories).

### 1.3 Objectives

1. Design a normalised relational schema for users, the exercise and food
   catalogs, and the logs, with the safety rules enforced by constraints and a
   trigger in the database rather than only in the application.
2. Model the same entities as a graph in Neo4j, where the safety checks and the
   "similar users" recommendations are short path queries.
3. Keep the two databases consistent, with PostgreSQL as the source of truth,
   and fail closed: if the graph cannot answer, show nothing rather than an
   unchecked list.
4. Enforce two roles, Admin and User, in the application and in the database
   (GRANT/REVOKE and row-level security).
5. Provide a Next.js interface that exercises all of the above: forms, tables,
   filters, a dashboard and admin pages.

### 1.4 Why it is more than CRUD

The core of the app is not storing rows but answering questions about them:
"does any chain of ingredients in this food reach one of my allergens?", "does
this exercise strain any injury I have?", "what did people with my goal do?".
Answering those needs a recursive CTE, a trigger, a procedure, a function,
views, row-level security and graph traversal.

---

## 2. Functional requirements

### 2.1 Roles

| Role | Can | Cannot |
| --- | --- | --- |
| Admin | Add, edit and delete exercises and foods, with the injuries an exercise strains and the ingredients a food contains; view reports across all users | Edit another user's logs (admin reads of user data are `SELECT` only) |
| User | Manage their own profile, goal, injuries and allergies; log workouts, meals and weigh-ins; see safe lists and recommendations | Edit the catalog, or see any other user's data |

### 2.2 Requirements

| # | Requirement | Where |
| --- | --- | --- |
| FR1 | Register, sign in and sign out; passwords stored only as bcrypt hashes | `/register`, `/login`, `/api/auth/*` |
| FR2 | Every page and API route checks the session; `/admin/*` requires the admin role | `proxy.ts`, each route handler |
| FR3 | A user records their goal, injuries and allergies | `/profile`, `/api/injuries`, `/api/profile/goal`, `/api/profile/allergies` |
| FR4 | A user logs a workout, one exercise at a time; an exercise that strains one of their injuries is refused by the database | `/workouts`, `/api/workouts`, trigger on `workout_logs` |
| FR5 | The workout form offers only exercises that are safe for the user | `/api/exercises/safe` (Neo4j) |
| FR6 | A user logs meals; the food list offers only foods with none of their allergens at any depth, and an unsafe food is refused on insert | `/meals`, `/api/meals`, `/api/foods/safe`, `v_safe_foods` |
| FR7 | The meals page shows calories eaten today and the foods hidden because of an allergen, with the allergen behind each | `daily_calories()`, Neo4j |
| FR8 | A user logs their weight and sees weekly progress | `/dashboard`, `/api/progress`, `v_weekly_progress` |
| FR9 | A user sees recommended exercises and foods, chosen by users with the same goal, with unsafe items removed and the reason shown | `/recommendations`, `/api/recommendations` |
| FR10 | An admin manages the exercise catalog and which injuries each exercise strains | `/admin/exercises`, `/api/admin/exercises` |
| FR11 | An admin manages the food catalog and which ingredients each food contains | `/admin/foods`, `/api/admin/foods` |
| FR12 | An admin sees reports across users (who is losing weight, who trained three or more times this week) | `/admin/insights`, `/api/admin/insights` |
| FR13 | Every change is written to PostgreSQL first, then mirrored to Neo4j | `lib/graph-sync.ts`, `lib/graph-training.ts` |
| FR14 | If Neo4j is unavailable, safe lists and recommendations return 503 and show nothing | `/api/foods/safe`, `/api/exercises/safe`, `/api/recommendations` |
| FR15 | The health check reports whether each database is reachable | `/api/health` |

### 2.3 Non-functional requirements

- Database credentials live only in `.env.local`, never in the source code.
- Input is validated in the database (NOT NULL, UNIQUE, CHECK, foreign keys),
  not only in forms.
- Every SQL statement is plain SQL through the `pg` package, with no ORM, so
  each query is visible.

---

## 3. Database design

### 3.1 ER diagram

![ER diagram](er-diagram-chen.png)

The source is `docs/er-diagram.dbml` (dbdiagram.io); `scripts/make-chen-er.mjs`
draws the Chen-notation version above, also available as
`docs/er-diagram-chen.svg`.

### 3.2 Relational schema

![Relational schema](relational-schema.png)

Fifteen tables, created by `db/sql/schema.sql`:

| Area | Tables |
| --- | --- |
| Accounts | `users` |
| Training catalog | `injuries`, `exercises`, `exercise_injuries` |
| Nutrition catalog | `goals`, `allergens`, `ingredients`, `ingredient_parts`, `foods`, `food_ingredients` |
| Per-user facts | `user_injuries`, `user_allergies` |
| Logs | `workout_logs`, `meal_logs`, `progress_logs` |

Link tables (`exercise_injuries`, `user_injuries`, `user_allergies`,
`food_ingredients`, `ingredient_parts`) use composite primary keys, so the same
pair cannot be recorded twice. Rows a user owns cascade when the account is
deleted; rows that point at the catalog from a log do not, so deleting a food
or exercise cannot erase someone's history. Column-level detail is in the data
dictionary (section 6).

### 3.3 SQL files

| File | Contents |
| --- | --- |
| `schema.sql` | DROP, CREATE TABLE with keys and constraints, one ALTER, indexes |
| `seed.sql` | 1 admin and 8 users, 5 injuries, 25 exercises, 6 allergens, 30 ingredients, 25 foods, a week of logs |
| `triggers.sql` | the unsafe-workout trigger |
| `procedures.sql` | `log_workout` procedure, `daily_calories` function |
| `views.sql` | `v_weekly_progress`, `v_food_allergens`, `v_safe_foods` |
| `security.sql` | roles, GRANT/REVOKE, row-level security policies |
| `queries.sql` | the five report queries |

---

## 4. Database choice and justification

Eirene uses two databases, and each holds the data it suits.

| Database | Holds | Why |
| --- | --- | --- |
| PostgreSQL (Neon) | Every account, log and catalog row: users, goals, injuries, allergens, exercises, ingredients, foods, and the workout, meal and progress logs | The data has a fixed shape and must be correct: foreign keys, CHECK constraints, transactions and row-level security keep it that way. Reports (calories per goal, weekly volume) are JOINs and aggregates, which SQL does well. PostgreSQL was chosen over MySQL for recursive CTEs, `security_invoker` views and row-level security. |
| Neo4j (AuraDB) | The same entities as nodes, and the relationships between them as edges | The two questions the app exists to answer are path questions: "does this food reach one of my allergens through any chain of ingredients?" and "what did people like me do?". In Cypher each is one pattern; in SQL each needs a recursive CTE or several self-joins. |

**PostgreSQL is the source of truth.** Every change is written to PostgreSQL
first and committed; only then is the graph updated. If the two ever disagree,
`scripts/sync-neo4j.mjs` rebuilds the graph from PostgreSQL.

**Safety rule: fail closed.** If Neo4j cannot answer, the app shows no list
rather than an unfiltered one. An unchecked food list is exactly how a peanut
allergy meets a satay sauce.

---

## 5. System architecture

```
 Browser (Next.js pages: meals, recommendations, profile, admin foods)
    │  fetch / server components
    ▼
 proxy.ts ── signed in? admin for /admin/*?
    │
    ▼
 Next.js route handlers (app/api/*)          session from the httpOnly JWT cookie
    │                                   │
    │ 1. withUser(): BEGIN,              │ 2. after COMMIT
    │    SET LOCAL ROLE eirene_user,     │
    │    app.user_id, queries, COMMIT    │
    ▼                                   ▼
 PostgreSQL (Neon)                     Neo4j (AuraDB)
 source of truth                        relationships for the safety
 tables, trigger, procedure,            filter and recommendations
 function, views, RLS                   (lib/recommendations.ts,
    │                                     lib/graph-sync.ts)
    └──── scripts/sync-neo4j.mjs rebuilds the graph from PostgreSQL ────┘
```

Credentials live only in `.env.local` (`DATABASE_URL`, `NEO4J_URI`,
`NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`, `JWT_SECRET`), which git
ignores; `.env.example` lists the names with empty values.

---

## 6. Data dictionary

Types are PostgreSQL types. PK = primary key, FK = foreign key.

### Training & Users

**users** — accounts

| Column | Type | Constraints |
| --- | --- | --- |
| user_id | SERIAL | PK |
| email | VARCHAR(255) | NOT NULL, UNIQUE, must contain `@` |
| password_hash | VARCHAR(255) | NOT NULL (bcrypt) |
| full_name | VARCHAR(120) | NOT NULL, not blank |
| role | VARCHAR(10) | NOT NULL, default `user`, `admin` or `user` |
| goal_id | INT | FK → goals, ON DELETE SET NULL |
| last_workout_on | DATE | set by `log_workout` |
| height_cm | INT | added by ALTER, NULL or 50–260 |
| created_at | TIMESTAMPTZ | NOT NULL, default now() |

**injuries** — catalog: injury_id SERIAL PK; name VARCHAR(80) NOT NULL UNIQUE;
body_part VARCHAR(60) NOT NULL; description TEXT.

**user_injuries** — user_id FK → users CASCADE; injury_id FK → injuries
CASCADE; severity mild/moderate/severe; noted_on DATE not in the future;
PK (user_id, injury_id).

**exercises** — catalog: exercise_id SERIAL PK; name VARCHAR(120) NOT NULL
UNIQUE; muscle_group NOT NULL; equipment; difficulty
beginner/intermediate/advanced.

**exercise_injuries** — exercise_id FK CASCADE; injury_id FK CASCADE;
PK (exercise_id, injury_id). Read by the safety trigger.

**workout_logs** — log_id SERIAL PK; user_id FK CASCADE; exercise_id FK (no
cascade); sets 1–50; reps 1–500; weight_kg 0–500; logged_on not in the future.

**progress_logs** — progress_id SERIAL PK; user_id FK CASCADE; weight_kg
20–400; body_fat_pct 1–70; UNIQUE (user_id, logged_on).

### Nutrition & Recommendations

**goals** — catalog of goals

| Column | Type | Constraints |
| --- | --- | --- |
| goal_id | SERIAL | PK |
| name | VARCHAR(60) | NOT NULL, UNIQUE |
| description | TEXT | |

**allergens** — catalog of allergens

| Column | Type | Constraints |
| --- | --- | --- |
| allergen_id | SERIAL | PK |
| name | VARCHAR(60) | NOT NULL, UNIQUE |

**user_allergies** — which allergens a user has

| Column | Type | Constraints |
| --- | --- | --- |
| user_id | INT | PK part, FK → users ON DELETE CASCADE |
| allergen_id | INT | PK part, FK → allergens ON DELETE CASCADE |
| severity | VARCHAR(10) | NOT NULL, default `moderate`, mild/moderate/severe |
| noted_on | DATE | NOT NULL, default today, not in the future |

**ingredients** — catalog of ingredients

| Column | Type | Constraints |
| --- | --- | --- |
| ingredient_id | SERIAL | PK |
| name | VARCHAR(120) | NOT NULL, UNIQUE |
| allergen_id | INT | FK → allergens ON DELETE SET NULL; set only when the ingredient is itself an allergen |

**ingredient_parts** — an ingredient made of other ingredients

| Column | Type | Constraints |
| --- | --- | --- |
| parent_id | INT | PK part, FK → ingredients ON DELETE CASCADE |
| child_id | INT | PK part, FK → ingredients ON DELETE CASCADE |
| note | VARCHAR(120) | |
| | | CHECK parent_id <> child_id |

**foods** — catalog of foods, nutrition per serving

| Column | Type | Constraints |
| --- | --- | --- |
| food_id | SERIAL | PK |
| name | VARCHAR(120) | NOT NULL, UNIQUE |
| calories | NUMERIC(7,2) | NOT NULL, ≥ 0 |
| protein_g, carbs_g, fat_g | NUMERIC(6,2) | each ≥ 0 when given |

**food_ingredients** — what a food is made of

| Column | Type | Constraints |
| --- | --- | --- |
| food_id | INT | PK part, FK → foods ON DELETE CASCADE |
| ingredient_id | INT | PK part, FK → ingredients ON DELETE CASCADE |
| quantity_g | NUMERIC(7,2) | > 0 when given |

**meal_logs** — one row per food eaten

| Column | Type | Constraints |
| --- | --- | --- |
| meal_log_id | SERIAL | PK |
| user_id | INT | NOT NULL, FK → users ON DELETE CASCADE |
| food_id | INT | NOT NULL, FK → foods, **no** cascade (history is kept) |
| servings | NUMERIC(5,2) | NOT NULL, default 1, > 0 and ≤ 20 |
| meal_type | VARCHAR(12) | breakfast/lunch/dinner/snack |
| logged_on | DATE | NOT NULL, default today, not in the future |
| created_at | TIMESTAMPTZ | NOT NULL, default now() |

Indexes on the nutrition side: `meal_logs (user_id, logged_on)` for the meals
page and `daily_calories`; `ingredients (allergen_id)` for the allergy filter;
`food_ingredients (ingredient_id)` for walking from an ingredient to its
foods.

### Views and functions

| Object | Kind | Returns |
| --- | --- | --- |
| `daily_calories(p_user, p_day)` | SQL function | total calories × servings for one user on one day |
| `v_food_allergens` | view (recursive CTE) | food_id, food_name, allergen_id, allergen_name, depth, via |
| `v_safe_foods` | view | user_id, food_id, food_name, calories for every food with none of the user's allergens |
| `v_weekly_progress` | view | weekly training volume per user |

All views are `WITH (security_invoker = true)`, so row-level security applies
to whoever queries them.

---

## 7. Authentication and roles

### 7.1 Storing an account

An account is one row in `users`: `email`, `password_hash`, `full_name` and
`role`. The password itself is never stored. Registration hashes it with
bcrypt at cost 10, which is slow enough to make guessing expensive and fast
enough that signing in does not feel sluggish.

Two constraints do work that would otherwise be left to application code:

```sql
email VARCHAR(255) NOT NULL UNIQUE,
role  VARCHAR(10)  NOT NULL DEFAULT 'user',
CONSTRAINT chk_users_role CHECK (role IN ('admin', 'user'))
```

The `UNIQUE` on `email` is what rejects a duplicate registration. The route
does not `SELECT` first to check whether the address is taken, because two
requests arriving at the same moment would both find nothing and both insert.
Instead the `INSERT` is attempted and the resulting `23505 unique_violation`
is translated into a 409 response. The database arbitrates, so the race
cannot happen.

The `CHECK` on `role` means an invalid role cannot exist even if a bug
elsewhere tried to write one. Registration always writes `'user'`; `'admin'`
is granted in the database and never from anything a browser sends.

### 7.2 Signing in

Login looks the user up by email and compares the supplied password against
the stored hash. When the email is unknown, the comparison still runs,
against a fixed dummy hash:

```ts
const matches = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
if (!user || !matches) {
  return NextResponse.json({ error: "Email or password is incorrect" }, { status: 401 });
}
```

Two decisions here. The message is the same for a wrong password and an
unknown address, so the form cannot be used to discover which accounts exist.
And the dummy comparison keeps the two paths taking a similar amount of time,
since skipping the hash entirely for an unknown email would make the response
measurably faster and give the same information away through timing.

### 7.3 The session

A successful sign-in returns a JSON Web Token signed with HS256, carrying the
user id and role, set as a cookie:

```ts
httpOnly: true,                                // not readable from JavaScript
sameSite: "lax",                               // not sent on cross-site POSTs
secure: process.env.NODE_ENV === "production", // HTTPS only once deployed
maxAge: 60 * 60 * 24 * 7,
```

`httpOnly` means a cross-site scripting bug cannot read the session.
`sameSite: "lax"` means another site cannot cause the browser to send it on a
form submission, which blocks basic cross-site request forgery.

Carrying the role inside the signed token means route protection can check it
without a database round trip on every request. The token is signed, so a user
editing the cookie to say `"role":"admin"` invalidates the signature and the
session is rejected outright.

### 7.4 Route protection

Next.js 16 deprecated the `middleware.ts` file convention and renamed it to
`proxy.ts`. The behaviour and the matcher configuration are unchanged.

`proxy.ts` runs before every matched request and makes the coarse decision:

- no valid session on a protected path redirects to `/login`, carrying the
  original path as `?next=` so the user returns there after signing in;
- a path under `/admin` with a non-admin session redirects to
  `/dashboard?denied=admin`;
- a signed-in user visiting `/login` or `/register` is sent to the dashboard.

API routes are excluded from the matcher deliberately. A redirect is the right
answer for a page and the wrong answer for a `fetch`, which needs a status
code and JSON. Each API route therefore checks the session itself and returns
401 or 403.

### 7.5 Three layers, not one

Access is checked at three levels, and each one assumes the others may be
bypassed:

| Layer | Mechanism | What it stops |
| --- | --- | --- |
| Request | `proxy.ts` | Opening a page you have no business opening |
| Route | `getSession()` and an explicit role check | Calling the API directly, past the page |
| Database | Roles, `GRANT`/`REVOKE`, row-level security | A query that reaches the database at all |

The admin pages re-check the session rather than trusting that the redirect
happened, and the admin API re-checks the role rather than trusting the page.

### 7.6 Database roles and row-level security

`security.sql` creates two roles, neither of which can log in directly:

```sql
CREATE ROLE eirene_user  NOLOGIN;
CREATE ROLE eirene_admin NOLOGIN;
```

All privileges are revoked and then granted back deliberately, so a table
added later is unreachable until someone decides what it should allow. Both
roles may read the catalog tables; only `eirene_admin` may write them.

Row-level security is enabled on the six tables holding per-user data, each
with a policy comparing the row's owner against a session setting:

```sql
CREATE POLICY p_workout_logs_own ON workout_logs
    FOR ALL
    USING      (user_id = NULLIF(current_setting('app.user_id', true), '')::int)
    WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::int);
```

`USING` controls which rows a statement can see or change. `WITH CHECK`
controls which rows it may write. Both are needed: with only `USING`, a user
could insert a row carrying someone else's `user_id` and then be unable to see
what they had just created.

The application supplies the setting through `withUser()`:

```ts
await client.query("BEGIN");
await client.query("SET LOCAL ROLE eirene_user");
await client.query("SELECT set_config('app.user_id', $1, true)", [String(userId)]);
```

Both `SET LOCAL` and the `true` argument to `set_config` are
transaction-scoped, so they are undone at `COMMIT` and a pooled connection
carries nothing into the next request.

### 7.7 Why the policies are not FORCEd

PostgreSQL exempts a table's owner from its own policies unless the table is
also given `FORCE ROW LEVEL SECURITY`. The owner here is the role the
application connects as, and that is deliberate: registration and login must
read and write `users` before any user id exists, and `seed.sql` inserts rows
for every user at once. Neither can run under a policy keyed on
`app.user_id`.

The consequence is worth stating plainly: a query that skips `withUser()` runs
as the owner and is not filtered. The routes are written so that the only
queries outside it are registration, login and the health check.

### 7.8 Administrators

The per-user policies apply to `eirene_admin` as well, which meant an admin
reporting across users initially saw only their own rows. A second policy,
granted to that role and limited to `SELECT`, widens its reads:

```sql
CREATE POLICY p_workout_logs_admin_read ON workout_logs
    FOR SELECT TO eirene_admin USING (true);
```

Policies are permissive and combined with `OR`, so this widens `eirene_admin`
without touching `eirene_user`. It is `SELECT` only on purpose: administrators
report on user data, they do not edit someone else's workout log. Testing
confirms an admin `UPDATE` against another user's rows affects none.

---

## 8. The workout module

### 8.1 What it stores

Five tables carry the training side:

| Table | Holds |
| --- | --- |
| `injuries` | The catalog of injuries, admin-maintained |
| `exercises` | The catalog of exercises, admin-maintained |
| `exercise_injuries` | Which exercise strains which injury |
| `user_injuries` | Which injuries a user currently has |
| `workout_logs` | One row per exercise performed |

`exercise_injuries` and `user_injuries` are the two halves of the safety rule.
An exercise is unsafe for a user when a row exists in each that shares an
`injury_id`. Both use composite primary keys, so the same pair cannot be
recorded twice.

### 8.2 Deletion behaviour is not uniform

Everything a user owns cascades when the account is deleted — their logs,
their weigh-ins, their recorded injuries. But `workout_logs.exercise_id`
deliberately has no `ON DELETE CASCADE`. Removing an exercise from the catalog
should not silently erase the training history of everyone who ever did it.
The foreign key refuses the delete instead, and the admin page turns that
refusal into an explanation.

### 8.3 The safety trigger

The rule that an injured user cannot log an exercise that strains the injury
lives in the database, as a `BEFORE INSERT` trigger on `workout_logs`:

```sql
SELECT string_agg(i.name, ', ' ORDER BY i.name)
  INTO v_injuries
  FROM user_injuries ui
  JOIN exercise_injuries ei ON ei.injury_id = ui.injury_id
  JOIN injuries i           ON i.injury_id  = ui.injury_id
 WHERE ui.user_id     = NEW.user_id
   AND ei.exercise_id = NEW.exercise_id;

IF v_injuries IS NOT NULL THEN
    RAISE EXCEPTION 'Unsafe workout: % strains your recorded injury (%)',
        v_exercise, v_injuries
        USING ERRCODE = 'check_violation';
END IF;
```

Three choices are worth defending.

**Why the database and not the route.** The form already hides unsafe
exercises, and the API could check before inserting. Both of those can be
bypassed — the API by a direct HTTP request, the application entirely by a
`psql` session. A trigger cannot be gone around: every path into the table
goes through it. The checks in the user interface are a convenience; this is
the boundary.

**Why `BEFORE` and not `AFTER`.** A `BEFORE` trigger prevents the write.
An `AFTER` trigger would insert the row and rely on the rollback to undo it,
which works but consumes a value from the serial sequence each time, leaving
visible gaps in the ids.

**Why `string_agg` rather than `EXISTS`.** An `EXISTS` test would be simpler
but could only report that something was wrong. Collecting the names means the
error says exactly which injuries are involved, and that message is passed
through to the user unchanged.

### 8.4 The procedure

`log_workout` does the two things that must happen together:

```sql
INSERT INTO workout_logs (user_id, exercise_id, sets, reps, weight_kg, logged_on)
VALUES (p_user_id, p_exercise_id, p_sets, p_reps, p_weight_kg, p_logged_on);

UPDATE users
   SET last_workout_on = p_logged_on
 WHERE user_id = p_user_id
   AND (last_workout_on IS NULL OR last_workout_on < p_logged_on);
```

The guard on the `UPDATE` means back-filling a session from last week cannot
drag a more recent date backwards.

The route calls it inside a transaction. If the trigger fires, both statements
roll back together: no log row, and `last_workout_on` untouched. Tested
directly — after a refused workout the user's log count is unchanged and the
streak date is unmoved.

### 8.5 The view

`v_weekly_progress` aggregates each user's logs into weeks:

```sql
SELECT w.user_id,
       date_trunc('week', w.logged_on)::date      AS week_start,
       COUNT(*)                                   AS workout_count,
       SUM(w.sets * w.reps * w.weight_kg)         AS total_volume_kg
FROM workout_logs w
GROUP BY w.user_id, date_trunc('week', w.logged_on);
```

Volume — sets times reps times weight — is the standard measure of training
load, and is more informative than a count of sessions. Weeks are keyed on
their Monday so they sort correctly and line up with the reporting query.

The view is declared `WITH (security_invoker = true)`. This matters more than
it looks: a view otherwise executes with its *owner's* privileges, and the
owner is exempt from row-level security. Without that clause the view returned
every user's weeks while `workout_logs` underneath was correctly protected —
a leak invisible from the interface, since each user only ever requested their
own. Section 14.4 covers how it was found.

### 8.6 Keeping the graph in step

PostgreSQL is the source of truth. After a workout commits, the application
records the same fact in Neo4j as a weighted edge:

```cypher
MATCH (u:User {id: $userId}), (e:Exercise {id: $exerciseId})
MERGE (u)-[r:DID]->(e)
ON CREATE SET r.count = 1
ON MATCH  SET r.count = coalesce(r.count, 0) + 1
```

The ordering is deliberate. The graph write happens after the commit, and a
failure there is logged but does not fail the request. A workout that was
validated and saved must not be undone because a second database was briefly
unreachable, and the sync script can repair a missing edge later.

The same applies to injuries: adding or removing one writes or deletes the
`HAS_INJURY` edge, so the graph's answer changes as soon as the profile does.

### 8.7 The safe-exercise query

The question "which exercises are safe for me" is a question about the absence
of a path:

```cypher
MATCH (e:Exercise)
WHERE NOT EXISTS {
  MATCH (u:User {id: $userId})-[:HAS_INJURY]->(:Injury)<-[:STRAINS]-(e)
}
RETURN e.id, e.name, e.muscleGroup
```

In SQL the same question needs a `NOT EXISTS` over a two-table join, and grows
more awkward as the chain lengthens. In Cypher the pattern is written the way
it is drawn.

The endpoint fails closed. If Neo4j cannot answer, the response is 503 and the
page says the list is unavailable, rather than falling back to showing
everything. An unfiltered list is precisely how someone ends up squatting on
an injured knee, so no list is the safer failure.

The two databases were checked against each other: the SQL flag and the graph
query independently identify the same six unsafe exercises for the seeded
knee-injury user.

---

## 9. Nutrition SQL

### 9.1 Function: `daily_calories`

```sql
CREATE OR REPLACE FUNCTION daily_calories(p_user INT, p_day DATE)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$
    SELECT COALESCE(SUM(f.calories * m.servings), 0)
    FROM meal_logs m
    JOIN foods f ON f.food_id = m.food_id
    WHERE m.user_id = p_user AND m.logged_on = p_day;
$$;
```

`STABLE` tells the planner it only reads. It runs as the caller, so row-level
security still decides which meal rows it can see: one user cannot read
another's total by passing their id. `COALESCE` turns "no meals today" into 0
rather than NULL. The meals page shows its result as "Calories today".

### 9.2 Recursive CTE: every allergen in a food

```sql
WITH RECURSIVE parts (ingredient_id, depth, path) AS (
    SELECT fi.ingredient_id, 1, i.name::text
      FROM food_ingredients fi
      JOIN ingredients i ON i.ingredient_id = fi.ingredient_id
     WHERE fi.food_id = 1
    UNION ALL
    SELECT ip.child_id, p.depth + 1, p.path || ' -> ' || c.name
      FROM parts p
      JOIN ingredient_parts ip ON ip.parent_id = p.ingredient_id
      JOIN ingredients c       ON c.ingredient_id = ip.child_id
     WHERE p.depth < 10
)
SELECT a.name AS allergen, p.depth, p.path
  FROM parts p
  JOIN ingredients i ON i.ingredient_id = p.ingredient_id
  JOIN allergens a   ON a.allergen_id   = i.allergen_id
 ORDER BY a.name, p.depth;
```

The anchor takes the food's direct ingredients; the recursive step adds
whatever each of those is made of, until nothing new is found. For Chicken
Satay Skewers:

| allergen | depth | path |
| --- | --- | --- |
| Gluten | 3 | Satay Sauce -> Soy Sauce -> Wheat |
| Peanut | 3 | Satay Sauce -> Peanut Butter -> Peanut |
| Soy | 3 | Satay Sauce -> Soy Sauce -> Soybean |

None of the three allergens is a direct ingredient of the dish. The `depth <
10` guard stops a cycle in bad data (A contains B contains A) from recursing
for ever; the CHECK on `ingredient_parts` only blocks the one-step case.

`v_food_allergens` is the same walk for every food at once, and `v_safe_foods`
pairs each user with the foods that have none of their allergens.

### 9.3 Nested subquery: foods nobody has logged

```sql
SELECT f.food_id, f.name, f.calories
  FROM foods f
 WHERE f.food_id NOT IN (SELECT m.food_id FROM meal_logs m)
 ORDER BY f.name;
```

The inner query runs once, independent of the outer row. `NOT IN` is safe
because `meal_logs.food_id` is NOT NULL; a single NULL in the inner result
would otherwise make the whole condition unknown and return nothing. With the
seed data it returns 8 foods, including all three peanut dishes the seeded
peanut-allergic user could never log.

### 9.4 JOIN with aggregates: average daily calories per goal

```sql
SELECT g.goal_id, g.name AS goal,
       COUNT(DISTINCT d.user_id)     AS users_logging,
       COUNT(d.day)                  AS user_days,
       ROUND(AVG(d.day_calories), 0) AS avg_daily_calories,
       ROUND(MIN(d.day_calories), 0) AS lowest_day,
       ROUND(MAX(d.day_calories), 0) AS highest_day
FROM goals g
LEFT JOIN users u ON u.goal_id = g.goal_id
LEFT JOIN (
    SELECT m.user_id, m.logged_on AS day, SUM(f.calories * m.servings) AS day_calories
      FROM meal_logs m
      JOIN foods f ON f.food_id = m.food_id
     GROUP BY m.user_id, m.logged_on
) d ON d.user_id = u.user_id
GROUP BY g.goal_id, g.name
ORDER BY avg_daily_calories DESC NULLS LAST;
```

Two levels of aggregation: the derived table totals each user's calories per
day, and the outer query averages those days per goal. Averaging the raw meal
rows instead would weight a goal by how many snacks its users log, not by what
they eat in a day. The `LEFT JOIN`s keep a goal nobody has chosen in the
result, with zero users.

---

## 10. Training SQL

### 10.1 Correlated subquery — who is losing weight

```sql
SELECT u.user_id, u.full_name,
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
 ORDER BY change_kg ASC;
```

The subqueries are correlated because each references `u.user_id` from the
outer query, so each is evaluated once per user rather than once for the whole
table.

Ordering by `logged_on` and taking one row is deliberate, rather than using
`MIN` and `MAX` of the weight. The question is which reading came *first and
last in time*, not which was smallest and largest — a user who lost weight and
then regained some should still show their actual latest figure.

Result against the seed data: five users, Rohan Mehta down 1.3 kg, Aarav
Sharma 1.1 kg, Meera Iyer 0.9 kg, Vikram Das 0.5 kg, Sana Khan 0.1 kg.

### 10.2 GROUP BY with HAVING — who trained three or more times this week

```sql
SELECT u.user_id, u.full_name,
       COUNT(*)                           AS workouts_this_week,
       SUM(w.sets * w.reps * w.weight_kg) AS total_volume_kg
  FROM workout_logs w
  JOIN users u ON u.user_id = w.user_id
 WHERE w.logged_on >= date_trunc('week', CURRENT_DATE)::date
 GROUP BY u.user_id, u.full_name
HAVING COUNT(*) >= 3
 ORDER BY workouts_this_week DESC, total_volume_kg DESC;
```

The distinction between `WHERE` and `HAVING` is the point of the query.
`WHERE` filters individual rows before grouping — here, restricting to this
week's logs. `HAVING` filters the groups afterwards. The count of three cannot
be tested in `WHERE`, because at that stage the groups do not yet exist.

Both queries are shown on `/admin/insights` with their SQL beside the results,
so they are visible in the running application rather than only in a file.

### 10.3 Constraints as logic

The schema refuses bad data rather than trusting the application to screen it:

```sql
CONSTRAINT chk_workout_logs_reps   CHECK (reps BETWEEN 1 AND 500),
CONSTRAINT chk_workout_logs_date   CHECK (logged_on <= CURRENT_DATE),
CONSTRAINT chk_progress_logs_weight CHECK (weight_kg BETWEEN 20 AND 400),
CONSTRAINT uq_progress_logs_per_day UNIQUE (user_id, logged_on)
```

The `UNIQUE` on `(user_id, logged_on)` enforces one weigh-in per user per day,
which keeps the dashboard's trend line to a single point per date. Rather than
rejecting a second entry, the route upserts, so logging again the same day
corrects the earlier figure.

`height_cm` is added by `ALTER TABLE` rather than declared inline, because it
is collected after registration rather than at signup — the `ALTER` reflects
how the column came to exist.

Eight invalid-value cases were tested and all are refused by the database:
an invalid role, a malformed email, a duplicate email, zero reps, an
impossible weight, an out-of-range height, a future date and an invalid
severity.

---

## 11. The Neo4j model

### 11.1 Nodes

Every node carries an `id` equal to the primary key of its PostgreSQL row, so
an id means the same thing in both databases.

| Label | From table | Properties |
| --- | --- | --- |
| `User` | users | id, name, role |
| `Goal` | goals | id, name |
| `Injury` | injuries | id, name, bodyPart |
| `Allergen` | allergens | id, name |
| `Exercise` | exercises | id, name, muscleGroup |
| `Ingredient` | ingredients | id, name |
| `Food` | foods | id, name, calories |

### 11.2 Relationships

| Edge | From table | Meaning |
| --- | --- | --- |
| `(User)-[:HAS_GOAL]->(Goal)` | users.goal_id | the user's goal, at most one |
| `(User)-[:HAS_INJURY {severity}]->(Injury)` | user_injuries | |
| `(User)-[:ALLERGIC_TO {severity}]->(Allergen)` | user_allergies | |
| `(Exercise)-[:STRAINS]->(Injury)` | exercise_injuries | doing this aggravates that injury |
| `(Food)-[:CONTAINS {quantityG}]->(Ingredient)` | food_ingredients | direct ingredients |
| `(Ingredient)-[:CONTAINS]->(Ingredient)` | ingredient_parts | nested ingredients: Satay Sauce → Peanut Butter → Peanut |
| `(Ingredient)-[:HAS_ALLERGEN]->(Allergen)` | ingredients.allergen_id | only on ingredients that are an allergen themselves |
| `(User)-[:DID {count}]->(Exercise)` | workout_logs | how many times the user logged it |
| `(User)-[:ATE {count}]->(Food)` | meal_logs | how many times the user logged it |

Using the same `CONTAINS` type for food→ingredient and ingredient→ingredient
is deliberate: it lets one variable-length pattern, `CONTAINS*1..`, follow a
food all the way down without caring where the food ends and the nesting
begins.

### 11.3 Constraints and indexes

`db/neo4j/constraints.cypher` creates a uniqueness constraint on `id` for each
of the seven labels (which also gives each an index for lookups by id) and an
index on `name` for `Food` and `Exercise`. Every statement uses
`IF NOT EXISTS`, so the sync script applies them on every run.

### 11.4 Keeping the graph in step

Each route writes PostgreSQL first, then the graph:

| Change | PostgreSQL | Graph | If the graph write fails |
| --- | --- | --- | --- |
| Log a meal | INSERT meal_logs | MERGE `ATE`, count + 1 | logged, the meal is kept (it only feeds recommendations) |
| Add / remove an allergy | INSERT / DELETE user_allergies | MERGE / DELETE `ALLERGIC_TO` | 503: "saved, but the food filter could not be updated" |
| Change goal | UPDATE users.goal_id | replace `HAS_GOAL` | 503: "saved, but recommendations could not be updated" |
| Admin adds / edits / deletes a food | foods, food_ingredients | MERGE `Food`, replace `CONTAINS`, or DETACH DELETE | warning shown to the admin, re-run the sync script |

The user node is `MERGE`d, not `MATCH`ed, in these writes. An account created
through `/register` after the sync script last ran has no node yet; a `MATCH`
would write nothing, and the graph would treat that user as able to eat
anything.

An allergy or goal failure is reported as 503 rather than logged quietly
because, unlike a meal, it changes what the user is shown. The user is told
the change was saved and can retry.

### 11.5 The safe-food query

```cypher
MATCH (f:Food)
WHERE NOT EXISTS {
  MATCH (f)-[:CONTAINS*1..]->(:Ingredient)-[:HAS_ALLERGEN]->(a:Allergen)
        <-[:ALLERGIC_TO]-(:User {id: $userId})
}
RETURN f.id, f.name, f.calories
ORDER BY f.name
```

A food is unsafe if there is any path, of any length, from the food through
its ingredients to an allergen the user is allergic to. `CONTAINS*1..` finds
the peanut in Chicken Satay Skewers three levels down without knowing in
advance how deep it sits. The matching query without `NOT` lists the hidden
foods together with the allergens behind each, which the meals page shows.

**Defence in depth.** The meals page and `GET /api/foods/safe` take this list
from Neo4j and then keep only the foods that `v_safe_foods` in PostgreSQL also
allows. The two only disagree if the graph has fallen behind, and then the
stricter answer wins. `POST /api/meals` re-checks the food against
`v_safe_foods` inside the same transaction as the insert, so even a
hand-crafted request cannot log an unsafe food.

---

## 12. Recommendation logic

The plan's rule is "recommend what worked for users with similar goals". There
is no separate plans table: what people actually logged, the `DID` and `ATE`
edges, is the evidence.

```cypher
MATCH (me:User {id: $userId})-[:HAS_GOAL]->(:Goal)<-[:HAS_GOAL]-(other:User)
WHERE other <> me
MATCH (other)-[:ATE]->(f:Food)
WHERE NOT EXISTS {
  MATCH (f)-[:CONTAINS*1..]->(:Ingredient)-[:HAS_ALLERGEN]->(:Allergen)<-[:ALLERGIC_TO]-(me)
}
WITH me, f, count(DISTINCT other) AS users
RETURN f.id, f.name, f.calories, users,
       EXISTS { MATCH (me)-[:ATE]->(f) } AS eatenByMe
ORDER BY users DESC, f.name
LIMIT 5
```

Step by step:

1. **Similar users** are the others who share my `HAS_GOAL` edge.
2. **Candidates** are the foods they `ATE` (and, in the twin query, the
   exercises they `DID`).
3. **Safety filter.** Foods with a `CONTAINS*1..` path to one of my allergens
   are removed, as are exercises that `STRAIN` one of my injuries. The filter
   runs inside the same query, so an unsafe item cannot reach the page however
   popular it is.
4. **Ranking.** `count(DISTINCT other)` counts people, not log entries, so one
   enthusiastic user cannot outvote three others. Ties are broken by name so
   the order is stable.
5. **Reason.** The count is shown on each item: "Chosen by 2 users with your
   goal (Fat Loss)". Items the user has already done or eaten are marked.

A user with no goal is asked to set one. If Neo4j is down, `GET
/api/recommendations` returns 503 and the page says recommendations are
unavailable; there is no fallback, because the safety filter lives in the same
query.

---

## 13. Application screenshots

Screenshots are in `docs/screenshots/`.

> To add: take each screenshot against the live Neon and AuraDB databases and
> save it under the file name below; the images then appear here.

| # | Screen | File |
| --- | --- | --- |
| 1 | Login page | `screenshots/login.png` |
| 2 | Dashboard with weekly progress | `screenshots/dashboard.png` |
| 3 | Workouts page with an unsafe exercise refused | `screenshots/workout-refused.png` |
| 4 | Profile: goal, injuries and allergies | `screenshots/profile.png` |
| 5 | Meals page as Meera: no peanut dishes, hidden foods listed | `screenshots/meals-no-peanut.png` |
| 6 | Admin foods: satay sauce with its hidden peanut allergen | `screenshots/admin-foods-satay.png` |
| 7 | Recommendations page with "Chosen by N users with your goal" | `screenshots/recommendations.png` |
| 8 | Meals or recommendations page with Neo4j unavailable | `screenshots/neo4j-unavailable.png` |
| 9 | Admin insights with both report queries | `screenshots/admin-insights.png` |
| 10 | A normal user refused an admin page | `screenshots/admin-denied.png` |

![Login](screenshots/login.png)
![Dashboard](screenshots/dashboard.png)
![Unsafe workout refused](screenshots/workout-refused.png)
![Profile](screenshots/profile.png)
![Meals without peanut dishes](screenshots/meals-no-peanut.png)
![Admin foods: hidden allergen in satay sauce](screenshots/admin-foods-satay.png)
![Recommendations](screenshots/recommendations.png)
![Neo4j unavailable](screenshots/neo4j-unavailable.png)
![Admin insights](screenshots/admin-insights.png)
![Admin page refused](screenshots/admin-denied.png)

---

## 14. Test results

All tests are reproducible. `scripts/verify-report.sh` produces the output in
`docs/test-results.txt`; `scripts/test-auth.sh`, `scripts/test-workouts.sh`
and `scripts/test-admin-and-safety.sh` cover the modules in more detail. Each
prints the evidence behind a result rather than only a verdict, and the
verification script removes the rows it creates so it can be re-run against
unchanged seed data.

### 14.1 Registration and login

| Check | Result |
| --- | --- |
| Register a new account | 201, session cookie set, `HttpOnly` |
| Register the same email again | 409, from the `UNIQUE` constraint |
| Login, wrong password | 401 `{"error":"Email or password is incorrect"}` |
| Login, email that does not exist | 401, **byte-identical response** |
| Login, correct password | 200 |

The identical responses are the point of the fourth row: the form cannot be
used to find out which addresses are registered.

### 14.2 A normal user is refused an admin page

| Check | Result |
| --- | --- |
| `GET /admin/exercises` as a user | redirect to `/dashboard?denied=admin` |
| `GET /api/admin/exercises` as a user | 403 |
| `GET /api/admin/exercises` signed out | 401 |
| `GET /admin/exercises` as admin | 200 |

The second row matters most: it shows the API enforces the role itself rather
than relying on the page having been blocked.

### 14.3 An unsafe workout is rejected

Aarav Sharma has Knee Pain recorded; Barbell Squat strains Knee Pain.

```
-> workout_logs for this user before: 7
-> POST /api/workouts { exerciseId: 1, sets: 3, reps: 10, weightKg: 60 }
   HTTP 409
   Unsafe workout: Barbell Squat strains your recorded injury (Knee Pain)
-> workout_logs for this user after: 7
-> POST /api/workouts { exerciseId: 13, ... }   (strains nothing)
   HTTP 201
```

The log count is unchanged, confirming that the procedure's insert and its
update of `last_workout_on` rolled back together. The safe exercise still logs,
so the rule is specific rather than a blanket refusal.

The same refusal applies to a direct insert, because the rule is a trigger:

```
INSERT INTO workout_logs (user_id, exercise_id, sets, reps, weight_kg)
VALUES (2, 1, 3, 10, 60);
ERROR:  Unsafe workout: Barbell Squat strains your recorded injury (Knee Pain)
SQLSTATE 23514
```

A further test removes the injury from the profile, logs the same exercise
successfully, restores the injury, and sees it refused again — showing the
rule is evaluated against current data rather than a fixed list.

### 14.4 Row-level security hides another user's rows

```
as the owning role (no switch)      : 50 rows
as eirene_user, app.user_id = 2     : 8 rows, user_ids visible: 2
as eirene_user, app.user_id = 3     : 6 rows, user_ids visible: 3
role switched, app.user_id unset    : 0 rows (fails closed)
user 2 asking for user 3 rows       : 0 rows
as eirene_admin (reporting)         : 50 rows
admin UPDATE on another user        : 0 rows affected (read-only)
```

The first line is the documented owner exemption. The fourth is the important
one: a transaction that switched role but never set `app.user_id` sees nothing
at all, so a route that forgot to use `withUser()` fails safe rather than
returning the whole table.

**A defect this testing found.** The policies originally compared
`current_setting('app.user_id', true)::int`. On a connection where the setting
had never been used, that is `NULL`, the comparison is not true, and the
statement returns nothing — as intended. But on a *pooled* connection that had
already served a request, PostgreSQL remembers the setting name and resets its
value to an empty string rather than to `NULL`. `''::int` raises
`22P02 invalid input syntax for type integer`, so the same query failed with
an opaque error instead of quietly returning nothing.

No data was exposed either way, but the behaviour did not match what the file
claimed. Wrapping the read in `NULLIF(..., '')` turns the empty string back
into `NULL` and the policy now fails closed in both cases. The fault only
appears on a reused connection, which is exactly what a connection pool
provides — the first round of testing used fresh connections and missed it.

**A second defect, found the same way.** `v_weekly_progress` was returning
every user's weeks despite `workout_logs` being protected, because a view
executes with its owner's privileges by default and the owner is exempt from
the policies. Declaring the view `WITH (security_invoker = true)` makes it run
as the caller. Confirmed afterwards: user 2 sees only their weeks, user 3 only
theirs.

Both faults shared a shape worth noting — the protection looked correct from
the application, because each user only ever asked for their own data. Neither
would have surfaced without testing the database layer directly.

### 14.5 Training & Users summary

| Suite | Checks | Result |
| --- | --- | --- |
| `verify-report.sh` | 15 | all pass |
| `test-auth.sh` | 16 | all pass |
| `test-workouts.sh` | 18 | all pass |
| `test-admin-and-safety.sh` | 16 | all pass |
| Role and policy checks | 10 | all pass |
| Schema constraint checks | 8 | all refused as expected |

### 14.6 Nutrition & Recommendations

`scripts/verify-nutrition.mjs` runs the checks below against a running dev
server and prints the evidence for each. It only reads, apart from one meal it
expects to be refused, so it can be re-run against the shared database.

> Fill in the PASS/FAIL column and paste the script's output after running it
> against Neon and AuraDB. The PostgreSQL-only checks and the 503 checks were
> also run against a local copy of the schema and seed data while building.

| # | Test | How | Expected |
| --- | --- | --- | --- |
| 1 | A peanut-allergic user never sees peanut dishes | Meera's `GET /api/foods/safe` compared with `v_food_allergens` | 21 foods listed, none with peanut at any depth |
| 2 | A hidden allergen is caught | Chicken Satay Skewers in Meera's hidden list; `POST /api/meals` with it | listed as hidden because of Peanut; logging it returns 403 and no row is written |
| 3 | Recommendations skip unsafe items | Meera's `GET /api/recommendations` compared with her injuries and allergies | no exercise strains her lower back, no food contains peanut |
| 4 | Neo4j unavailable returns 503 | restart with a wrong `NEO4J_PASSWORD`, run with `--expect-503` | both endpoints 503 with no list; meals and recommendations pages show "unavailable" |
| 5 | Write-through when Neo4j is down | add an allergy, change goal, log a meal with Neo4j unreachable | allergy and goal saved in PostgreSQL, 503 "saved, but…"; meal saved (201) |
| 6 | Admin-only food catalog | `GET /api/admin/foods` as a normal user; `/admin/foods` as a normal user | 403; redirect to `/dashboard?denied=admin` |
| 7 | Catalog integrity | add a duplicate name; negative calories; delete a food someone logged | 409; 400; 409 "people have logged it" |

---

## 15. Conclusion

Eirene shows that the safety of a recommendation is a database problem as much
as an application one. Each kind of data sits where it fits: accounts, catalogs
and logs in PostgreSQL, where constraints, a trigger, a procedure and row-level
security keep them correct; and the relationships between injuries, exercises,
allergens, ingredients and foods in Neo4j, where "is there any path from this
food to my allergen?" is one pattern rather than a chain of self-joins.

The rules that matter most do not depend on the user interface. An unsafe
workout is refused by a trigger, an unsafe meal by a check against
`v_safe_foods` in the same transaction as the insert, and another user's rows
by row-level security. When Neo4j is unavailable the app shows nothing rather
than an unchecked list. Testing the database layer directly found two real
defects (an empty-string session setting on pooled connections, and a view
bypassing row-level security), which were fixed.

### 15.1 Limitations and future work

- Similar users are matched on goal only. Weighting them by shared injuries and
  allergies as well would make recommendations more personal.
- The graph is updated after each commit; if that write fails, the sync script
  repairs it rather than an automatic retry.
- Workouts are logged one exercise at a time, with no saved routines.
- Nutrition is per serving, with no portion sizes or daily targets.

---

## 16. Individual contributions

Each member owned one feature area end to end: SQL, Neo4j, API and UI.

| Area | Rhea Sushanth: Training & Users | Manasa K Yadav: Nutrition & Recommendations |
| --- | --- | --- |
| SQL tables | users, injuries, user_injuries, exercises, exercise_injuries, workout_logs, progress_logs | goals, allergens, user_allergies, ingredients, ingredient_parts, foods, food_ingredients, meal_logs |
| Advanced SQL | trigger blocking unsafe workouts; procedure `log_workout`; view `v_weekly_progress` | function `daily_calories`; recursive CTE for hidden allergens; views `v_food_allergens`, `v_safe_foods` |
| Queries | correlated subquery; GROUP BY with HAVING | nested subquery; JOIN with aggregates |
| Neo4j | exercise and injury graph, safe-exercise query, DID edges, injury links | food, ingredient and allergen graph, safe-food query, recommendations, ATE edges, allergy links |
| Backend | health route, auth, `proxy.ts`, workout and progress routes, database roles and RLS | Neo4j driver, sync script, meal, food and recommendation routes |
| UI | login, register, dashboard, workouts, injuries on profile, admin exercises, admin insights | goal and allergies on profile, meals, recommendations, admin foods |
| Report | authentication and roles, workout module, training SQL, training tests | database justification, Neo4j model, recommendation logic, architecture, data dictionary, nutrition tests |

Shared: ER diagram and relational schema, technology justification,
constraints and database-level role grants, README, this report.
