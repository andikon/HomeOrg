import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
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

  it("starts an HTTP server and omits query-string secrets from logs", async () => {
    const port = await findAvailablePort();
    const secret = "query-token-must-not-be-logged";
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: container.getConnectionUri(),
        HOST: "127.0.0.1",
        LOG_LEVEL: "info",
        NODE_ENV: "test",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });

    try {
      await waitForReady(child, `http://127.0.0.1:${port}/readyz`);
      const response = await fetch(
        `http://127.0.0.1:${port}/healthz?token=${secret}`,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
    } finally {
      if (child.exitCode === null) {
        const closed = once(child, "close");
        child.kill();
        await closed;
      }
    }

    expect(output).toContain('"event":"request_received"');
    expect(output).toContain('"path":"/healthz"');
    expect(output).not.toContain(secret);
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

async function findAvailablePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a local TCP port for the API startup test.");
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

  return address.port;
}

async function waitForReady(child: ReturnType<typeof spawn>, url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`API process exited before becoming ready with code ${child.exitCode}.`);
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        return;
      }
    } catch {
      await delay(100);
    }
  }

  throw new Error("API process did not become ready within five seconds.");
}
