import { randomBytes } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { runMigrations } from "../src/database/migrations.js";

describe("Household organization", () => {
  let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
  let controlPool: Pool;
  let app: Awaited<ReturnType<typeof createApp>>;
  let admin: { cookie: string; csrfToken: string };
  const sessionSecret = randomBytes(32).toString("hex");
  const adminPassword = randomBytes(32).toString("base64url");

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    await runMigrations(container.getConnectionUri());
    controlPool = new Pool({ connectionString: container.getConnectionUri() });
  });

  beforeEach(async () => {
    await controlPool.query("TRUNCATE sessions, members, households CASCADE");
    app = await createApp({
      bootstrapAdmin: { email: "admin@example.com", password: adminPassword },
      databaseUrl: container.getConnectionUri(),
      logLevel: "silent",
      sessionSecret,
    });
    admin = await login(app, adminPassword);
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(async () => {
    await controlPool?.end();
    await container?.stop();
  });

  it("returns an empty ordered List collection with a strong ETag", async () => {
    const unauthenticated = await app.inject({ method: "GET", url: "/api/v1/lists" });
    expect(unauthenticated.statusCode).toBe(401);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/lists",
      headers: { cookie: admin.cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(response.headers.etag).toMatch(/^"lists:[^"]+:\d+"$/);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("creates shared Lists and protects their content and order with separate ETags", async () => {
    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/lists",
      headers: { cookie: admin.cookie },
      payload: { name: "Shared" },
    });
    expect(missingCsrf.statusCode).toBe(403);

    const first = await createList(app, admin, " Pantry ");
    const duplicateName = await createList(app, admin, "Pantry");
    expect(first.statusCode).toBe(201);
    expect(first.headers.location).toBe(`/api/v1/lists/${first.json().id}`);
    expect(first.json().name).toBe("Pantry");
    expect(duplicateName.statusCode).toBe(201);

    const firstList = first.json();
    const secondList = duplicateName.json();
    const collection = await app.inject({
      method: "GET",
      url: "/api/v1/lists",
      headers: { cookie: admin.cookie },
    });
    expect(collection.json().map((list: { id: string }) => list.id)).toEqual([
      firstList.id,
      secondList.id,
    ]);

    const blankName = await createList(app, admin, " \t ");
    expect(blankName.statusCode).toBe(422);
    const missingPrecondition = await app.inject({
      method: "PATCH",
      url: `/api/v1/lists/${firstList.id}`,
      headers: mutationHeaders(admin),
      payload: { name: "Kitchen" },
    });
    expect(missingPrecondition.statusCode).toBe(428);

    const firstRead = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${firstList.id}`,
      headers: { cookie: admin.cookie },
    });
    const rename = await app.inject({
      method: "PATCH",
      url: `/api/v1/lists/${firstList.id}`,
      headers: mutationHeaders(admin, { "if-match": firstRead.headers.etag! }),
      payload: { name: "Kitchen" },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().revision).toBe(firstList.revision + 1);
    const renamedCollection = await app.inject({
      method: "GET",
      url: "/api/v1/lists",
      headers: { cookie: admin.cookie },
    });
    expect(renamedCollection.headers.etag).not.toBe(collection.headers.etag);

    const staleRename = await app.inject({
      method: "PATCH",
      url: `/api/v1/lists/${firstList.id}`,
      headers: mutationHeaders(admin, { "if-match": firstRead.headers.etag! }),
      payload: { name: "Stale" },
    });
    expect(staleRename.statusCode).toBe(412);

    const moved = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${secondList.id}/move`,
      headers: mutationHeaders(admin, { "if-match": renamedCollection.headers.etag! }),
      payload: { beforeId: firstList.id },
    });
    expect(moved.statusCode).toBe(200);
    const reordered = await app.inject({
      method: "GET",
      url: "/api/v1/lists",
      headers: { cookie: admin.cookie },
    });
    expect(reordered.json().map((list: { id: string }) => list.id)).toEqual([
      secondList.id,
      firstList.id,
    ]);

    const selfMove = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${secondList.id}/move`,
      headers: mutationHeaders(admin, { "if-match": reordered.headers.etag! }),
      payload: { afterId: secondList.id },
    });
    expect(selfMove.statusCode).toBe(400);
    const mutuallyExclusiveAnchors = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${secondList.id}/move`,
      headers: mutationHeaders(admin, { "if-match": reordered.headers.etag! }),
      payload: { beforeId: firstList.id, atEnd: true },
    });
    expect(mutuallyExclusiveAnchors.statusCode).toBe(400);
  });

  it("validates Entry fields, preserves omitted values, and invalidates aggregate ETags", async () => {
    const list = await createList(app, admin, "Tasks");
    const listId = list.json().id as string;
    const created = await createEntry(app, admin, listId, {
      title: "  Buy tea ",
      quantity: " ",
      unit: " ",
      note: "",
      dueDate: "2000-02-29",
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe(
      `/api/v1/lists/${listId}/entries/${created.json().id}`,
    );
    expect(created.json()).toMatchObject({
      title: "Buy tea",
      quantity: null,
      unit: null,
      note: null,
      dueDate: "2000-02-29",
      completed: false,
    });
    const entry = created.json();

    const aggregateBefore = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}`,
      headers: { cookie: admin.cookie },
    });
    const entryRead = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}/entries/${entry.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(entryRead.headers.etag).toMatch(/^"entry:[^"]+:\d+"$/);

    const completed = await app.inject({
      method: "PATCH",
      url: `/api/v1/lists/${listId}/entries/${entry.id}`,
      headers: mutationHeaders(admin, { "if-match": entryRead.headers.etag! }),
      payload: { completed: true },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      title: "Buy tea",
      dueDate: "2000-02-29",
      completed: true,
    });

    const aggregateAfter = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}`,
      headers: { cookie: admin.cookie },
    });
    expect(aggregateAfter.headers.etag).not.toBe(aggregateBefore.headers.etag);
    expect(aggregateAfter.json().entries).toHaveLength(1);

    const stalePatch = await app.inject({
      method: "PATCH",
      url: `/api/v1/lists/${listId}/entries/${entry.id}`,
      headers: mutationHeaders(admin, { "if-match": entryRead.headers.etag! }),
      payload: { completed: false },
    });
    expect(stalePatch.statusCode).toBe(412);

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/v1/lists/${listId}/entries/${entry.id}`,
      headers: mutationHeaders(admin, { "if-match": completed.headers.etag! }),
      payload: { quantity: "2.125", unit: " box ", note: " store-brand ", dueDate: null, completed: false },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      quantity: "2.125",
      unit: "box",
      note: "store-brand",
      dueDate: null,
      completed: false,
    });

    const invalidQuantity = await createEntry(app, admin, listId, {
      title: "Invalid quantity",
      quantity: "0.000",
    });
    const invalidDate = await createEntry(app, admin, listId, {
      title: "Invalid date",
      dueDate: "2025-02-29",
    });
    expect(invalidQuantity.statusCode).toBe(422);
    expect(invalidQuantity.json().errors.quantity).toEqual(expect.any(Array));
    expect(invalidDate.statusCode).toBe(422);

    const latestEntry = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}/entries/${entry.id}`,
      headers: { cookie: admin.cookie },
    });
    const missingDeletePrecondition = await app.inject({
      method: "DELETE",
      url: `/api/v1/lists/${listId}/entries/${entry.id}`,
      headers: mutationHeaders(admin),
    });
    const staleDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/lists/${listId}/entries/${entry.id}`,
      headers: mutationHeaders(admin, { "if-match": entryRead.headers.etag! }),
    });
    expect(missingDeletePrecondition.statusCode).toBe(428);
    expect(staleDelete.statusCode).toBe(412);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/lists/${listId}/entries/${entry.id}`,
      headers: mutationHeaders(admin, { "if-match": latestEntry.headers.etag! }),
    });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}/entries/${entry.id}`,
      headers: { cookie: admin.cookie },
    })).statusCode).toBe(404);
  });

  it("moves Entries only within their List and rejects stale collection state", async () => {
    const firstList = await createList(app, admin, "First");
    const secondList = await createList(app, admin, "Second");
    const firstId = firstList.json().id as string;
    const secondId = secondList.json().id as string;
    const firstEntry = await createEntry(app, admin, firstId, { title: "Same title" });
    const secondEntry = await createEntry(app, admin, firstId, { title: "Same title" });
    const foreignEntry = await createEntry(app, admin, secondId, { title: "Foreign entry" });
    const collection = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${firstId}/entries`,
      headers: { cookie: admin.cookie },
    });

    const moved = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${firstId}/entries/${secondEntry.json().id}/move`,
      headers: mutationHeaders(admin, { "if-match": collection.headers.etag! }),
      payload: { beforeId: firstEntry.json().id },
    });
    expect(moved.statusCode).toBe(200);

    const staleMove = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${firstId}/entries/${secondEntry.json().id}/move`,
      headers: mutationHeaders(admin, { "if-match": collection.headers.etag! }),
      payload: { atEnd: true },
    });
    expect(staleMove.statusCode).toBe(412);

    const currentCollection = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${firstId}/entries`,
      headers: { cookie: admin.cookie },
    });
    const crossListAnchor = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${firstId}/entries/${firstEntry.json().id}/move`,
      headers: mutationHeaders(admin, { "if-match": currentCollection.headers.etag! }),
      payload: { beforeId: foreignEntry.json().id },
    });
    expect(crossListAnchor.statusCode).toBe(404);
    const unchangedOrder = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${firstId}/entries`,
      headers: { cookie: admin.cookie },
    });
    expect(unchangedOrder.json().map((entry: { id: string }) => entry.id)).toEqual([
      secondEntry.json().id,
      firstEntry.json().id,
    ]);
    const movedToEnd = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${firstId}/entries/${secondEntry.json().id}/move`,
      headers: mutationHeaders(admin, { "if-match": currentCollection.headers.etag! }),
      payload: { atEnd: true },
    });
    expect(movedToEnd.statusCode).toBe(200);

    const latestCollection = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${firstId}/entries`,
      headers: { cookie: admin.cookie },
    });
    const selfAnchor = await app.inject({
      method: "POST",
      url: `/api/v1/lists/${firstId}/entries/${firstEntry.json().id}/move`,
      headers: mutationHeaders(admin, { "if-match": latestCollection.headers.etag! }),
      payload: { afterId: firstEntry.json().id },
    });
    expect(selfAnchor.statusCode).toBe(400);
  });

  it("allows only one concurrent List edit from a shared revision", async () => {
    const created = await createList(app, admin, "Concurrent");
    const listId = created.json().id as string;
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}`,
      headers: { cookie: admin.cookie },
    });
    const updates = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/v1/lists/${listId}`,
        headers: mutationHeaders(admin, { "if-match": read.headers.etag! }),
        payload: { name: "Concurrent A" },
      }),
      app.inject({
        method: "PATCH",
        url: `/api/v1/lists/${listId}`,
        headers: mutationHeaders(admin, { "if-match": read.headers.etag! }),
        payload: { name: "Concurrent B" },
      }),
    ]);

    expect(updates.map((response) => response.statusCode).sort()).toEqual([200, 412]);
    const latest = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}`,
      headers: { cookie: admin.cookie },
    });
    expect(latest.json().revision).toBe(2);
    expect(["Concurrent A", "Concurrent B"]).toContain(latest.json().name);
  });

  it("rejects malformed Board Post cursors and publishes the new OpenAPI paths", async () => {
    const malformedCursor = await app.inject({
      method: "GET",
      url: "/api/v1/board-posts?cursor=not-a-cursor",
      headers: { cookie: admin.cookie },
    });
    const repeatedLimit = await app.inject({
      method: "GET",
      url: "/api/v1/board-posts?limit=1&limit=2",
      headers: { cookie: admin.cookie },
    });
    expect(malformedCursor.statusCode).toBe(422);
    expect(repeatedLimit.statusCode).toBe(422);

    const openApiResponse = await app.inject({ method: "GET", url: "/openapi.json" });
    const document = openApiResponse.json();
    expect(document.openapi).toMatch(/^3\./);
    expect(document.paths["/api/v1/lists"].get).toBeDefined();
    expect(document.paths["/api/v1/lists/{listId}/entries/{entryId}/move"].post).toBeDefined();
    expect(document.paths["/api/v1/board-posts"].get).toBeDefined();
    expect(document.paths["/api/v1/lists/{listId}"].delete.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "if-match", in: "header", required: true }),
        expect.objectContaining({ name: "if-entries-match", in: "header", required: true }),
      ]),
    );
    expect(document.paths["/api/v1/lists"].get.responses["200"].headers.ETag.schema.type).toBe("string");
    expect(document.components.securitySchemes.sessionCookie).toMatchObject({
      type: "apiKey",
      in: "cookie",
    });
    expect(document.components.securitySchemes.csrfToken).toMatchObject({
      type: "apiKey",
      in: "header",
    });
    expect(document.paths["/api/v1/board-posts"].get.responses["200"].headers.ETag.schema.type).toBe("string");
  });

  it("requires both current deletion ETags and cascades atomically", async () => {
    const list = await createList(app, admin, "Delete me");
    const listId = list.json().id as string;
    const entry = await createEntry(app, admin, listId, { title: "Cascade me" });
    const readList = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}`,
      headers: { cookie: admin.cookie },
    });
    const readEntries = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}/entries`,
      headers: { cookie: admin.cookie },
    });

    const missingConditions = await app.inject({
      method: "DELETE",
      url: `/api/v1/lists/${listId}`,
      headers: mutationHeaders(admin),
    });
    expect(missingConditions.statusCode).toBe(428);

    const staleEntries = await app.inject({
      method: "DELETE",
      url: `/api/v1/lists/${listId}`,
      headers: mutationHeaders(admin, {
        "if-match": readList.headers.etag!,
        "if-entries-match": '"entries:stale:1"',
      }),
    });
    expect(staleEntries.statusCode).toBe(412);
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}/entries/${entry.json().id}`,
      headers: { cookie: admin.cookie },
    })).statusCode).toBe(200);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/lists/${listId}`,
      headers: mutationHeaders(admin, {
        "if-match": readList.headers.etag!,
        "if-entries-match": readEntries.headers.etag!,
      }),
    });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({
      method: "GET",
      url: `/api/v1/lists/${listId}`,
      headers: { cookie: admin.cookie },
    })).statusCode).toBe(404);
    const remainingEntries = await controlPool.query(
      "SELECT count(*)::int AS count FROM entries WHERE list_id = $1",
      [listId],
    );
    expect(remainingEntries.rows[0].count).toBe(0);
  });

  it("enforces Board Post authorship, admin moderation, and stable cursor traversal", async () => {
    const memberPassword = randomBytes(32).toString("base64url");
    const memberCreated = await app.inject({
      method: "POST",
      url: "/api/v1/members",
      headers: mutationHeaders(admin),
      payload: { email: "member@example.com", password: memberPassword },
    });
    expect(memberCreated.statusCode).toBe(201);
    const member = await login(app, memberPassword, "member@example.com");

    const sharedList = await createList(app, admin, "Shared");
    const sharedListId = sharedList.json().id as string;
    const sharedEntry = await createEntry(app, admin, sharedListId, { title: "Shared Entry" });
    const sharedEntryRead = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${sharedListId}/entries/${sharedEntry.json().id}`,
      headers: { cookie: member.cookie },
    });
    const sharedEntryEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/lists/${sharedListId}/entries/${sharedEntry.json().id}`,
      headers: mutationHeaders(member, { "if-match": sharedEntryRead.headers.etag! }),
      payload: { completed: true },
    });
    expect(sharedEntryEdit.statusCode).toBe(200);
    expect(sharedEntryEdit.json().completed).toBe(true);
    const sharedListRead = await app.inject({
      method: "GET",
      url: `/api/v1/lists/${sharedListId}`,
      headers: { cookie: member.cookie },
    });
    const sharedRename = await app.inject({
      method: "PATCH",
      url: `/api/v1/lists/${sharedListId}`,
      headers: mutationHeaders(member, { "if-match": sharedListRead.headers.etag! }),
      payload: { name: "Renamed by Member" },
    });
    expect(sharedRename.statusCode).toBe(200);

    const memberEditAdminPost = await createBoardPost(app, admin, "Admin post");
    const memberPostOne = await createBoardPost(app, member, "One");
    const memberPostTwo = await createBoardPost(app, member, "Two");
    const memberPostThree = await createBoardPost(app, member, "Three");
    expect(memberPostOne.statusCode).toBe(201);
    expect(memberPostOne.headers.location).toBe(`/api/v1/board-posts/${memberPostOne.json().id}`);
    const ownRead = await app.inject({
      method: "GET",
      url: `/api/v1/board-posts/${memberPostThree.json().id}`,
      headers: { cookie: member.cookie },
    });
    expect(ownRead.json().updatedAt).toBeNull();
    const ownEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/board-posts/${memberPostThree.json().id}`,
      headers: mutationHeaders(member, { "if-match": ownRead.headers.etag! }),
      payload: { message: "Edited by author" },
    });
    expect(ownEdit.statusCode).toBe(200);
    expect(ownEdit.json().createdAt).toBe(ownRead.json().createdAt);
    expect(ownEdit.json().updatedAt).not.toBeNull();
    const noOpEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/board-posts/${memberPostThree.json().id}`,
      headers: mutationHeaders(member, { "if-match": ownEdit.headers.etag! }),
      payload: { message: "Edited by author" },
    });
    expect(noOpEdit.headers.etag).toBe(ownEdit.headers.etag);
    expect(noOpEdit.json().updatedAt).toBe(ownEdit.json().updatedAt);

    const adminPostRead = await app.inject({
      method: "GET",
      url: `/api/v1/board-posts/${memberEditAdminPost.json().id}`,
      headers: { cookie: admin.cookie },
    });
    const forbiddenEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/board-posts/${memberEditAdminPost.json().id}`,
      headers: mutationHeaders(member, { "if-match": adminPostRead.headers.etag! }),
      payload: { message: "Impersonated author" },
    });
    expect(forbiddenEdit.statusCode).toBe(403);

    const adminDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/board-posts/${memberPostOne.json().id}`,
      headers: mutationHeaders(admin, { "if-match": memberPostOne.headers.etag! }),
    });
    expect(adminDelete.statusCode).toBe(204);

    const firstPage = await app.inject({
      method: "GET",
      url: "/api/v1/board-posts?limit=1",
      headers: { cookie: admin.cookie },
    });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.headers.etag).toMatch(/^"board-posts:[A-Za-z0-9_-]+"$/);
    expect(firstPage.json().items).toHaveLength(1);
    expect(firstPage.json().nextCursor).toEqual(expect.any(String));
    const newPost = await createBoardPost(app, member, "Created after first page");
    const refreshedFirstPage = await app.inject({
      method: "GET",
      url: "/api/v1/board-posts?limit=1",
      headers: { cookie: admin.cookie },
    });
    const secondPage = await app.inject({
      method: "GET",
      url: `/api/v1/board-posts?limit=1&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
      headers: { cookie: admin.cookie },
    });
    expect(secondPage.statusCode).toBe(200);
    expect(refreshedFirstPage.headers.etag).not.toBe(firstPage.headers.etag);
    expect(secondPage.json().items[0].id).toBe(memberPostTwo.json().id);
    expect(secondPage.json().items[0].id).not.toBe(newPost.json().id);

    const memberPostTwoRead = await app.inject({
      method: "GET",
      url: `/api/v1/board-posts/${memberPostTwo.json().id}`,
      headers: { cookie: member.cookie },
    });
    const memberDeleteOwnPost = await app.inject({
      method: "DELETE",
      url: `/api/v1/board-posts/${memberPostTwo.json().id}`,
      headers: mutationHeaders(member, { "if-match": memberPostTwoRead.headers.etag! }),
    });
    expect(memberDeleteOwnPost.statusCode).toBe(204);
  });

  it("preserves PostgreSQL microseconds across Board Post cursor pages", async () => {
    const posts = await Promise.all([
      createBoardPost(app, admin, "Microsecond one"),
      createBoardPost(app, admin, "Microsecond two"),
      createBoardPost(app, admin, "Microsecond three"),
    ]);
    const timestamps = [
      "2025-01-01T00:00:00.100001Z",
      "2025-01-01T00:00:00.100002Z",
      "2025-01-01T00:00:00.100003Z",
    ];
    for (const [index, response] of posts.entries()) {
      await controlPool.query(
        "UPDATE board_posts SET created_at = $1::timestamptz WHERE id = $2",
        [timestamps[index], response.json().id],
      );
    }

    const firstPage = await app.inject({
      method: "GET",
      url: "/api/v1/board-posts?limit=1",
      headers: { cookie: admin.cookie },
    });
    const secondPage = await app.inject({
      method: "GET",
      url: `/api/v1/board-posts?limit=1&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
      headers: { cookie: admin.cookie },
    });

    expect(firstPage.json().items[0].message).toBe("Microsecond three");
    expect(secondPage.json().items[0].message).toBe("Microsecond two");
  });
});

async function login(
  app: Awaited<ReturnType<typeof createApp>>,
  password: string,
  email = "admin@example.com",
): Promise<{ cookie: string; csrfToken: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/session",
    payload: { email, password },
  });
  const setCookie = response.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;

  if (!cookieHeader) {
    throw new Error("Test login did not set a session cookie.");
  }

  return {
    cookie: cookieHeader.split(";", 1)[0]!,
    csrfToken: response.json().csrfToken as string,
  };
}

function mutationHeaders(
  session: { cookie: string; csrfToken: string },
  additional: Record<string, string> = {},
): Record<string, string> {
  return {
    cookie: session.cookie,
    "x-csrf-token": session.csrfToken,
    ...additional,
  };
}

async function createList(
  app: Awaited<ReturnType<typeof createApp>>,
  session: { cookie: string; csrfToken: string },
  name: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/lists",
    headers: mutationHeaders(session),
    payload: { name },
  });
}

async function createEntry(
  app: Awaited<ReturnType<typeof createApp>>,
  session: { cookie: string; csrfToken: string },
  listId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/lists/${listId}/entries`,
    headers: mutationHeaders(session),
    payload,
  });
}

async function createBoardPost(
  app: Awaited<ReturnType<typeof createApp>>,
  session: { cookie: string; csrfToken: string },
  message: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/board-posts",
    headers: mutationHeaders(session),
    payload: { message },
  });
}
