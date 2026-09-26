import { randomUUID } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { DatabaseConnection } from "../database/connection.js";
import { households, members, sessions } from "../database/schema.js";
import { errorCodeOf } from "../logging.js";
import { problemBody, problemSchema } from "../problem.js";
import { hashPassword, passwordIssue, verifyPassword } from "./passwords.js";
import {
  authenticateSession,
  createCsrfToken,
  createSessionToken,
  hashSessionToken,
  setSessionCookie,
  SESSION_COOKIE,
  toMemberView,
} from "./sessions.js";

const memberViewSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: z.enum(["member", "admin"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const sessionResponseSchema = z.object({
  member: memberViewSchema,
  csrfToken: z.string(),
});

const loginBodySchema = z.object({
  email: z.string().trim().pipe(z.email()).transform((email) => email.toLowerCase()),
  password: z.string().min(1),
}).strict();

const createMemberBodySchema = z.object({
  email: z.string().trim().pipe(z.email()).transform((email) => email.toLowerCase()),
  password: z.string().min(15).max(1024),
}).strict();

const resetPasswordParamsSchema = z.object({ memberId: z.uuid() });
const resetPasswordBodySchema = z.object({ password: z.string().min(15).max(1024) }).strict();

export interface RegisterAuthenticationOptions {
  database: DatabaseConnection;
  sessionSecret: string;
}

export async function registerAuthenticationRoutes(
  app: FastifyInstance,
  options: RegisterAuthenticationOptions,
): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const loginIpRateLimit = app.createRateLimit({
    keyGenerator: (request) => request.ip,
    max: 5,
    timeWindow: 15 * 60 * 1000,
  });
  const loginAccountRateLimit = app.createRateLimit({
    keyGenerator: loginAccountKey,
    max: 5,
    timeWindow: 15 * 60 * 1000,
  });

  routes.post(
    "/api/v1/session",
    {
      preHandler: async (request, reply) => {
        const ipLimit = await loginIpRateLimit(request);
        const accountLimit = await loginAccountRateLimit(request);
        const exceededLimit = [ipLimit, accountLimit]
          .filter((limit) => !limit.isAllowed)
          .find((limit) => limit.isExceeded);

        if (exceededLimit && !exceededLimit.isAllowed) {
          reply.header("retry-after", exceededLimit.ttlInSeconds);
          return reply.code(429).send(problemBody(
            429,
            "rate-limited",
            "Too Many Requests",
            "Too many login attempts. Try again later.",
          ));
        }
      },
      schema: {
        tags: ["session"],
        body: loginBodySchema,
        response: {
          200: sessionResponseSchema,
          401: problemSchema,
          422: problemSchema,
          429: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const [member] = await options.database.db
        .select()
        .from(members)
        .where(eq(members.email, request.body.email))
        .limit(1);
      const passwordMatches = await verifyPassword(request.body.password, member?.passwordHash);

      if (!member || !passwordMatches) {
        return reply.code(401).send(problemBody(
          401,
          "unauthenticated",
          "Unauthenticated",
          "Email or password is incorrect.",
        ));
      }

      const sessionToken = createSessionToken();
      await options.database.db.insert(sessions).values({
        tokenHash: hashSessionToken(options.sessionSecret, sessionToken),
        memberId: member.id,
      });
      setSessionCookie(reply, sessionToken);

      return {
        member: toMemberView(member),
        csrfToken: createCsrfToken(options.sessionSecret, sessionToken),
      };
    },
  );

  routes.get(
    "/api/v1/session",
    {
      preHandler: (request, reply) =>
        authenticateSession(request, reply, options.database, options.sessionSecret, false),
      schema: {
        tags: ["session"],
        security: [{ sessionCookie: [] }],
        response: {
          200: sessionResponseSchema,
          401: problemSchema,
        },
      },
    },
    async (request) => ({
      member: request.authMember!,
      csrfToken: createCsrfToken(
        options.sessionSecret,
        request.cookies[SESSION_COOKIE]!,
      ),
    }),
  );

  routes.delete(
    "/api/v1/session",
    {
      preHandler: (request, reply) =>
        authenticateSession(request, reply, options.database, options.sessionSecret, true),
      schema: {
        tags: ["session"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        response: {
          204: z.null(),
          401: problemSchema,
          403: problemSchema,
        },
      },
    },
    async (request, reply) => {
      await options.database.db
        .delete(sessions)
        .where(
          eq(
            sessions.tokenHash,
            hashSessionToken(
              options.sessionSecret,
              request.cookies[SESSION_COOKIE]!,
            ),
          ),
        );
      reply.clearCookie(SESSION_COOKIE, { path: "/", secure: true, sameSite: "strict" });
      return reply.code(204).send(null);
    },
  );

  routes.get(
    "/api/v1/members",
    {
      preHandler: (request, reply) =>
        authenticateSession(request, reply, options.database, options.sessionSecret, false, "admin"),
      schema: {
        tags: ["members"],
        security: [{ sessionCookie: [] }],
        response: {
          200: z.array(memberViewSchema),
          401: problemSchema,
          403: problemSchema,
        },
      },
    },
    async () => {
      const memberRecords = await options.database.db
        .select()
        .from(members)
        .orderBy(members.email);

      return memberRecords.map(toMemberView);
    },
  );

  routes.post(
    "/api/v1/members",
    {
      preHandler: (request, reply) =>
        authenticateSession(request, reply, options.database, options.sessionSecret, true, "admin"),
      schema: {
        tags: ["members"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        body: createMemberBodySchema,
        response: {
          201: memberViewSchema,
          401: problemSchema,
          403: problemSchema,
          409: problemSchema,
          422: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const issue = passwordIssue(request.body.password);
      if (issue) {
        return reply.code(422).send(problemBody(
          422,
          "validation",
          "Validation Failed",
          "One or more request fields are invalid.",
          { password: [issue.detail] },
        ));
      }

      const [household] = await options.database.db
        .select({ id: households.id })
        .from(households)
        .limit(1);
      if (!household) {
        throw new Error("Household Administrator bootstrap has not completed.");
      }

      const passwordHash = await hashPassword(request.body.password);
      let createdMember: typeof members.$inferSelect;

      try {
        [createdMember] = await options.database.db
          .insert(members)
          .values({
            id: randomUUID(),
            householdId: household.id,
            email: request.body.email,
            passwordHash,
            role: "member",
          })
          .returning();
      } catch (error) {
        if (errorCodeOf(error) === "23505") {
          return reply.code(409).send(problemBody(
            409,
            "conflict",
            "Conflict",
            "Email is already in use.",
          ));
        }

        throw error;
      }

      reply.header("location", `/api/v1/members/${createdMember.id}`);
      return reply.code(201).send(toMemberView(createdMember));
    },
  );

  routes.put(
    "/api/v1/members/:memberId/password",
    {
      preHandler: (request, reply) =>
        authenticateSession(request, reply, options.database, options.sessionSecret, true, "admin"),
      schema: {
        tags: ["members"],
        security: [{ sessionCookie: [], csrfToken: [] }],
        params: resetPasswordParamsSchema,
        body: resetPasswordBodySchema,
        response: {
          204: z.null(),
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          422: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const issue = passwordIssue(request.body.password);
      if (issue) {
        return reply.code(422).send(problemBody(
          422,
          "validation",
          "Validation Failed",
          "One or more request fields are invalid.",
          { password: [issue.detail] },
        ));
      }

      const passwordHash = await hashPassword(request.body.password);
      const memberWasUpdated = await options.database.db.transaction(async (transaction) => {
        const [member] = await transaction
          .update(members)
          .set({ passwordHash, updatedAt: new Date() })
          .where(eq(members.id, request.params.memberId))
          .returning({ id: members.id });

        if (!member) {
          return false;
        }

        await transaction.delete(sessions).where(eq(sessions.memberId, member.id));
        return true;
      });

      if (!memberWasUpdated) {
        return reply.code(404).send(problemBody(
          404,
          "not-found",
          "Not Found",
          "The requested Member was not found.",
        ));
      }

      return reply.code(204).send(null);
    },
  );
}

function loginAccountKey(request: FastifyRequest): string {
  const body = request.body;

  return body && typeof body === "object" && "email" in body && typeof body.email === "string"
    ? body.email.trim().toLowerCase()
    : "";
}

export async function createBootstrapAdministrator(
  database: DatabaseConnection,
  options: { email: string; password: string },
): Promise<void> {
  const email = options.email.trim().toLowerCase();
  const parsedEmail = z.email().safeParse(email);

  if (!parsedEmail.success) {
    throw new Error("Bootstrap Household Administrator email is invalid.");
  }

  const issue = passwordIssue(options.password);
  if (issue) {
    throw new Error(`Bootstrap Household Administrator password is invalid: ${issue.category}.`);
  }

  if ((await database.db.select({ id: members.id }).from(members).limit(1)).length > 0) {
    return;
  }

  const passwordHash = await hashPassword(options.password);

  await database.db.transaction(async (transaction) => {
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(723109155)`);

    if ((await transaction.select({ id: members.id }).from(members).limit(1)).length > 0) {
      return;
    }

    let [household] = await transaction
      .select({ id: households.id })
      .from(households)
      .limit(1);

    if (!household) {
      [household] = await transaction
        .insert(households)
        .values({ id: randomUUID() })
        .returning({ id: households.id });
    }

    await transaction.insert(members).values({
      id: randomUUID(),
      householdId: household.id,
      email,
      passwordHash,
      role: "admin",
    });
  });
}

declare module "fastify" {
  interface FastifyRequest {
    authMember: ReturnType<typeof toMemberView> | null;
  }
}
