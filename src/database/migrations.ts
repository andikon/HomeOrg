import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { z } from "zod";
import type { Pool } from "pg";
import { createDatabaseConnection } from "./connection.js";

const migrationJournalSchema = z.object({
  entries: z.array(z.object({ when: z.number().int().nonnegative() })),
});

export async function runMigrations(
  databaseUrl: string,
  migrationsFolder = join(process.cwd(), "drizzle"),
): Promise<void> {
  const connection = createDatabaseConnection(databaseUrl);

  try {
    await migrate(connection.db, { migrationsFolder });
  } finally {
    await connection.close();
  }
}

export async function migrationsAreCurrent(
  pool: Pool,
  migrationsFolder = join(process.cwd(), "drizzle"),
): Promise<boolean> {
  let journalContents: string;

  try {
    journalContents = await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return false;
    }

    throw error;
  }

  const journal = migrationJournalSchema.parse(JSON.parse(journalContents));
  const expectedMigration = Math.max(0, ...journal.entries.map((entry) => entry.when));
  const ledgerResult = await pool.query<{ ledger: string | null }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations')::text AS ledger",
  );

  if (!ledgerResult.rows[0]?.ledger) {
    return false;
  }

  const migrationResult = await pool.query<{ latestMigration: string | null }>(
    "SELECT MAX(created_at)::text AS \"latestMigration\" FROM drizzle.__drizzle_migrations",
  );
  const appliedMigration = Number(migrationResult.rows[0]?.latestMigration ?? 0);

  return appliedMigration === expectedMigration;
}

function isFileNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
