import { sql } from "drizzle-orm";
import { boolean, check, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const households = pgTable(
  "households",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    id: uuid("id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("households_singleton_true", sql`${table.singleton} IS TRUE`),
    unique("households_id_unique").on(table.id),
  ],
);
