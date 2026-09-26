import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const households = pgTable(
  "households",
  {
    singleton: boolean("singleton").primaryKey().default(true),
    id: uuid("id").notNull(),
    listsRevision: integer("lists_revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("households_singleton_true", sql`${table.singleton} IS TRUE`),
    check("households_lists_revision_positive", sql`${table.listsRevision} > 0`),
    unique("households_id_unique").on(table.id),
  ],
);

export const memberRole = pgEnum("member_role", ["member", "admin"]);

export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: memberRole("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const lists = pgTable(
  "lists",
  {
    id: uuid("id").primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    revision: integer("revision").notNull().default(1),
    entriesRevision: integer("entries_revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("lists_household_position_idx").on(table.householdId, table.position, table.id),
    check("lists_position_nonnegative", sql`${table.position} >= 0`),
    check("lists_revision_positive", sql`${table.revision} > 0`),
    check("lists_entries_revision_positive", sql`${table.entriesRevision} > 0`),
  ],
);

export const entries = pgTable(
  "entries",
  {
    id: uuid("id").primaryKey(),
    listId: uuid("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    quantity: text("quantity"),
    unit: text("unit"),
    note: text("note"),
    dueDate: date("due_date", { mode: "string" }),
    completed: boolean("completed").notNull().default(false),
    position: integer("position").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("entries_list_position_idx").on(table.listId, table.position, table.id),
    check("entries_position_nonnegative", sql`${table.position} >= 0`),
    check("entries_revision_positive", sql`${table.revision} > 0`),
    check(
      "entries_quantity_positive_decimal",
      sql`${table.quantity} IS NULL OR (${table.quantity} ~ '^[0-9]+(\\.[0-9]{1,3})?$' AND ${table.quantity}::numeric > 0)`,
    ),
  ],
);

export const boardPosts = pgTable(
  "board_posts",
  {
    id: uuid("id").primaryKey(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    authorMemberId: uuid("author_member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    message: text("message").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [
    index("board_posts_household_created_id_idx").on(table.householdId, table.createdAt, table.id),
    check("board_posts_revision_positive", sql`${table.revision} > 0`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    memberId: uuid("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sessions_member_id_idx").on(table.memberId)],
);
