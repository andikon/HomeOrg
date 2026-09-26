import "dotenv/config";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
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
  SESSION_SECRET_FILE: z.string().trim().min(1).optional(),
  BOOTSTRAP_ADMIN_EMAIL_FILE: z.string().trim().min(1).optional(),
  BOOTSTRAP_ADMIN_PASSWORD_FILE: z.string().trim().min(1).optional(),
}).superRefine((config, context) => {
  if (config.NODE_ENV === "production" && !config.SESSION_SECRET_FILE) {
    context.addIssue({
      code: "custom",
      path: ["SESSION_SECRET_FILE"],
      message: "SESSION_SECRET_FILE is required in production.",
    });
  }

  if (Boolean(config.BOOTSTRAP_ADMIN_EMAIL_FILE) !== Boolean(config.BOOTSTRAP_ADMIN_PASSWORD_FILE)) {
    context.addIssue({
      code: "custom",
      path: ["BOOTSTRAP_ADMIN_EMAIL_FILE"],
      message: "Both bootstrap administrator secret files must be configured together.",
    });
  }
});

export interface AppConfig {
  databaseUrl: string;
  host: string;
  logLevel: z.infer<typeof configSchema>["LOG_LEVEL"];
  port: number;
  nodeEnv: z.infer<typeof configSchema>["NODE_ENV"];
  sessionSecret: string;
  bootstrapAdmin?: { email: string; password: string };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.parse(environment);
  const sessionSecret = parsed.SESSION_SECRET_FILE
    ? readSecretFile(parsed.SESSION_SECRET_FILE, "session secret")
    : randomBytes(32).toString("hex");

  if (Buffer.byteLength(sessionSecret, "utf8") < 32) {
    throw new Error("The session secret must contain at least 32 bytes.");
  }

  const bootstrapAdmin =
    parsed.BOOTSTRAP_ADMIN_EMAIL_FILE && parsed.BOOTSTRAP_ADMIN_PASSWORD_FILE
      ? {
          email: readSecretFile(parsed.BOOTSTRAP_ADMIN_EMAIL_FILE, "bootstrap email"),
          password: readSecretFile(parsed.BOOTSTRAP_ADMIN_PASSWORD_FILE, "bootstrap password"),
        }
      : undefined;

  return {
    databaseUrl: parsed.DATABASE_URL,
    host: parsed.HOST,
    logLevel: parsed.LOG_LEVEL,
    port: parsed.PORT,
    nodeEnv: parsed.NODE_ENV,
    sessionSecret,
    ...(bootstrapAdmin ? { bootstrapAdmin } : {}),
  };
}

function readSecretFile(path: string, name: string): string {
  const contents = readFileSync(path, "utf8");
  const secret = contents.endsWith("\r\n")
    ? contents.slice(0, -2)
    : contents.endsWith("\n")
      ? contents.slice(0, -1)
      : contents;

  if (!secret) {
    throw new Error(`The ${name} file must not be empty.`);
  }

  return secret;
}
