import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
import { errorCodeOf } from "./logging.js";

const config = loadConfig();
const app = await createApp({
  databaseUrl: config.databaseUrl,
  logLevel: config.logLevel,
});

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(
    { event: "api_start_failed", errorCode: errorCodeOf(error) },
    "API failed to start",
  );
  await app.close();
  process.exitCode = 1;
}
