import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { DatabaseConnection } from "../database/connection.js";
import { boardPosts, entries, households, lists, members } from "../database/schema.js";
import { problemBody, problemSchema } from "../problem.js";
import { authenticateSession, type MemberView } from "../auth/sessions.js";

const uuidSchema = z.uuid();
const listBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
}).strict();
const entryTitleSchema = z.string().trim().min(1).max(200);
const optionalTextSchema = (maximumLength: number) =>
  z.string().trim().max(maximumLength).nullable().optional().transform((value) =>
    value === undefined ? undefined : typeof value === "string" && value.length === 0 ? null : value);
const quantitySchema = optionalTextSchema(131076);
const unitSchema = optionalTextSchema(32);
const noteSchema = optionalTextSchema(1000);
const dueDateSchema = z.iso.date().nullable().optional();

const entryFields = {
  title: entryTitleSchema,
  quantity: quantitySchema,
  unit: unitSchema,
  note: noteSchema,
  dueDate: dueDateSchema,
};
const createEntryBodySchema = z.object(entryFields).strict().superRefine((value, context) => {
  validateQuantity(value.quantity, context);
});
const patchEntryBodySchema = z.object({
  title: entryFields.title.optional(),
  quantity: entryFields.quantity,
  unit: entryFields.unit,
  note: entryFields.note,
  dueDate: entryFields.dueDate,
  completed: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (Object.keys(value).length === 0) {
    context.addIssue({ code: "custom", message: "At least one field must be supplied." });
  }
  validateQuantity(value.quantity, context);
});
const moveBodySchema = z.object({
  beforeId: uuidSchema.optional(),
  afterId: uuidSchema.optional(),
  atEnd: z.literal(true).optional(),
}).strict();
const boardPostBodySchema = z.object({
  message: z.string().trim().min(1).max(2000),
}).strict();
const boardPostPatchSchema = boardPostBodySchema;
const listParamsSchema = z.object({ listId: uuidSchema });
const entryParamsSchema = z.object({ listId: uuidSchema, entryId: uuidSchema });
const boardPostParamsSchema = z.object({ postId: uuidSchema });
const boardCursorSchema = z.string().transform((encoded, context) => {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    const cursor = z.tuple([
      z.iso.datetime({ precision: 6 }),
      uuidSchema,
    ]).safeParse(parsed);
    if (cursor.success) {
      return { createdAt: cursor.data[0], id: cursor.data[1] };
    }
  } catch {
    // Invalid cursors are reported as request validation failures below.
  }

  context.addIssue({ code: "custom", message: "Cursor is invalid." });
  return z.NEVER;
});
const boardQuerySchema = z.object({
  cursor: boardCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

const listViewSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const entryViewSchema = z.object({
  id: uuidSchema,
  listId: uuidSchema,
  title: z.string(),
  quantity: z.string().nullable(),
  unit: z.string().nullable(),
  note: z.string().nullable(),
  dueDate: z.iso.date().nullable(),
  completed: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const listWithEntriesSchema = listViewSchema.extend({ entries: z.array(entryViewSchema) });
const boardPostViewSchema = z.object({
  id: uuidSchema,
  author: z.object({ id: uuidSchema, email: z.email() }),
  message: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().nullable(),
});
const cursorPageSchema = z.object({
  items: z.array(boardPostViewSchema),
  nextCursor: z.string().nullable(),
});
const emptyResponseSchema = z.null();

export interface RegisterHouseholdRoutesOptions {
  database: DatabaseConnection;
  sessionSecret: string;
}

export async function registerHouseholdRoutes(
  app: FastifyInstance,
  options: RegisterHouseholdRoutesOptions,
): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const readMember = (request: FastifyRequest, reply: FastifyReply) =>
    authenticateSession(request, reply, options.database, options.sessionSecret, false);
  const mutateMember = (request: FastifyRequest, reply: FastifyReply) =>
    authenticateSession(request, reply, options.database, options.sessionSecret, true);

  routes.get(
    "/api/v1/lists",
    {
      preHandler: readMember,
      schema: {
        tags: ["lists"],
        security: [{ sessionCookie: [] }],
        response: { 200: z.array(listViewSchema), 401: problemSchema },
      },
    },
    async (_request, reply) => {
      const { household, records } = await options.database.db.transaction(async (transaction) => {
        const [household] = await transaction.select().from(households).limit(1);
        if (!household) throw new Error("Household bootstrap has not completed.");
        const records = await transaction
          .select()
          .from(lists)
          .where(eq(lists.householdId, household.id))
          .orderBy(lists.position, lists.id);
        return { household, records };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });

      reply.header("etag", listCollectionEtag(household.id, household.listsRevision));
      return records.map(toListView);
    },
  );

  routes.post(
    "/api/v1/lists",
    {
      preHandler: mutateMember,
      schema: {
        tags: ["lists"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        body: listBodySchema,
        response: { 201: listViewSchema, 401: problemSchema, 403: problemSchema, 422: problemSchema },
      },
    },
    async (request, reply) => {
      const created = await options.database.db.transaction(async (transaction) => {
        const household = await lockHousehold(transaction);
        const ordered = await transaction
          .select({ id: lists.id })
          .from(lists)
          .where(eq(lists.householdId, household.id))
          .orderBy(lists.position, lists.id);
        const [createdList] = await transaction
          .insert(lists)
          .values({
            id: randomUUID(),
            householdId: household.id,
            name: request.body.name,
            position: ordered.length,
          })
          .returning();
        await bumpHouseholdListsRevision(transaction, household.id);
        return createdList!;
      });

      reply.header("location", `/api/v1/lists/${created.id}`);
      reply.header("etag", listEtag(created, created.entriesRevision));
      return reply.code(201).send(toListView(created));
    },
  );

  routes.get(
    "/api/v1/lists/:listId",
    {
      preHandler: readMember,
      schema: {
        tags: ["lists"],
        security: [{ sessionCookie: [] }],
        params: listParamsSchema,
        response: {
          200: listWithEntriesSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const snapshot = await options.database.db.transaction(async (transaction) => {
        const [household] = await transaction.select().from(households).limit(1);
        if (!household) throw new Error("Household bootstrap has not completed.");
        const [list] = await transaction
          .select()
          .from(lists)
          .where(and(eq(lists.id, request.params.listId), eq(lists.householdId, household.id)))
          .limit(1);
        if (!list) return undefined;
        const childEntries = await transaction
          .select()
          .from(entries)
          .where(eq(entries.listId, list.id))
          .orderBy(entries.position, entries.id);
        return { list, childEntries };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
      if (!snapshot) return notFound(reply, "List");
      const { list, childEntries } = snapshot;

      reply.header("etag", listEtag(list, list.entriesRevision));
      return { ...toListView(list), entries: childEntries.map(toEntryView) };
    },
  );

  routes.patch(
    "/api/v1/lists/:listId",
    {
      preHandler: mutateMember,
      schema: {
        tags: ["lists"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        params: listParamsSchema,
        body: listBodySchema,
        response: {
          200: listViewSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          412: problemSchema,
          422: problemSchema,
          428: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const household = await getHousehold(options.database);
      const current = await findList(options.database, household.id, request.params.listId);
      if (!current) return notFound(reply, "List");
      const ifMatch = requirePrecondition(request, reply, "if-match");
      if (!ifMatch) return;

      const updated = await options.database.db.transaction(async (transaction) => {
        const lockedHousehold = await lockHousehold(transaction);
        const list = await lockList(transaction, lockedHousehold.id, request.params.listId);
        if (!list) return undefined;
        if (ifMatch !== listEtag(list, list.entriesRevision)) return null;
        const [result] = await transaction
          .update(lists)
          .set({
            name: request.body.name,
            revision: list.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(lists.id, list.id))
          .returning();
        await bumpHouseholdListsRevision(transaction, lockedHousehold.id);
        return result!;
      });

      if (updated === undefined) return notFound(reply, "List");
      if (updated === null) return preconditionFailed(reply);
      reply.header("etag", listEtag(updated, updated.entriesRevision));
      return toListView(updated);
    },
  );

  routes.delete(
    "/api/v1/lists/:listId",
    {
      preHandler: mutateMember,
      schema: {
        tags: ["lists"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        params: listParamsSchema,
        response: {
          204: emptyResponseSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          412: problemSchema,
          428: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const household = await getHousehold(options.database);
      if (!(await findList(options.database, household.id, request.params.listId))) {
        return notFound(reply, "List");
      }
      const ifMatch = requirePrecondition(request, reply, "if-match");
      if (!ifMatch) return;
      const ifEntriesMatch = requirePrecondition(request, reply, "if-entries-match");
      if (!ifEntriesMatch) return;

      const deleted = await options.database.db.transaction(async (transaction) => {
        const lockedHousehold = await lockHousehold(transaction);
        const list = await lockList(transaction, lockedHousehold.id, request.params.listId);
        if (!list) return undefined;
        if (
          ifMatch !== listEtag(list, list.entriesRevision) ||
          ifEntriesMatch !== entriesCollectionEtag(list.id, list.entriesRevision)
        ) {
          return null;
        }

        await transaction.delete(lists).where(eq(lists.id, list.id));
        await compactListPositions(transaction, lockedHousehold.id);
        await bumpHouseholdListsRevision(transaction, lockedHousehold.id);
        return true;
      });

      if (deleted === undefined) return notFound(reply, "List");
      if (deleted === null) return preconditionFailed(reply);
      return reply.code(204).send(null);
    },
  );

  routes.post(
    "/api/v1/lists/:listId/move",
    {
      preHandler: mutateMember,
      schema: {
        tags: ["lists"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        params: listParamsSchema,
        body: moveBodySchema,
        response: {
          200: listViewSchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          412: problemSchema,
          422: problemSchema,
          428: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const household = await getHousehold(options.database);
      const current = await findList(options.database, household.id, request.params.listId);
      if (!current) return notFound(reply, "List");
      const ifMatch = requirePrecondition(request, reply, "if-match");
      if (!ifMatch) return;
      const placement = parsePlacement(request.body, reply);
      if (!placement) return;

      const result = await options.database.db.transaction(async (transaction) => {
        const lockedHousehold = await lockHousehold(transaction);
        const ordered = await transaction
          .select()
          .from(lists)
          .where(eq(lists.householdId, lockedHousehold.id))
          .orderBy(lists.position, lists.id);
        const moved = ordered.find((list) => list.id === request.params.listId);
        if (!moved) return { kind: "missing" } as const;
        if (ifMatch !== listCollectionEtag(lockedHousehold.id, lockedHousehold.listsRevision)) {
          return { kind: "stale" } as const;
        }
        const reordered = reorderIds(ordered.map((list) => list.id), moved.id, placement);
        if (!reordered) return { kind: "invalid" } as const;
        if (reordered === "missing-anchor") return { kind: "missing-anchor" } as const;
        if (!sameOrder(reordered, ordered.map((list) => list.id))) {
          await writeListPositions(transaction, reordered);
          await bumpHouseholdListsRevision(transaction, lockedHousehold.id);
        }
        return { kind: "ok", list: moved } as const;
      });

      if (result.kind === "missing") return notFound(reply, "List");
      if (result.kind === "stale") return preconditionFailed(reply);
      if (result.kind === "missing-anchor") return notFound(reply, "List anchor");
      if (result.kind === "invalid") return badRequest(reply, "A List cannot be moved before or after itself.");
      return toListView(result.list);
    },
  );

  routes.get(
    "/api/v1/lists/:listId/entries",
    {
      preHandler: readMember,
      schema: {
        tags: ["entries"],
        security: [{ sessionCookie: [] }],
        params: listParamsSchema,
        response: { 200: z.array(entryViewSchema), 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const snapshot = await options.database.db.transaction(async (transaction) => {
        const [household] = await transaction.select().from(households).limit(1);
        if (!household) throw new Error("Household bootstrap has not completed.");
        const [list] = await transaction
          .select()
          .from(lists)
          .where(and(eq(lists.id, request.params.listId), eq(lists.householdId, household.id)))
          .limit(1);
        if (!list) return undefined;
        const childEntries = await transaction
          .select()
          .from(entries)
          .where(eq(entries.listId, list.id))
          .orderBy(entries.position, entries.id);
        return { list, childEntries };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
      if (!snapshot) return notFound(reply, "List");
      const { list, childEntries } = snapshot;
      reply.header("etag", entriesCollectionEtag(list.id, list.entriesRevision));
      return childEntries.map(toEntryView);
    },
  );

  routes.post(
    "/api/v1/lists/:listId/entries",
    {
      preHandler: mutateMember,
      schema: {
        tags: ["entries"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        params: listParamsSchema,
        body: createEntryBodySchema,
        response: {
          201: entryViewSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          422: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const household = await getHousehold(options.database);
      const created = await options.database.db.transaction(async (transaction) => {
        const list = await lockList(transaction, household.id, request.params.listId);
        if (!list) return undefined;
        const ordered = await transaction
          .select({ id: entries.id })
          .from(entries)
          .where(eq(entries.listId, list.id))
          .orderBy(entries.position, entries.id);
        const [createdEntry] = await transaction
          .insert(entries)
          .values({
            id: randomUUID(),
            listId: list.id,
            title: request.body.title,
            quantity: request.body.quantity,
            unit: request.body.unit,
            note: request.body.note,
            dueDate: request.body.dueDate,
            position: ordered.length,
            completed: false,
          })
          .returning();
        await bumpEntriesRevision(transaction, list.id);
        return createdEntry!;
      });

      if (!created) return notFound(reply, "List");
      reply.header("location", `/api/v1/lists/${request.params.listId}/entries/${created.id}`);
      reply.header("etag", entryEtag(created));
      return reply.code(201).send(toEntryView(created));
    },
  );

  routes.get(
    "/api/v1/lists/:listId/entries/:entryId",
    {
      preHandler: readMember,
      schema: {
        tags: ["entries"],
        security: [{ sessionCookie: [] }],
        params: entryParamsSchema,
        response: {
          200: entryViewSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const household = await getHousehold(options.database);
      const found = await findEntry(options.database, household.id, request.params.listId, request.params.entryId);
      if (!found) return notFound(reply, "Entry");
      reply.header("etag", entryEtag(found));
      return toEntryView(found);
    },
  );

  routes.patch(
    "/api/v1/lists/:listId/entries/:entryId",
    {
      preHandler: mutateMember,
      schema: {
        tags: ["entries"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        params: entryParamsSchema,
        body: patchEntryBodySchema,
        response: {
          200: entryViewSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          412: problemSchema,
          422: problemSchema,
          428: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const household = await getHousehold(options.database);
      if (!(await findEntry(options.database, household.id, request.params.listId, request.params.entryId))) {
        return notFound(reply, "Entry");
      }
      const ifMatch = requirePrecondition(request, reply, "if-match");
      if (!ifMatch) return;
      const result = await options.database.db.transaction(async (transaction) => {
        const list = await lockList(transaction, household.id, request.params.listId);
        if (!list) return { kind: "missing" } as const;
        const [current] = await transaction
          .select()
          .from(entries)
          .where(and(eq(entries.id, request.params.entryId), eq(entries.listId, list.id)))
          .limit(1);
        if (!current) return { kind: "missing" } as const;
        if (ifMatch !== entryEtag(current)) return { kind: "stale" } as const;
        const updates = entryPatchValues(request.body);
        const [updated] = await transaction
          .update(entries)
          .set({
            ...updates,
            revision: current.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(entries.id, current.id))
          .returning();
        await bumpEntriesRevision(transaction, list.id);
        return { kind: "ok", entry: updated! } as const;
      });

      if (result.kind === "missing") return notFound(reply, "Entry");
      if (result.kind === "stale") return preconditionFailed(reply);
      reply.header("etag", entryEtag(result.entry));
      return toEntryView(result.entry);
    },
  );

  routes.delete(
    "/api/v1/lists/:listId/entries/:entryId",
    {
      preHandler: mutateMember,
      schema: {
        tags: ["entries"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        params: entryParamsSchema,
        response: {
          204: emptyResponseSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          412: problemSchema,
          428: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const household = await getHousehold(options.database);
      if (!(await findEntry(options.database, household.id, request.params.listId, request.params.entryId))) {
        return notFound(reply, "Entry");
      }
      const ifMatch = requirePrecondition(request, reply, "if-match");
      if (!ifMatch) return;
      const result = await options.database.db.transaction(async (transaction) => {
        const list = await lockList(transaction, household.id, request.params.listId);
        if (!list) return "missing" as const;
        const ordered = await transaction
          .select()
          .from(entries)
          .where(eq(entries.listId, list.id))
          .orderBy(entries.position, entries.id);
        const existing = ordered.find((entry) => entry.id === request.params.entryId);
        if (!existing) return "missing" as const;
        if (ifMatch !== entryEtag(existing)) return "stale" as const;
        await transaction.delete(entries).where(eq(entries.id, existing.id));
        await writeEntryPositions(transaction, ordered.filter((entry) => entry.id !== existing.id).map((entry) => entry.id));
        await bumpEntriesRevision(transaction, list.id);
        return "deleted" as const;
      });

      if (result === "missing") return notFound(reply, "Entry");
      if (result === "stale") return preconditionFailed(reply);
      return reply.code(204).send(null);
    },
  );

  routes.post(
    "/api/v1/lists/:listId/entries/:entryId/move",
    {
      preHandler: mutateMember,
      schema: {
        tags: ["entries"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        params: entryParamsSchema,
        body: moveBodySchema,
        response: {
          200: entryViewSchema,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          412: problemSchema,
          422: problemSchema,
          428: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const household = await getHousehold(options.database);
      if (!(await findEntry(options.database, household.id, request.params.listId, request.params.entryId))) {
        return notFound(reply, "Entry");
      }
      const ifMatch = requirePrecondition(request, reply, "if-match");
      if (!ifMatch) return;
      const placement = parsePlacement(request.body, reply);
      if (!placement) return;
      const result = await options.database.db.transaction(async (transaction) => {
        const list = await lockList(transaction, household.id, request.params.listId);
        if (!list) return { kind: "missing" } as const;
        const ordered = await transaction
          .select()
          .from(entries)
          .where(eq(entries.listId, list.id))
          .orderBy(entries.position, entries.id);
        const moved = ordered.find((entry) => entry.id === request.params.entryId);
        if (!moved) return { kind: "missing" } as const;
        if (ifMatch !== entriesCollectionEtag(list.id, list.entriesRevision)) {
          return { kind: "stale" } as const;
        }
        const reordered = reorderIds(ordered.map((entry) => entry.id), moved.id, placement);
        if (!reordered) return { kind: "invalid" } as const;
        if (reordered === "missing-anchor") return { kind: "missing-anchor" } as const;
        if (!sameOrder(reordered, ordered.map((entry) => entry.id))) {
          await writeEntryPositions(transaction, reordered);
          await bumpEntriesRevision(transaction, list.id);
        }
        return { kind: "ok", entry: moved } as const;
      });

      if (result.kind === "missing") return notFound(reply, "Entry");
      if (result.kind === "stale") return preconditionFailed(reply);
      if (result.kind === "missing-anchor") return notFound(reply, "Entry anchor");
      if (result.kind === "invalid") return badRequest(reply, "An Entry cannot be moved before or after itself.");
      reply.header("etag", entryEtag(result.entry));
      return toEntryView(result.entry);
    },
  );

  routes.get(
    "/api/v1/board-posts",
    {
      preHandler: readMember,
      schema: {
        tags: ["board-posts"],
        security: [{ sessionCookie: [] }],
        querystring: boardQuerySchema,
        response: { 200: cursorPageSchema, 401: problemSchema, 422: problemSchema },
      },
    },
    async (request, reply) => {
      const household = await getHousehold(options.database);
      const predicates = [eq(boardPosts.householdId, household.id)];
      if (request.query.cursor) {
        const cursor = request.query.cursor;
        predicates.push(
          or(
            sql`${boardPosts.createdAt} < ${cursor.createdAt}::timestamptz`,
            and(
              sql`${boardPosts.createdAt} = ${cursor.createdAt}::timestamptz`,
              lt(boardPosts.id, cursor.id),
            ),
          )!,
        );
      }
      const rows = await options.database.db
        .select({
          post: boardPosts,
          author: members,
          cursorCreatedAt: sql<string>`to_char(${boardPosts.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(boardPosts)
        .innerJoin(members, eq(boardPosts.authorMemberId, members.id))
        .where(and(...predicates))
        .orderBy(desc(boardPosts.createdAt), desc(boardPosts.id))
        .limit(request.query.limit + 1);
      const hasMore = rows.length > request.query.limit;
      const pageRows = hasMore ? rows.slice(0, request.query.limit) : rows;
      const last = pageRows.at(-1)?.post;

      const page = {
        items: pageRows.map(({ post, author }) => toBoardPostView(post, author)),
        nextCursor: hasMore && last ? encodeCursor(pageRows.at(-1)!.cursorCreatedAt, last.id) : null,
      };
      reply.header("etag", boardPageEtag(page));
      return page;
    },
  );

  routes.post(
    "/api/v1/board-posts",
    {
      preHandler: mutateMember,
      schema: {
        tags: ["board-posts"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        body: boardPostBodySchema,
        response: {
          201: boardPostViewSchema,
          401: problemSchema,
          403: problemSchema,
          422: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const household = await getHousehold(options.database);
      const [created] = await options.database.db
        .insert(boardPosts)
        .values({
          id: randomUUID(),
          householdId: household.id,
          authorMemberId: request.authMember!.id,
          message: request.body.message,
        })
        .returning();
      const author = await getMember(options.database, request.authMember!.id);
      reply.header("location", `/api/v1/board-posts/${created!.id}`);
      reply.header("etag", boardPostEtag(created!));
      return reply.code(201).send(toBoardPostView(created!, author));
    },
  );

  routes.get(
    "/api/v1/board-posts/:postId",
    {
      preHandler: readMember,
      schema: {
        tags: ["board-posts"],
        security: [{ sessionCookie: [] }],
        params: boardPostParamsSchema,
        response: {
          200: boardPostViewSchema,
          401: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const household = await getHousehold(options.database);
      const found = await findBoardPost(options.database, household.id, request.params.postId);
      if (!found) return notFound(reply, "Board Post");
      reply.header("etag", boardPostEtag(found.post));
      return toBoardPostView(found.post, found.author);
    },
  );

  routes.patch(
    "/api/v1/board-posts/:postId",
    {
      preHandler: mutateMember,
      schema: {
        tags: ["board-posts"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        params: boardPostParamsSchema,
        body: boardPostPatchSchema,
        response: {
          200: boardPostViewSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          412: problemSchema,
          422: problemSchema,
          428: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const household = await getHousehold(options.database);
      const found = await findBoardPost(options.database, household.id, request.params.postId);
      if (!found) return notFound(reply, "Board Post");
      if (found.post.authorMemberId !== request.authMember!.id) return forbidden(reply);
      const ifMatch = requirePrecondition(request, reply, "if-match");
      if (!ifMatch) return;

      const result = await options.database.db.transaction(async (transaction) => {
        const [post] = await transaction
          .select()
          .from(boardPosts)
          .where(and(eq(boardPosts.id, request.params.postId), eq(boardPosts.householdId, household.id)))
          .for("update")
          .limit(1);
        if (!post) return { kind: "missing" } as const;
        if (post.authorMemberId !== request.authMember!.id) return { kind: "forbidden" } as const;
        if (ifMatch !== boardPostEtag(post)) return { kind: "stale" } as const;
        if (request.body.message === post.message) return { kind: "ok", post } as const;
        const [updated] = await transaction
          .update(boardPosts)
          .set({
            message: request.body.message,
            revision: post.revision + 1,
            updatedAt: new Date(),
          })
          .where(eq(boardPosts.id, post.id))
          .returning();
        return { kind: "ok", post: updated! } as const;
      });

      if (result.kind === "missing") return notFound(reply, "Board Post");
      if (result.kind === "forbidden") return forbidden(reply);
      if (result.kind === "stale") return preconditionFailed(reply);
      const author = await getMember(options.database, result.post.authorMemberId);
      reply.header("etag", boardPostEtag(result.post));
      return toBoardPostView(result.post, author);
    },
  );

  routes.delete(
    "/api/v1/board-posts/:postId",
    {
      preHandler: mutateMember,
      schema: {
        tags: ["board-posts"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        params: boardPostParamsSchema,
        response: {
          204: emptyResponseSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          412: problemSchema,
          428: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const household = await getHousehold(options.database);
      const found = await findBoardPost(options.database, household.id, request.params.postId);
      if (!found) return notFound(reply, "Board Post");
      if (
        found.post.authorMemberId !== request.authMember!.id &&
        request.authMember!.role !== "admin"
      ) {
        return forbidden(reply);
      }
      const ifMatch = requirePrecondition(request, reply, "if-match");
      if (!ifMatch) return;

      const result = await options.database.db.transaction(async (transaction) => {
        const [post] = await transaction
          .select()
          .from(boardPosts)
          .where(and(eq(boardPosts.id, request.params.postId), eq(boardPosts.householdId, household.id)))
          .for("update")
          .limit(1);
        if (!post) return "missing" as const;
        if (
          post.authorMemberId !== request.authMember!.id &&
          request.authMember!.role !== "admin"
        ) {
          return "forbidden" as const;
        }
        if (ifMatch !== boardPostEtag(post)) return "stale" as const;
        await transaction.delete(boardPosts).where(eq(boardPosts.id, post.id));
        return "deleted" as const;
      });

      if (result === "missing") return notFound(reply, "Board Post");
      if (result === "forbidden") return forbidden(reply);
      if (result === "stale") return preconditionFailed(reply);
      return reply.code(204).send(null);
    },
  );
}

function validateQuantity(
  quantity: string | null | undefined,
  context: z.RefinementCtx,
): void {
  if (quantity !== undefined && quantity !== null && !/^\d+(?:\.\d{1,3})?$/.test(quantity)) {
    context.addIssue({
      code: "custom",
      path: ["quantity"],
      message: "Quantity must be a positive decimal string with at most three fractional digits.",
    });
  } else if (quantity !== undefined && quantity !== null) {
    const integerDigits = quantity.split(".", 1)[0]!;
    if (integerDigits.length > 131072) {
      context.addIssue({
        code: "custom",
        path: ["quantity"],
        message: "Quantity exceeds the supported decimal precision.",
      });
    } else if (Number(quantity) <= 0) {
      context.addIssue({
        code: "custom",
        path: ["quantity"],
        message: "Quantity must be greater than zero.",
      });
    }
  }
}

function entryPatchValues(
  body: z.infer<typeof patchEntryBodySchema>,
): Partial<typeof entries.$inferInsert> {
  const values: Partial<typeof entries.$inferInsert> = {};
  if (body.title !== undefined) values.title = body.title;
  if (body.quantity !== undefined || Object.hasOwn(body, "quantity")) values.quantity = body.quantity ?? null;
  if (body.unit !== undefined || Object.hasOwn(body, "unit")) values.unit = body.unit ?? null;
  if (body.note !== undefined || Object.hasOwn(body, "note")) values.note = body.note ?? null;
  if (body.dueDate !== undefined || Object.hasOwn(body, "dueDate")) values.dueDate = body.dueDate ?? null;
  if (body.completed !== undefined) values.completed = body.completed;
  return values;
}

function parsePlacement(
  body: z.infer<typeof moveBodySchema>,
  reply: FastifyReply,
): Placement | undefined {
  const anchors = [
    body.beforeId ? { beforeId: body.beforeId } : undefined,
    body.afterId ? { afterId: body.afterId } : undefined,
    body.atEnd ? { atEnd: true as const } : undefined,
  ].filter((value) => value !== undefined);

  if (anchors.length !== 1) {
    badRequest(reply, "Specify exactly one of beforeId, afterId, or atEnd: true.");
    return undefined;
  }
  return anchors[0]!;
}

type Placement =
  | { beforeId: string }
  | { afterId: string }
  | { atEnd: true };

function reorderIds(
  orderedIds: string[],
  movingId: string,
  placement: Placement,
): string[] | "missing-anchor" | undefined {
  const remaining = orderedIds.filter((id) => id !== movingId);
  let targetIndex = remaining.length;
  if ("beforeId" in placement) {
    if (placement.beforeId === movingId) return undefined;
    targetIndex = remaining.indexOf(placement.beforeId);
    if (targetIndex === -1) return "missing-anchor";
  } else if ("afterId" in placement) {
    if (placement.afterId === movingId) return undefined;
    const anchorIndex = remaining.indexOf(placement.afterId);
    if (anchorIndex === -1) return "missing-anchor";
    targetIndex = anchorIndex + 1;
  }

  remaining.splice(targetIndex, 0, movingId);
  return remaining;
}

function sameOrder(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((id, index) => id === second[index]);
}

function toListView(list: typeof lists.$inferSelect) {
  return {
    id: list.id,
    name: list.name,
    revision: list.revision,
    createdAt: list.createdAt.toISOString(),
    updatedAt: list.updatedAt.toISOString(),
  };
}

function toEntryView(entry: typeof entries.$inferSelect) {
  return {
    id: entry.id,
    listId: entry.listId,
    title: entry.title,
    quantity: entry.quantity,
    unit: entry.unit,
    note: entry.note,
    dueDate: entry.dueDate,
    completed: entry.completed,
    revision: entry.revision,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

function toBoardPostView(
  post: typeof boardPosts.$inferSelect,
  author: typeof members.$inferSelect | MemberView,
) {
  return {
    id: post.id,
    author: { id: author.id, email: author.email },
    message: post.message,
    revision: post.revision,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt?.toISOString() ?? null,
  };
}

function listCollectionEtag(householdId: string, revision: number): string {
  return `"lists:${householdId}:${revision}"`;
}

function listEtag(list: typeof lists.$inferSelect, entriesRevision: number): string {
  return `"list:${list.id}:${list.revision}:${entriesRevision}"`;
}

function entriesCollectionEtag(listId: string, revision: number): string {
  return `"entries:${listId}:${revision}"`;
}

function entryEtag(entry: typeof entries.$inferSelect): string {
  return `"entry:${entry.id}:${entry.revision}"`;
}

function boardPostEtag(post: typeof boardPosts.$inferSelect): string {
  return `"board-post:${post.id}:${post.revision}"`;
}

function requirePrecondition(
  request: FastifyRequest,
  reply: FastifyReply,
  headerName: string,
): string | undefined {
  const value = request.headers[headerName];
  if (typeof value !== "string" || !value.trim()) {
    reply.code(428).send(problemBody(
      428,
      "precondition-required",
      "Precondition Required",
      `The ${headerName} header is required.`,
    ));
    return undefined;
  }
  return value.trim();
}

function preconditionFailed(reply: FastifyReply) {
  return reply.code(412).send(problemBody(
    412,
    "precondition-failed",
    "Precondition Failed",
    "The supplied ETag is stale.",
  ));
}

function badRequest(reply: FastifyReply, detail: string) {
  return reply.code(400).send(problemBody(400, "validation", "Bad Request", detail));
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).send(problemBody(
    403,
    "forbidden",
    "Forbidden",
    "You are not allowed to perform this action.",
  ));
}

function notFound(reply: FastifyReply, resource: string) {
  return reply.code(404).send(problemBody(
    404,
    "not-found",
    "Not Found",
    `${resource} was not found.`,
  ));
}

async function getHousehold(database: DatabaseConnection) {
  const [household] = await database.db.select().from(households).limit(1);
  if (!household) throw new Error("Household bootstrap has not completed.");
  return household;
}

async function lockHousehold(transaction: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0]) {
  const [household] = await transaction.select().from(households).for("update").limit(1);
  if (!household) throw new Error("Household bootstrap has not completed.");
  return household;
}

async function lockList(
  transaction: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  householdId: string,
  listId: string,
) {
  const [list] = await transaction
    .select()
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.householdId, householdId)))
    .for("update")
    .limit(1);
  return list;
}

async function findList(database: DatabaseConnection, householdId: string, listId: string) {
  const [list] = await database.db
    .select()
    .from(lists)
    .where(and(eq(lists.id, listId), eq(lists.householdId, householdId)))
    .limit(1);
  return list;
}

async function findEntry(
  database: DatabaseConnection,
  householdId: string,
  listId: string,
  entryId: string,
) {
  const [entry] = await database.db
    .select({ entry: entries })
    .from(entries)
    .innerJoin(lists, eq(entries.listId, lists.id))
    .where(
      and(
        eq(lists.householdId, householdId),
        eq(entries.listId, listId),
        eq(entries.id, entryId),
      ),
    )
    .limit(1);
  return entry?.entry;
}

async function findBoardPost(database: DatabaseConnection, householdId: string, postId: string) {
  const [found] = await database.db
    .select({ post: boardPosts, author: members })
    .from(boardPosts)
    .innerJoin(members, eq(boardPosts.authorMemberId, members.id))
    .where(and(eq(boardPosts.householdId, householdId), eq(boardPosts.id, postId)))
    .limit(1);
  return found;
}

async function getMember(database: DatabaseConnection, memberId: string) {
  const [member] = await database.db.select().from(members).where(eq(members.id, memberId)).limit(1);
  if (!member) throw new Error("Board Post author no longer exists.");
  return member;
}

async function bumpHouseholdListsRevision(
  transaction: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  householdId: string,
): Promise<void> {
  await transaction
    .update(households)
    .set({ listsRevision: sql`${households.listsRevision} + 1` })
    .where(eq(households.id, householdId));
}

async function bumpEntriesRevision(
  transaction: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  listId: string,
): Promise<void> {
  await transaction
    .update(lists)
    .set({ entriesRevision: sql`${lists.entriesRevision} + 1` })
    .where(eq(lists.id, listId));
}

async function compactListPositions(
  transaction: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  householdId: string,
): Promise<void> {
  const ordered = await transaction
    .select({ id: lists.id })
    .from(lists)
    .where(eq(lists.householdId, householdId))
    .orderBy(lists.position, lists.id);
  await writeListPositions(transaction, ordered.map((list) => list.id));
}

async function writeListPositions(
  transaction: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  ids: string[],
): Promise<void> {
  await writePositions(ids, async (id, position) => {
    await transaction.update(lists).set({ position }).where(eq(lists.id, id));
  });
}

async function writeEntryPositions(
  transaction: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  ids: string[],
): Promise<void> {
  await writePositions(ids, async (id, position) => {
    await transaction.update(entries).set({ position }).where(eq(entries.id, id));
  });
}

async function writePositions(
  ids: string[],
  updatePosition: (id: string, position: number) => Promise<void>,
): Promise<void> {
  for (const [position, id] of ids.entries()) {
    await updatePosition(id, position);
  }
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString("base64url");
}

function boardPageEtag(page: { items: unknown[]; nextCursor: string | null }): string {
  const digest = createHash("sha256").update(JSON.stringify(page)).digest("base64url");
  return `"board-posts:${digest}"`;
}
