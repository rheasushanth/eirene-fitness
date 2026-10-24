import { NextResponse } from "next/server";
import { z } from "zod";
import { withUser } from "@/lib/db";
import { loadFoodCatalog } from "@/lib/food-catalog";
import { getSession } from "@/lib/auth";
import { upsertFoodNode, deleteFoodNode, setFoodIngredients } from "@/lib/graph-sync";

const foodSchema = z.object({
  name: z.string().trim().min(2).max(120),
  calories: z.coerce.number().min(0).max(99999),
  proteinG: z.coerce.number().min(0).max(9999).nullable().default(null),
  carbsG: z.coerce.number().min(0).max(9999).nullable().default(null),
  fatG: z.coerce.number().min(0).max(9999).nullable().default(null),
  ingredientIds: z.array(z.coerce.number().int().positive()).default([]),
});

const updateSchema = foodSchema.extend({
  foodId: z.coerce.number().int().positive(),
});

const deleteSchema = z.object({ foodId: z.coerce.number().int().positive() });

/** Admin-only. proxy.ts already keeps non-admins out of /admin pages; this is
 *  the same check on the data, since the API is reachable directly. */
async function requireAdmin() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  if (session.role !== "admin") {
    return { error: NextResponse.json({ error: "Administrators only" }, { status: 403 }) };
  }
  return { session };
}

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
}

// GET — the catalog with the ingredients and allergens of each food.
//
// ?q= searches the food's name and the names of its ingredients. The
// filtering is done by the database with ILIKE rather than in the browser, so
// the page stays correct as the catalog grows and the work happens where the
// data is.
export async function GET(request: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const term = new URL(request.url).searchParams.get("q")?.trim() ?? "";

  const data = await withUser(session, (q) => loadFoodCatalog(q, term));
  return NextResponse.json({ ...data, query: term });
}

// POST — add a food and its ingredients.
export async function POST(request: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const parsed = foodSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the values you entered" },
      { status: 400 }
    );
  }

  const { name, calories, proteinG, carbsG, fatG, ingredientIds } = parsed.data;

  let foodId: number;
  try {
    // PostgreSQL first: it is the source of truth, and the UNIQUE constraint
    // on name is what rejects a duplicate.
    foodId = await withUser(session, async (q) => {
      const inserted = await q<{ food_id: number }>(
        `INSERT INTO foods (name, calories, protein_g, carbs_g, fat_g)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING food_id`,
        [name, calories, proteinG, carbsG, fatG]
      );

      const id = inserted.rows[0].food_id;

      for (const ingredientId of ingredientIds) {
        await q(
          `INSERT INTO food_ingredients (food_id, ingredient_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, ingredientId]
        );
      }

      return id;
    });
  } catch (err) {
    const code = errorCode(err);
    if (code === "23505") {
      return NextResponse.json({ error: "A food with that name already exists" }, { status: 409 });
    }
    if (code === "23503") {
      return NextResponse.json({ error: "One of those ingredients does not exist" }, { status: 400 });
    }
    console.error("create food failed", err);
    return NextResponse.json({ error: "Could not add the food" }, { status: 500 });
  }

  // Then the graph, so the allergy filter sees the new food. Until it does,
  // the meals page still drops it through the v_safe_foods check.
  try {
    await upsertFoodNode(foodId, name, calories);
    await setFoodIngredients(
      foodId,
      ingredientIds.map((ingredientId) => ({ ingredientId, quantityG: null }))
    );
  } catch (err) {
    console.error("could not mirror food to the graph", err);
    return NextResponse.json(
      { ok: true, foodId, warning: "Saved, but the graph was not updated. Re-run the sync script." },
      { status: 201 }
    );
  }

  return NextResponse.json({ ok: true, foodId }, { status: 201 });
}

// PUT — edit a food and replace its ingredients.
export async function PUT(request: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the values you entered" }, { status: 400 });
  }

  const { foodId, name, calories, proteinG, carbsG, fatG, ingredientIds } = parsed.data;

  try {
    const found = await withUser(session, async (q) => {
      const updated = await q(
        `UPDATE foods
            SET name = $2, calories = $3, protein_g = $4, carbs_g = $5, fat_g = $6
          WHERE food_id = $1`,
        [foodId, name, calories, proteinG, carbsG, fatG]
      );

      if (updated.rowCount === 0) return false;

      // Replace rather than merge, so unticking an ingredient removes it.
      // Quantities of ingredients that stay are kept.
      await q(
        `DELETE FROM food_ingredients
          WHERE food_id = $1 AND NOT (ingredient_id = ANY($2::int[]))`,
        [foodId, ingredientIds]
      );
      for (const ingredientId of ingredientIds) {
        await q(
          `INSERT INTO food_ingredients (food_id, ingredient_id)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [foodId, ingredientId]
        );
      }
      return true;
    });

    if (!found) return NextResponse.json({ error: "No such food" }, { status: 404 });
  } catch (err) {
    const code = errorCode(err);
    if (code === "23505") {
      return NextResponse.json({ error: "A food with that name already exists" }, { status: 409 });
    }
    if (code === "23503") {
      return NextResponse.json({ error: "One of those ingredients does not exist" }, { status: 400 });
    }
    console.error("update food failed", err);
    return NextResponse.json({ error: "Could not save the changes" }, { status: 500 });
  }

  try {
    await upsertFoodNode(foodId, name, calories);
    await setFoodIngredients(
      foodId,
      ingredientIds.map((ingredientId) => ({ ingredientId, quantityG: null }))
    );
  } catch (err) {
    console.error("could not mirror food to the graph", err);
    return NextResponse.json({
      ok: true,
      warning: "Saved, but the graph was not updated. Re-run the sync script.",
    });
  }

  return NextResponse.json({ ok: true });
}

// DELETE — remove a food from both databases.
export async function DELETE(request: Request) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const parsed = deleteSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Which food?" }, { status: 400 });

  const { foodId } = parsed.data;

  try {
    const removed = await withUser(session, async (q) => {
      const result = await q(`DELETE FROM foods WHERE food_id = $1`, [foodId]);
      return result.rowCount ?? 0;
    });

    if (removed === 0) return NextResponse.json({ error: "No such food" }, { status: 404 });
  } catch (err) {
    // 23503: meal_logs.food_id has no ON DELETE CASCADE on purpose, so
    // removing a food from the catalog cannot erase people's eating history.
    if (errorCode(err) === "23503") {
      return NextResponse.json(
        { error: "That food cannot be deleted because people have logged it." },
        { status: 409 }
      );
    }
    console.error("delete food failed", err);
    return NextResponse.json({ error: "Could not delete the food" }, { status: 500 });
  }

  try {
    await deleteFoodNode(foodId);
  } catch (err) {
    console.error("could not remove food from the graph", err);
  }

  return NextResponse.json({ ok: true });
}
