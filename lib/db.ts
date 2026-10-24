import { Pool, types, type QueryResult, type QueryResultRow } from "pg";

// Return DATE columns as the plain 'YYYY-MM-DD' string the database holds.
// By default the driver builds a JavaScript Date at local midnight, which in
// any timezone ahead of UTC serialises back as the previous day — so a
// workout logged today would appear on the dashboard as yesterday.
types.setTypeParser(types.builtins.DATE, (value) => value);

// One Pool per process, created on first use. In dev, Next.js hot-reloads
// modules, so the pool is cached on globalThis to stop every reload from
// opening a new set of connections to Neon. Creating it lazily also keeps
// `next build` working without a DATABASE_URL.
const globalForDb = globalThis as unknown as { eirenePool?: Pool };

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  }

  // TLS is configured here rather than through the connection string. Neon
  // appends sslmode=require, which the driver currently treats as verify-full
  // and warns about, since a future major version will downgrade it to
  // libpq's weaker meaning. Stripping the parameter and asking for a verified
  // certificate directly keeps today's behaviour, survives that change, and
  // stops the warning appearing in the dev overlay.
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");
  url.searchParams.delete("channel_binding");

  return new Pool({
    connectionString: url.toString(),
    // Neon's certificate validates against Node's trust store, so it is
    // verified rather than blindly accepted.
    ssl: { rejectUnauthorized: true },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export function getPool(): Pool {
  if (!globalForDb.eirenePool) {
    globalForDb.eirenePool = createPool();
  }
  return globalForDb.eirenePool;
}

/**
 * Run a parameterised SQL statement.
 *
 * Always pass values through `params` ($1, $2, ...) instead of building the
 * string, so the driver escapes them and SQL injection is not possible.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** A transaction-scoped client. Same shape as `query`, bound to one
 *  connection inside an open transaction. */
export type ScopedQuery = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
) => Promise<QueryResult<T>>;

/**
 * Run `fn` as the signed-in user, with the row-level security policies in
 * force.
 *
 * Opens a transaction, switches to eirene_user or eirene_admin, and sets
 * app.user_id, which is what the policies in security.sql compare against.
 * Both use SET LOCAL / set_config(..., true), so they are undone at COMMIT
 * and the pooled connection carries nothing into the next request.
 *
 * Everything acting on behalf of a user should go through this. A query run
 * outside it uses the owning role, which PostgreSQL exempts from the
 * policies.
 */
export async function withUser<T>(
  user: { userId: number; role: "admin" | "user" },
  fn: (q: ScopedQuery) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    // The role name is chosen here rather than interpolated from input: SET
    // ROLE cannot take a parameter, so nothing from the request may reach it.
    await client.query(user.role === "admin" ? "SET LOCAL ROLE eirene_admin" : "SET LOCAL ROLE eirene_user");

    // The id does go through a parameter. `true` makes it transaction-local.
    await client.query("SELECT set_config('app.user_id', $1, true)", [String(user.userId)]);

    const scoped: ScopedQuery = (text, params = []) => client.query(text, params);
    const result = await fn(scoped);

    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Convenience wrapper for queries that return at most one row. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] ?? null;
}
