"use client";

import { useEffect, useRef, useState } from "react";
import type { CatalogFood, CatalogIngredient } from "@/lib/food-catalog";

type Draft = {
  foodId?: number;
  name: string;
  calories: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
  ingredientIds: number[];
};

const empty: Draft = {
  name: "",
  calories: "",
  proteinG: "",
  carbsG: "",
  fatG: "",
  ingredientIds: [],
};

const inputClass =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-300";

/** Blank macro fields are sent as null rather than 0: unknown, not zero. */
function optionalNumber(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

export default function FoodManager({
  foods: initialFoods,
  ingredients: initialIngredients,
}: {
  foods: CatalogFood[];
  ingredients: CatalogIngredient[];
}) {
  const [foods, setFoods] = useState<CatalogFood[]>(initialFoods);
  const [ingredients, setIngredients] = useState<CatalogIngredient[]>(initialIngredients);
  const [draft, setDraft] = useState<Draft>(empty);
  const [message, setMessage] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [search, setSearch] = useState("");

  async function load(term = search) {
    const url = term.trim()
      ? `/api/admin/foods?q=${encodeURIComponent(term.trim())}`
      : "/api/admin/foods";
    const data = await fetch(url).then((r) => r.json());
    setFoods(data.foods ?? []);
    setIngredients(data.ingredients ?? []);
  }

  // The search runs in the database, so it is debounced rather than fired on
  // every keystroke. The first render already has the full catalog from the
  // server, so there is nothing to fetch until the term changes.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const timer = setTimeout(() => load(search), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setPending(true);

    const editing = draft.foodId !== undefined;
    const response = await fetch("/api/admin/foods", {
      method: editing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        foodId: draft.foodId,
        name: draft.name,
        calories: Number(draft.calories),
        proteinG: optionalNumber(draft.proteinG),
        carbsG: optionalNumber(draft.carbsG),
        fatG: optionalNumber(draft.fatG),
        ingredientIds: draft.ingredientIds,
      }),
    });
    const data = await response.json().catch(() => ({}));
    setPending(false);

    if (!response.ok) {
      setMessage({ kind: "error", text: data.error ?? "Could not save" });
      return;
    }

    setMessage({
      kind: data.warning ? "error" : "ok",
      text: data.warning ?? (editing ? "Food updated." : "Food added."),
    });
    setDraft(empty);
    load();
  }

  async function remove(food: CatalogFood) {
    if (!confirm(`Delete ${food.name}?`)) return;
    setMessage(null);

    const response = await fetch("/api/admin/foods", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foodId: food.food_id }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      setMessage({ kind: "error", text: data.error ?? "Could not delete" });
      return;
    }
    setMessage({ kind: "ok", text: `${food.name} deleted.` });
    load();
  }

  function edit(food: CatalogFood) {
    setDraft({
      foodId: food.food_id,
      name: food.name,
      calories: String(Number(food.calories)),
      proteinG: food.protein_g === null ? "" : String(Number(food.protein_g)),
      carbsG: food.carbs_g === null ? "" : String(Number(food.carbs_g)),
      fatG: food.fat_g === null ? "" : String(Number(food.fat_g)),
      ingredientIds: food.ingredient_ids ?? [],
    });
    setMessage(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleIngredient(ingredientId: number) {
    setDraft((d) => ({
      ...d,
      ingredientIds: d.ingredientIds.includes(ingredientId)
        ? d.ingredientIds.filter((id) => id !== ingredientId)
        : [...d.ingredientIds, ingredientId],
    }));
  }

  const ingredientName = (id: number) =>
    ingredients.find((i) => i.ingredient_id === id)?.name ?? String(id);

  const numberField = (id: keyof Draft, label: string, required = false) => (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">{label}</label>
      <input
        id={id}
        type="number"
        min="0"
        step="any"
        required={required}
        value={draft[id] as string}
        onChange={(e) => setDraft({ ...draft, [id]: e.target.value })}
        className={inputClass}
      />
    </div>
  );

  return (
    <div className="space-y-10">
      <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="mb-4 font-medium">
          {draft.foodId ? `Edit ${draft.name || "food"}` : "Add a food"}
        </h2>

        {message && (
          <p
            role="alert"
            className={
              message.kind === "error"
                ? "mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
                : "mb-4 rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-200"
            }
          >
            {message.text}
          </p>
        )}

        <form onSubmit={save} className="grid gap-4 sm:grid-cols-4">
          <div className="space-y-1.5 sm:col-span-3">
            <label htmlFor="name" className="block text-sm font-medium">Name</label>
            <input
              id="name"
              required
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className={inputClass}
            />
          </div>

          {numberField("calories", "Calories (kcal)", true)}
          {numberField("proteinG", "Protein (g)")}
          {numberField("carbsG", "Carbs (g)")}
          {numberField("fatG", "Fat (g)")}

          <fieldset className="sm:col-span-4">
            <legend className="mb-2 text-sm font-medium">Ingredients</legend>
            <p className="mb-2 text-xs text-zinc-500">
              Each one ticked becomes a CONTAINS edge. Allergens inside an
              ingredient (the peanut in satay sauce) are found automatically, so
              only list what goes directly into the dish. Allergen ingredients
              are marked.
            </p>
            <div className="flex flex-wrap gap-2">
              {ingredients.map((ingredient) => {
                const on = draft.ingredientIds.includes(ingredient.ingredient_id);
                return (
                  <button
                    type="button"
                    key={ingredient.ingredient_id}
                    onClick={() => toggleIngredient(ingredient.ingredient_id)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium ${
                      on
                        ? "border-amber-400 bg-amber-100 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
                        : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
                    }`}
                  >
                    {on ? "✓ " : ""}
                    {ingredient.name}
                    {ingredient.allergen && <span className="ml-1 opacity-70">({ingredient.allergen})</span>}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="flex gap-3 sm:col-span-4">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {pending ? "Saving…" : draft.foodId ? "Save changes" : "Add food"}
            </button>
            {draft.foodId && (
              <button
                type="button"
                onClick={() => { setDraft(empty); setMessage(null); }}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </section>

      <section>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">
            Catalog ({foods.length}
            {search.trim() && " matching"})
          </h2>

          <div className="flex items-center gap-2">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search food or ingredient…"
              aria-label="Search foods"
              className="w-64 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-300"
            />
            {search.trim() && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="text-xs font-medium underline underline-offset-4"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {search.trim() && (
          <p className="mb-3 text-xs text-zinc-500">
            Filtered by the database:{" "}
            <code>
              WHERE f.name ILIKE &apos;%{search.trim()}%&apos; OR EXISTS (SELECT 1
              FROM food_ingredients … WHERE i.name ILIKE &apos;%{search.trim()}%&apos;)
            </code>
          </p>
        )}
        {foods.length === 0 ? (
          <p className="text-sm text-zinc-500">
            {search.trim() ? `No food matches “${search.trim()}”.` : "No foods in the catalog yet."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <thead className="border-b border-zinc-200 text-left text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                <tr>
                  <th className="py-2 pr-4 font-medium">Food</th>
                  <th className="py-2 pr-4 font-medium">kcal</th>
                  <th className="py-2 pr-4 font-medium">Ingredients</th>
                  <th className="py-2 pr-4 font-medium">Allergens</th>
                  <th className="py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {foods.map((f) => (
                  <tr key={f.food_id} className="border-b border-zinc-100 dark:border-zinc-900">
                    <td className="py-2 pr-4">{f.name}</td>
                    <td className="py-2 pr-4 tabular-nums">{Math.round(Number(f.calories))}</td>
                    <td className="py-2 pr-4 text-zinc-600 dark:text-zinc-400">
                      {f.ingredient_ids.length ? f.ingredient_ids.map(ingredientName).join(", ") : "—"}
                    </td>
                    <td className="py-2 pr-4">
                      {f.allergens.length ? (
                        <span className="text-amber-700 dark:text-amber-300">{f.allergens.join(", ")}</span>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => edit(f)}
                        className="mr-3 text-xs font-medium underline underline-offset-4"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => remove(f)}
                        className="text-xs font-medium text-red-700 underline underline-offset-4 dark:text-red-400"
                      >
                        Delete
                      </button>
                    </td>
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
