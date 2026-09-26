import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/database/migrations.js";

describe("runtime configuration", () => {
  it("requires a valid PostgreSQL connection URL", () => {
    expect(() => loadConfig({ DATABASE_URL: "http://localhost/database" })).toThrow();
  });

  it("applies safe development defaults to validated configuration", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://homeorg:homeorg@localhost/homeorg" })).toMatchObject({
      host: "0.0.0.0",
      logLevel: "info",
      port: 3000,
      nodeEnv: "development",
    });
  });
});

describe("API prototype", () => {
  let container: Awaited<ReturnType<PostgreSqlContainer["start"]>>;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const databaseUrl = container.getConnectionUri();

    const unmigratedApp = await createApp({ databaseUrl });
    const pendingMigrationResponse = await unmigratedApp.inject({
      method: "GET",
      url: "/readyz",
    });
    await unmigratedApp.close();
    expect(pendingMigrationResponse.statusCode).toBe(503);

    await runMigrations(databaseUrl);
    app = await createApp({ databaseUrl });
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it("reports liveness without exposing operational details", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("reports ready only after PostgreSQL migrations are applied", async () => {
    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("applies migrations idempotently", async () => {
    await runMigrations(container.getConnectionUri());
    const response = await app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("publishes an OpenAPI document generated from the health routes", async () => {
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    const document = response.json();

    expect(response.statusCode).toBe(200);
    expect(document.openapi).toMatch(/^3\./);
    expect(document.paths["/healthz"].get.responses["200"]).toBeDefined();
    expect(document.paths["/readyz"].get.responses["503"]).toBeDefined();
  });

  it("serves interactive API documentation", async () => {
    const response = await app.inject({ method: "GET", url: "/docs/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
  });

  it("reports not ready when PostgreSQL cannot be reached", async () => {
    const unavailableApp = await createApp({
      databaseUrl: "postgres://homeorg:homeorg@127.0.0.1:1/homeorg",
      connectionTimeoutMillis: 100,
    });

    try {
      const response = await unavailableApp.inject({
        method: "GET",
        url: "/readyz",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ status: "not_ready" });
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await unavailableApp.close();
    }
  });
});
