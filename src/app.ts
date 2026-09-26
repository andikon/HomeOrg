import Fastify, {
  LogController,
  type FastifyInstance,
} from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createBootstrapAdministrator, registerAuthenticationRoutes } from "./auth/routes.js";
import { createDatabaseConnection } from "./database/connection.js";
import { migrationsAreCurrent } from "./database/migrations.js";
import { errorCodeOf } from "./logging.js";
import { problemBody } from "./problem.js";

const healthResponse = z.object({ status: z.string() });

export interface CreateAppOptions {
  bootstrapAdmin?: { email: string; password: string };
  databaseUrl: string;
  connectionTimeoutMillis?: number;
  migrationsFolder?: string;
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  sessionSecret?: string;
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const database = createDatabaseConnection(
    options.databaseUrl,
    options.connectionTimeoutMillis,
  );
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: "127.0.0.1",
    logger: {
      level: options.logLevel ?? "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers.set-cookie",
        ],
        censor: "[REDACTED]",
      },
    },
  });

  app.addHook("onRequest", async (request) => {
    request.log.info(
      {
        event: "request_received",
        method: request.method,
        path: requestPath(request),
      },
      "Incoming request",
    );
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        event: "request_completed",
        method: request.method,
        path: requestPath(request),
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      "Request completed",
    );
  });
  app.addHook("onClose", async () => {
    await database.close();
  });
  app.decorateRequest("authMember", null);
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/v1")) {
      reply.header("cache-control", "no-store");
    }

    return payload;
  });
  app.setErrorHandler((error, request, reply) => {
    const details = error as typeof error & {
      statusCode?: number;
      validation?: { instancePath?: string; message?: string }[];
    };
    const validationErrors = details.validation
      ? details.validation.reduce<Record<string, string[]>>((errors, issue) => {
          const field = issue.instancePath?.replace(/^\//, "").replaceAll("/", ".") || "body";
          (errors[field] ??= []).push(issue.message ?? "Invalid value.");
          return errors;
        }, {})
      : undefined;
    const status = details.validation
      ? 422
      : details.statusCode && details.statusCode >= 400
        ? details.statusCode
        : 500;

    if (status >= 500) {
      request.log.error(
        { event: "request_failed", errorCode: errorCodeOf(error) },
        "Request failed",
      );
      return reply.code(500).send(problemBody(
        500,
        "internal-error",
        "Internal Server Error",
        "An unexpected error occurred.",
      ));
    }

    if (status === 429) {
      return reply.code(status).send(problemBody(
        status,
        "rate-limited",
        "Too Many Requests",
        "Too many login attempts. Try again later.",
      ));
    }

    if (status === 415) {
      return reply.code(status).send(problemBody(
        status,
        "unsupported-media-type",
        "Unsupported Media Type",
        "Use application/json for request bodies.",
      ));
    }

    if (details.validation) {
      return reply.code(422).send(problemBody(
        422,
        "validation",
        "Validation Failed",
        "One or more request fields are invalid.",
        validationErrors,
      ));
    }

    if (status === 400) {
      return reply.code(400).send(problemBody(
        400,
        "malformed-json",
        "Malformed JSON",
        "The request body is invalid.",
      ));
    }

    return reply.code(status).send(problemBody(status, status === 404 ? "not-found" : "forbidden",
      status === 404 ? "Not Found" : "Forbidden",
      status === 404 ? "The requested resource was not found." : "The request is not allowed."));
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(problemBody(404, "not-found", "Not Found", "The requested resource was not found.")),
  );

  const sessionSecret = options.sessionSecret ?? randomBytes(32).toString("hex");
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    hook: "preHandler",
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: {
      components: {
        securitySchemes: {
          csrfToken: {
            type: "apiKey",
            in: "header",
            name: "X-CSRF-Token",
          },
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: "__Host-homeorg_session",
          },
        },
      },
      info: {
        title: "Household Organization API",
        version: "0.1.0",
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  await registerAuthenticationRoutes(app, { database, sessionSecret });

  if (options.bootstrapAdmin) {
    await createBootstrapAdministrator(database, options.bootstrapAdmin);
  }

  app.get(
    "/healthz",
    {
      schema: {
        response: { 200: healthResponse },
      },
    },
    async (_request, reply) => {
      reply.header("cache-control", "no-store");
      return { status: "ok" };
    },
  );

  app.get(
    "/readyz",
    {
      schema: {
        response: {
          200: healthResponse,
          503: healthResponse,
        },
      },
    },
    async (request, reply) => {
      reply.header("cache-control", "no-store");

      try {
        await database.pool.query("SELECT 1");
        const migrationsCurrent = await migrationsAreCurrent(
          database.pool,
          options.migrationsFolder,
        );

        if (!migrationsCurrent) {
          return reply.code(503).send({ status: "not_ready" });
        }

        return { status: "ready" };
      } catch (error) {
        request.log.warn(
          { event: "readiness_check_failed", errorCode: errorCodeOf(error) },
          "Readiness check failed",
        );
        return reply.code(503).send({ status: "not_ready" });
      }
    },
  );

  app.get(
    "/openapi.json",
    { schema: { hide: true } },
    async () => app.swagger(),
  );

  return app;
}

function requestPath(request: {
  routeOptions: { url?: string };
  url: string;
}): string {
  return request.routeOptions.url ?? request.url.split("?", 1)[0] ?? "/";
}
