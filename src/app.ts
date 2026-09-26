import Fastify, { LogController, type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { createDatabaseConnection } from "./database/connection.js";
import { migrationsAreCurrent } from "./database/migrations.js";
import { errorCodeOf } from "./logging.js";

const healthResponse = z.object({ status: z.string() });

export interface CreateAppOptions {
  databaseUrl: string;
  connectionTimeoutMillis?: number;
  migrationsFolder?: string;
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const database = createDatabaseConnection(
    options.databaseUrl,
    options.connectionTimeoutMillis,
  );
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
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
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Household Organization API",
        version: "0.1.0",
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

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
