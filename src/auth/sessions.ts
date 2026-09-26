import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { DatabaseConnection } from "../database/connection.js";
import { members, sessions } from "../database/schema.js";
import { problemBody } from "../problem.js";

export const SESSION_COOKIE = "__Host-homeorg_session";
const PERSISTENT_COOKIE_EXPIRY = new Date("9999-12-31T23:59:59.000Z");

export interface MemberView {
  id: string;
  email: string;
  role: "member" | "admin";
  createdAt: string;
  updatedAt: string;
}

export function toMemberView(member: typeof members.$inferSelect): MemberView {
  return {
    id: member.id,
    email: member.email,
    role: member.role,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
  };
}

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(secret: string, token: string): string {
  return createHmac("sha256", secret).update(`session:${token}`).digest("hex");
}

export function createCsrfToken(secret: string, sessionToken: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionToken}`).digest("hex");
}

export function setSessionCookie(reply: FastifyReply, sessionToken: string): void {
  reply.setCookie(SESSION_COOKIE, sessionToken, {
    expires: PERSISTENT_COOKIE_EXPIRY,
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: true,
  });
}

export async function authenticateSession(
  request: FastifyRequest,
  reply: FastifyReply,
  database: DatabaseConnection,
  sessionSecret: string,
  requireCsrf: boolean,
  requiredRole?: "admin",
): Promise<void> {
  const sessionToken = request.cookies[SESSION_COOKIE];
  if (!sessionToken) {
    reply.code(401).send(problemBody(401, "unauthenticated", "Unauthenticated", "Sign in to continue."));
    return;
  }

  const tokenHash = hashSessionToken(sessionSecret, sessionToken);
  const [session] = await database.db
    .select({
      id: members.id,
      householdId: members.householdId,
      email: members.email,
      passwordHash: members.passwordHash,
      role: members.role,
      createdAt: members.createdAt,
      updatedAt: members.updatedAt,
    })
    .from(sessions)
    .innerJoin(members, eq(sessions.memberId, members.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  if (!session) {
    reply.code(401).send(problemBody(401, "unauthenticated", "Unauthenticated", "Sign in to continue."));
    return;
  }

  if (requiredRole === "admin" && session.role !== "admin") {
    reply.code(403).send(problemBody(
      403,
      "forbidden",
      "Forbidden",
      "You are not allowed to perform this action.",
    ));
    return;
  }

  if (requireCsrf && !csrfTokenMatches(sessionSecret, sessionToken, request.headers["x-csrf-token"])) {
    reply.code(403).send(problemBody(403, "forbidden", "Forbidden", "A valid CSRF token is required."));
    return;
  }

  await database.db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(eq(sessions.tokenHash, tokenHash));
  setSessionCookie(reply, sessionToken);
  request.authMember = toMemberView(session);
}

function csrfTokenMatches(
  sessionSecret: string,
  sessionToken: string,
  providedToken: string | string[] | undefined,
): boolean {
  const providedValue = typeof providedToken === "string" ? providedToken : "";
  const providedDigest = createHmac("sha256", sessionSecret)
    .update(`csrf-check:${providedValue}`)
    .digest();
  const expectedDigest = createHmac("sha256", sessionSecret)
    .update(`csrf-check:${createCsrfToken(sessionSecret, sessionToken)}`)
    .digest();

  return timingSafeEqual(providedDigest, expectedDigest);
}
