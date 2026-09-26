import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.url().refine(
    (value) => value.startsWith("postgres://") || value.startsWith("postgresql://"),
    "DATABASE_URL must use PostgreSQL",
  ),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export interface AppConfig {
  databaseUrl: string;
  host: string;
  logLevel: z.infer<typeof configSchema>["LOG_LEVEL"];
  port: number;
  nodeEnv: z.infer<typeof configSchema>["NODE_ENV"];
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(environment);

  return {
    databaseUrl: parsed.DATABASE_URL,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
  };
}
