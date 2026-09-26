import Fastify, { type FastifyInstance } from "fastify";
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
        const errorCode =
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : "unknown";
        request.log.warn(
          { event: "readiness_check_failed", errorCode },
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
