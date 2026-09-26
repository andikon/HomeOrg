import { loadConfig } from "../config.js";
import { runMigrations } from "./migrations.js";

const config = loadConfig();
await runMigrations(config.databaseUrl, undefined, config.databasePassword);
