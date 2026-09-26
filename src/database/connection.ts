import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export interface DatabaseConnection {
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
  close: () => Promise<void>;
}

export function createDatabaseConnection(
  databaseUrl: string,
  connectionTimeoutMillis = 5_000,
): DatabaseConnection {
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis,
    max: 10,
    statement_timeout: 5_000,
  });

  return {
    pool,
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}
