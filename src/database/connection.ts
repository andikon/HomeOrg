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
  databasePassword?: string,
): DatabaseConnection {
  const connectionString = databasePassword
    ? withPassword(databaseUrl, databasePassword)
    : databaseUrl;
  const pool = new Pool({
    connectionString,
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

function withPassword(databaseUrl: string, databasePassword: string): string {
  const url = new URL(databaseUrl);
  url.password = databasePassword;
  return url.toString();
}
