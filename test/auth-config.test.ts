import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("authentication configuration", () => {
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  });

  it("requires a persistent session-secret file in production", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://homeorg:homeorg@localhost/homeorg",
        NODE_ENV: "production",
      }),
    ).toThrow(/SESSION_SECRET_FILE/);
  });

  it("reads session and bootstrap secrets from files without changing password content", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "homeorg-auth-config-"));
    const sessionSecretPath = join(temporaryDirectory, "session-secret");
    const databasePasswordPath = join(temporaryDirectory, "database-password");
    const bootstrapEmailPath = join(temporaryDirectory, "bootstrap-email");
    const bootstrapPasswordPath = join(temporaryDirectory, "bootstrap-password");
    const bootstrapPassword = "pass phrase ending in spaces  ";
    await writeFile(sessionSecretPath, "s".repeat(32));
    await writeFile(databasePasswordPath, "database password\n");
    await writeFile(bootstrapEmailPath, "ADMIN@example.com\n");
    await writeFile(bootstrapPasswordPath, `${bootstrapPassword}\n`);

    const config = loadConfig({
      DATABASE_URL: "postgres://homeorg:homeorg@localhost/homeorg",
      NODE_ENV: "production",
      SESSION_SECRET_FILE: sessionSecretPath,
      DATABASE_PASSWORD_FILE: databasePasswordPath,
      BOOTSTRAP_ADMIN_EMAIL_FILE: bootstrapEmailPath,
      BOOTSTRAP_ADMIN_PASSWORD_FILE: bootstrapPasswordPath,
    });

    expect(config.sessionSecret).toBe("s".repeat(32));
    expect(config.databasePassword).toBe("database password");
    expect(config.bootstrapAdmin).toEqual({
      email: "ADMIN@example.com",
      password: bootstrapPassword,
    });
  });
});
