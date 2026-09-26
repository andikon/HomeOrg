import { loadConfig } from "./config.js";
import { createApp } from "./app.js";

const config = loadConfig();
const app = await createApp({
  databaseUrl: config.databaseUrl,
  logLevel: config.logLevel,
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  const errorCode =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "unknown";
  app.log.error({ event: "api_start_failed", errorCode }, "API failed to start");
  await app.close();
  process.exitCode = 1;
}
