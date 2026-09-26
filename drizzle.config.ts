import "dotenv/config";
import { readFileSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to generate migrations.");
}

const databaseUrl = new URL(process.env.DATABASE_URL);
const databasePasswordFile = process.env.DATABASE_PASSWORD_FILE;
const databasePassword = databasePasswordFile ? readSecretFile(databasePasswordFile) : undefined;

export default defineConfig({
  dialect: "postgresql",
  dbCredentials: databasePassword
    ? {
        host: databaseUrl.hostname,
        port: Number(databaseUrl.port || 5432),
        user: decodeURIComponent(databaseUrl.username),
        password: databasePassword,
        database: databaseUrl.pathname.slice(1),
      }
    : { url: process.env.DATABASE_URL },
  out: "./drizzle",
  schema: "./src/database/schema.ts",
});

function readSecretFile(path: string): string {
  const contents = readFileSync(path, "utf8");
  const secret = contents.endsWith("\r\n")
    ? contents.slice(0, -2)
    : contents.endsWith("\n")
      ? contents.slice(0, -1)
      : contents;

  if (!secret) {
    throw new Error("The database password file must not be empty.");
  }

  return secret;
}
