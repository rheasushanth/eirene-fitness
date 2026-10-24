-- Eirene — the queries shown in the report and viva
--
-- Each one is a different kind of query, and each answers a question the app
-- actually asks rather than being written to demonstrate a keyword.

-- ============================================================
-- 1. Correlated subquery
--    Who is losing weight?
-- ============================================================
--
-- Compares each user's most recent weigh-in against their first. The two
-- subqueries are correlated: both reference p.user_id from the outer query,
-- so they are evaluated per user rather than once for the whole table.
--
-- ORDER BY logged_on with LIMIT 1 rather than MIN/MAX of the weight: the
-- question is which weight was recorded first and last in time, not which was
-- the smallest and largest.

SELECT
    u.user_id,
    u.full_name,
    (SELECT p.weight_kg FROM progress_logs p
      WHERE p.user_id = u.user_id
      ORDER BY p.logged_on ASC  LIMIT 1) AS first_weight_kg,
    (SELECT p.weight_kg FROM progress_logs p
      WHERE p.user_id = u.user_id
      ORDER BY p.logged_on DESC LIMIT 1) AS latest_weight_kg,
    (SELECT p.weight_kg FROM progress_logs p
      WHERE p.user_id = u.user_id
      ORDER BY p.logged_on DESC LIMIT 1)
  - (SELECT p.weight_kg FROM progress_logs p
      WHERE p.user_id = u.user_id
      ORDER BY p.logged_on ASC  LIMIT 1) AS change_kg
FROM users u
WHERE (SELECT p.weight_kg FROM progress_logs p
        WHERE p.user_id = u.user_id
        ORDER BY p.logged_on DESC LIMIT 1)
    < (SELECT p.weight_kg FROM progress_logs p
        WHERE p.user_id = u.user_id
        ORDER BY p.logged_on ASC  LIMIT 1)
ORDER BY change_kg ASC;

-- ============================================================
-- 2. GROUP BY with HAVING and ORDER BY
--    Who has trained at least three times in the last seven days?
-- ============================================================
--
-- WHERE filters rows before grouping (this week's logs only); HAVING filters
-- the groups afterwards (users with three or more). The distinction is the
-- point of the query: a count cannot be tested in WHERE, because the groups
-- do not exist yet at that stage.
--
-- The window is the last seven days rather than the calendar week. A calendar
-- week restarts at midnight on Monday, so on a Monday morning the answer is
-- whatever happened that day — for a "have you trained enough lately" question
-- that is the wrong boundary. v_weekly_progress still buckets by calendar week,
-- because comparing one week against the next is a different question.

SELECT
    u.user_id,
    u.full_name,
    COUNT(*)                                   AS workouts_last_7_days,
    COUNT(DISTINCT w.exercise_id)              AS different_exercises,
    SUM(w.sets * w.reps)                       AS total_reps,
    SUM(w.sets * w.reps * w.weight_kg)         AS total_volume_kg,
    MAX(w.logged_on)                           AS last_workout
FROM workout_logs w
JOIN users u ON u.user_id = w.user_id
WHERE w.logged_on > CURRENT_DATE - INTERVAL '7 days'
GROUP BY u.user_id, u.full_name
HAVING COUNT(*) >= 3
ORDER BY workouts_last_7_days DESC, total_volume_kg DESC;

-- ============================================================
-- 3. Recursive CTE
--    Every allergen reachable from a food through nested ingredients
-- ============================================================
--
-- Written for the nutrition half of the schema. Walks ingredient_parts from a
-- food's direct ingredients down through every level, so an allergen hidden
-- two or three layers deep (satay sauce -> peanut butter -> peanut) is still
-- found.

-- Chicken Satay Skewers (food 1) is the example used in the viva. Change the
-- food_id in the anchor to trace any other food.
WITH RECURSIVE parts (ingredient_id, depth, path) AS (
    -- Anchor: the food's direct ingredients.
    SELECT fi.ingredient_id, 1, i.name::text
      FROM food_ingredients fi
      JOIN ingredients i ON i.ingredient_id = fi.ingredient_id
     WHERE fi.food_id = 1

    UNION ALL

    -- Recursive step: whatever each ingredient found so far is made of.
    SELECT ip.child_id, p.depth + 1, p.path || ' -> ' || c.name
      FROM parts p
      JOIN ingredient_parts ip ON ip.parent_id = p.ingredient_id
      JOIN ingredients c       ON c.ingredient_id = ip.child_id
     WHERE p.depth < 10          -- guard against a cycle in bad data
)
SELECT a.name AS allergen, p.depth, p.path
  FROM parts p
  JOIN ingredients i ON i.ingredient_id = p.ingredient_id
  JOIN allergens a   ON a.allergen_id   = i.allergen_id
 ORDER BY a.name, p.depth;

-- The same walk, for every food at once, is the view v_food_allergens in
-- views.sql. v_safe_foods builds on it, and the meals route checks every
-- insert against v_safe_foods.

-- ============================================================
-- 4. Nested subquery
--    Foods nobody has logged
-- ============================================================
--
-- The inner query runs once and produces the set of food ids that appear in
-- meal_logs; the outer query keeps the foods outside that set. Unlike the
-- correlated subquery above, it does not reference the outer row.
--
-- NOT IN is safe here because meal_logs.food_id is NOT NULL. With a nullable
-- column a single NULL would make NOT IN return no rows at all.

SELECT f.food_id, f.name, f.calories
  FROM foods f
 WHERE f.food_id NOT IN (SELECT m.food_id FROM meal_logs m)
 ORDER BY f.name;

-- ============================================================
-- 5. JOIN with aggregates
--    Average daily calories per goal
-- ============================================================
--
-- Two levels of aggregation. The inner query totals each user's calories per
-- day (JOIN meal_logs to foods, SUM per user per day). The outer query joins
-- those days to users and goals and averages them per goal, so a user who
-- logs more days does not count as more than one person per day.
--
-- LEFT JOIN from goals keeps a goal that nobody with meal logs has chosen,
-- with zero users rather than missing from the report.

SELECT
    g.goal_id,
    g.name                                  AS goal,
    COUNT(DISTINCT d.user_id)               AS users_logging,
    COUNT(d.day)                            AS user_days,
    ROUND(AVG(d.day_calories), 0)           AS avg_daily_calories,
    ROUND(MIN(d.day_calories), 0)           AS lowest_day,
    ROUND(MAX(d.day_calories), 0)           AS highest_day
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
