import { randomBytes } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { runMigrations } from "../src/database/migrations.js";

describe("Member authentication", () => {
  let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
  let controlPool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    await runMigrations(container.getConnectionUri());
    controlPool = new Pool({ connectionString: container.getConnectionUri() });
  });

  beforeEach(async () => {
    await controlPool.query("TRUNCATE sessions, members, households CASCADE");
  });

  afterAll(async () => {
    await controlPool?.end();
    await container?.stop();
  });

  it("rejects an unauthenticated session read without caching it", async () => {
    const app = await createApp({ databaseUrl: container.getConnectionUri() });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/session",
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        type: "/api/v1/problems/unauthenticated",
        title: "Unauthenticated",
        status: 401,
      });
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("bootstraps the first Household Administrator and starts a persistent session", async () => {
    const password = randomBytes(32).toString("base64url");
    const app = await createApp({
      bootstrapAdmin: { email: "ADMIN@example.com", password },
      databaseUrl: container.getConnectionUri(),
      sessionSecret: "test-session-secret-with-at-least-32-bytes",
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: " admin@EXAMPLE.com ", password },
      });
      const body = response.json();
      const setCookieHeader = response.headers["set-cookie"];
      const setCookie = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;

      expect(response.statusCode).toBe(200);
      if (typeof setCookie !== "string") {
        throw new Error("Successful login did not set a session cookie.");
      }
      expect(body.member).toMatchObject({
        email: "admin@example.com",
        role: "admin",
      });
      expect(body.member.passwordHash).toBeUndefined();
      expect(body.csrfToken).toEqual(expect.any(String));
      expect(setCookie).toContain("__Host-homeorg_session=");
      expect(setCookie).toContain("Expires=Fri, 31 Dec 9999");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/");
      expect(response.headers["cache-control"]).toBe("no-store");

      const cookie = setCookie.split(";", 1)[0]!;
      const sessionResponse = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { cookie },
      });

      expect(sessionResponse.statusCode).toBe(200);
      expect(sessionResponse.json()).toEqual(body);
      expect(sessionResponse.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("does not reseed an existing Household and hides whether login email exists", async () => {
    const password = randomBytes(32).toString("base64url");
    const sessionSecret = randomBytes(32).toString("hex");
    const firstApp = await createApp({
      bootstrapAdmin: { email: "admin@example.com", password },
      databaseUrl: container.getConnectionUri(),
      sessionSecret,
    });

    await firstApp.close();
    const secondApp = await createApp({
      bootstrapAdmin: {
        email: "replacement@example.com",
        password: randomBytes(32).toString("base64url"),
      },
      databaseUrl: container.getConnectionUri(),
      sessionSecret,
    });

    try {
      const knownEmailFailure = await secondApp.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: " ADMIN@example.com ", password: "incorrect-password" },
      });
      const unknownEmailFailure = await secondApp.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: "unknown@example.com", password: "incorrect-password" },
      });
      const originalAdminLogin = await secondApp.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: "admin@example.com", password },
      });

      expect(knownEmailFailure.statusCode).toBe(401);
      expect(unknownEmailFailure.statusCode).toBe(401);
      expect(knownEmailFailure.json()).toEqual(unknownEmailFailure.json());
      expect(knownEmailFailure.json().detail).toBe("Email or password is incorrect.");
      expect(originalAdminLogin.statusCode).toBe(200);
    } finally {
      await secondApp.close();
    }
  });

  it("rate limits repeated failed logins by account and client IP", async () => {
    const password = randomBytes(32).toString("base64url");
    const app = await createApp({
      bootstrapAdmin: { email: "admin@example.com", password },
      databaseUrl: container.getConnectionUri(),
      sessionSecret: randomBytes(32).toString("hex"),
    });

    try {
      const responses = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        responses.push(
          await app.inject({
            method: "POST",
            url: "/api/v1/session",
            payload: { email: "admin@example.com", password: "wrong-password" },
          }),
        );
      }

      expect(responses.slice(0, 5).map((response) => response.statusCode)).toEqual([
        401, 401, 401, 401, 401,
      ]);
      expect(responses[5]?.statusCode).toBe(429);
      expect(responses[5]?.json()).toMatchObject({
        type: "/api/v1/problems/rate-limited",
        status: 429,
      });
      expect(responses[5]?.headers["retry-after"]).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("enforces independent account and client IP login limits", async () => {
    const password = randomBytes(32).toString("base64url");
    const app = await createApp({
      bootstrapAdmin: { email: "admin@example.com", password },
      databaseUrl: container.getConnectionUri(),
      sessionSecret: randomBytes(32).toString("hex"),
    });

    try {
      const sameIpResponses = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        sameIpResponses.push(
          await app.inject({
            method: "POST",
            url: "/api/v1/session",
            payload: {
              email: `unknown-${attempt}@example.com`,
              password: "wrong-password",
            },
          }),
        );
      }

      expect(sameIpResponses.slice(0, 5).every((response) => response.statusCode === 401)).toBe(true);
      expect(sameIpResponses[5]?.statusCode).toBe(429);

      const differentIpResponses = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        differentIpResponses.push(
          await app.inject({
            method: "POST",
            url: "/api/v1/session",
            headers: { "x-forwarded-for": `198.51.100.${attempt + 1}` },
            payload: { email: "admin@example.com", password: "wrong-password" },
          }),
        );
      }

      expect(differentIpResponses.slice(0, 5).every((response) => response.statusCode === 401)).toBe(true);
      expect(differentIpResponses[5]?.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("requires CSRF protection and logout invalidates only the current session", async () => {
    const password = randomBytes(32).toString("base64url");
    const sessionSecret = randomBytes(32).toString("hex");
    const app = await createApp({
      bootstrapAdmin: { email: "admin@example.com", password },
      databaseUrl: container.getConnectionUri(),
      sessionSecret,
    });
    let rotatedApp: Awaited<ReturnType<typeof createApp>> | undefined;

    try {
      const firstLogin = await app.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: "admin@example.com", password },
      });
      const secondLogin = await app.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: "admin@example.com", password },
      });
      const firstCookie = sessionCookie(firstLogin.headers["set-cookie"]);
      const secondCookie = sessionCookie(secondLogin.headers["set-cookie"]);
      const csrfToken = firstLogin.json().csrfToken as string;

      const rejectedLogout = await app.inject({
        method: "DELETE",
        url: "/api/v1/session",
        headers: { cookie: firstCookie },
      });
      expect(rejectedLogout.statusCode).toBe(403);

      const acceptedLogout = await app.inject({
        method: "DELETE",
        url: "/api/v1/session",
        headers: { cookie: firstCookie, "x-csrf-token": csrfToken },
      });
      expect(acceptedLogout.statusCode).toBe(204);
      expect(acceptedLogout.headers["set-cookie"]).toContain("Max-Age=0");

      const loggedOutSession = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { cookie: firstCookie },
      });
      const otherSession = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { cookie: secondCookie },
      });
      expect(loggedOutSession.statusCode).toBe(401);
      expect(otherSession.statusCode).toBe(200);

      rotatedApp = await createApp({
        databaseUrl: container.getConnectionUri(),
        sessionSecret: randomBytes(32).toString("hex"),
      });
      const oldSessionAfterSecretRotation = await rotatedApp.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { cookie: secondCookie },
      });
      expect(oldSessionAfterSecretRotation.statusCode).toBe(401);
    } finally {
      await rotatedApp?.close();
      await app.close();
    }
  });

  it("lets only a Household Administrator provision and list safe Member records", async () => {
    const adminPassword = randomBytes(32).toString("base64url");
    const memberPassword = randomBytes(32).toString("base64url");
    const app = await createApp({
      bootstrapAdmin: { email: "admin@example.com", password: adminPassword },
      databaseUrl: container.getConnectionUri(),
      sessionSecret: randomBytes(32).toString("hex"),
    });

    try {
      const adminLogin = await app.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: "admin@example.com", password: adminPassword },
      });
      const adminCookie = sessionCookie(adminLogin.headers["set-cookie"]);
      const csrfToken = adminLogin.json().csrfToken as string;
      const memberPayload = {
        email: "  HOUSEHOLD.MEMBER@example.com ",
        password: memberPassword,
      };

      const missingCsrf = await app.inject({
        method: "POST",
        url: "/api/v1/members",
        headers: { cookie: adminCookie },
        payload: memberPayload,
      });
      expect(missingCsrf.statusCode).toBe(403);

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/members",
        headers: { cookie: adminCookie, "x-csrf-token": csrfToken },
        payload: memberPayload,
      });
      const createdMember = created.json();

      expect(created.statusCode).toBe(201);
      expect(created.headers.location).toBe(`/api/v1/members/${createdMember.id}`);
      expect(createdMember).toMatchObject({
        email: "household.member@example.com",
        role: "member",
      });
      expect(createdMember.passwordHash).toBeUndefined();
      expect(createdMember.householdId).toBeUndefined();

      const adminList = await app.inject({
        method: "GET",
        url: "/api/v1/members",
        headers: { cookie: adminCookie },
      });
      expect(adminList.statusCode).toBe(200);
      expect(adminList.json()).toHaveLength(2);

      const memberLogin = await app.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: "household.member@example.com", password: memberPassword },
      });
      const memberCookie = sessionCookie(memberLogin.headers["set-cookie"]);
      const forbiddenList = await app.inject({
        method: "GET",
        url: "/api/v1/members",
        headers: { cookie: memberCookie },
      });
      expect(memberLogin.statusCode).toBe(200);
      expect(forbiddenList.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("resets a Member password and invalidates every session for that Member", async () => {
    const adminPassword = randomBytes(32).toString("base64url");
    const memberPassword = randomBytes(32).toString("base64url");
    const replacementPassword = randomBytes(32).toString("base64url");
    const app = await createApp({
      bootstrapAdmin: { email: "admin@example.com", password: adminPassword },
      databaseUrl: container.getConnectionUri(),
      sessionSecret: randomBytes(32).toString("hex"),
    });

    try {
      const adminLogin = await app.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: "admin@example.com", password: adminPassword },
      });
      const adminCookie = sessionCookie(adminLogin.headers["set-cookie"]);
      const adminCsrf = adminLogin.json().csrfToken as string;
      const createMember = await app.inject({
        method: "POST",
        url: "/api/v1/members",
        headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
        payload: { email: "member@example.com", password: memberPassword },
      });
      const memberId = createMember.json().id as string;
      const firstLogin = await app.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: "member@example.com", password: memberPassword },
      });
      const secondLogin = await app.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: "member@example.com", password: memberPassword },
      });
      const firstCookie = sessionCookie(firstLogin.headers["set-cookie"]);
      const secondCookie = sessionCookie(secondLogin.headers["set-cookie"]);

      const rejectedReset = await app.inject({
        method: "PUT",
        url: `/api/v1/members/${memberId}/password`,
        headers: { cookie: adminCookie },
        payload: { password: replacementPassword },
      });
      expect(rejectedReset.statusCode).toBe(403);

      const reset = await app.inject({
        method: "PUT",
        url: `/api/v1/members/${memberId}/password`,
        headers: { cookie: adminCookie, "x-csrf-token": adminCsrf },
        payload: { password: replacementPassword },
      });
      expect(reset.statusCode).toBe(204);

      const firstOldSession = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { cookie: firstCookie },
      });
      const secondOldSession = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { cookie: secondCookie },
      });
      const administratorSession = await app.inject({
        method: "GET",
        url: "/api/v1/session",
        headers: { cookie: adminCookie },
      });
      const oldPasswordLogin = await app.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: "member@example.com", password: memberPassword },
      });
      const newPasswordLogin = await app.inject({
        method: "POST",
        url: "/api/v1/session",
        payload: { email: "member@example.com", password: replacementPassword },
      });

      expect(firstOldSession.statusCode).toBe(401);
      expect(secondOldSession.statusCode).toBe(401);
      expect(administratorSession.statusCode).toBe(200);
      expect(oldPasswordLogin.statusCode).toBe(401);
      expect(newPasswordLogin.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

function sessionCookie(header: string | string[] | undefined): string {
  const setCookie = Array.isArray(header) ? header[0] : header;
  if (!setCookie) {
    throw new Error("Successful login did not set a session cookie.");
  }

  return setCookie.split(";", 1)[0]!;
}
