import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const project = `homeorg-smoke-${randomBytes(5).toString("hex")}`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "homeorg-compose-smoke-"));
const secretsDirectory = join(temporaryDirectory, "secrets");
const sessionSecret = randomBytes(32).toString("hex");
const applicationPassword = randomBytes(32).toString("hex");
const migratorPassword = randomBytes(32).toString("hex");
const ownerPassword = randomBytes(32).toString("hex");
const loginCanary = randomBytes(32).toString("hex");
let environmentFile;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    timeout: options.timeout ?? 600_000,
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  }
  return result;
}

function compose(...args) {
  return run("docker", [
    "compose",
    "--project-name",
    project,
    "--env-file",
    environmentFile,
    "-f",
    "deploy/compose.yaml",
    ...args,
  ]);
}

function composeForDiagnostics(...args) {
  return run(
    "docker",
    ["compose", "--project-name", project, "--env-file", environmentFile, "-f", "deploy/compose.yaml", ...args],
    { allowFailure: true },
  );
}

function inspect(containerId, format) {
  return run("docker", ["inspect", "--format", format, containerId]).stdout.trim();
}

function getServiceContainer(service) {
  const result = compose("ps", "-aq", service).stdout.trim();
  if (!result) throw new Error(`Compose did not create the ${service} container.`);
  return result.split(/\s+/)[0];
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a local port.");
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

async function waitForReady(baseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/readyz`);
      if (response.ok) return;
      lastError = new Error(`Readiness returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await delay(1_000);
  }
  throw new Error(`API did not become ready: ${lastError}`);
}

async function apiRequest(baseUrl, path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  assert(response.ok, `${path} returned HTTP ${response.status}.`);
  return response;
}

async function databaseQuery(sql) {
  return run("docker", [
    "compose",
    "--project-name",
    project,
    "--env-file",
    environmentFile,
    "-f",
    "deploy/compose.yaml",
    "exec",
    "-T",
    "db",
    "psql",
    "-U",
    "homeorg_owner",
    "-d",
    "homeorg",
    "-v",
    "ON_ERROR_STOP=1",
    "-Atc",
    sql,
  ]).stdout.trim();
}

try {
  await mkdir(secretsDirectory);
  for (const [name, secret] of [
    ["db_owner_password", ownerPassword],
    ["db_app_password", applicationPassword],
    ["db_migrator_password", migratorPassword],
    ["session_secret", sessionSecret],
  ]) {
    await writeFile(join(secretsDirectory, name), secret, { mode: 0o444 });
  }
  environmentFile = join(temporaryDirectory, "compose.env");
  const hostPort = await availablePort();
  await writeFile(
    environmentFile,
    [
      `IMAGE_TAG=${project}`,
      `POSTGRES_VOLUME_NAME=${project}_postgres_data`,
      `API_PORT=${hostPort}`,
      `SECRETS_DIR=${resolve(secretsDirectory).replaceAll("\\", "/")}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  compose("up", "-d", "--build");
  const migrateId = getServiceContainer("migrate");
  assert(inspect(migrateId, "{{.State.ExitCode}}") === "0", "The one-shot migration service failed.");

  const apiPortBinding = run("docker", [
    "compose",
    "--project-name",
    project,
    "--env-file",
    environmentFile,
    "-f",
    "deploy/compose.yaml",
    "port",
    "api",
    "3000",
  ]).stdout.trim();
  assert(apiPortBinding === `127.0.0.1:${hostPort}`, `API is not loopback-bound: ${apiPortBinding}`);

  const apiPort = hostPort;
  const dbId = getServiceContainer("db");
  const databasePorts = JSON.parse(inspect(dbId, "{{json .NetworkSettings.Ports}}"));
  assert(databasePorts["5432/tcp"] === null, "PostgreSQL unexpectedly publishes a host port.");
  const migrationCount = await databaseQuery("SELECT count(*) FROM drizzle.__drizzle_migrations");
  assert(Number(migrationCount) > 0, "The migration ledger is empty after migration completed.");
  const appPrivileges = await databaseQuery(
    "SELECT has_table_privilege('homeorg_app', 'members', 'SELECT')::text || ',' || has_table_privilege('homeorg_app', 'members', 'INSERT')::text || ',' || has_schema_privilege('homeorg_app', 'public', 'CREATE')::text",
  );
  assert(appPrivileges === "true,true,false", `Application role privileges are incorrect: ${appPrivileges}`);
  const migrationPrivilege = await databaseQuery(
    "SELECT has_schema_privilege('homeorg_migrator', 'public', 'CREATE')::text || ',' || has_database_privilege('homeorg_migrator', 'homeorg', 'CREATE')::text",
  );
  assert(migrationPrivilege === "true,true", `Migrator role privileges are incorrect: ${migrationPrivilege}`);
  const roleAttributes = await databaseQuery(
    "SELECT rolsuper::text || ',' || rolcreatedb::text FROM pg_roles WHERE rolname IN ('homeorg_app', 'homeorg_migrator') ORDER BY rolname",
  );
  assert(roleAttributes === "false,false\nfalse,false", `Database roles have elevated attributes: ${roleAttributes}`);

  const baseUrl = `http://127.0.0.1:${apiPort}`;
  await waitForReady(baseUrl);
  await apiRequest(baseUrl, "/healthz");
  await apiRequest(baseUrl, "/openapi.json");

  const loginResponse = await fetch(`${baseUrl}/api/v1/session`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${loginCanary}`,
      cookie: `smoke=${loginCanary}`,
      "x-csrf-token": loginCanary,
    },
    body: JSON.stringify({
      email: "compose-smoke@example.invalid",
      password: loginCanary,
    }),
  });
  assert(loginResponse.status === 401, "A missing smoke-test account did not receive HTTP 401.");

  const smokeMarker = `deployment_${project.replaceAll("-", "_")}`;
  await databaseQuery(`CREATE TABLE public.${smokeMarker} (value text NOT NULL)`);
  await databaseQuery(`INSERT INTO public.${smokeMarker} (value) VALUES ('persisted')`);
  compose("restart", "db");
  await waitForReady(baseUrl);
  const persistedMarker = await databaseQuery(`SELECT value FROM public.${smokeMarker} LIMIT 1`);
  assert(persistedMarker === "persisted", "The named PostgreSQL volume did not preserve data.");

  const apiId = getServiceContainer("api");
  const apiContainer = JSON.parse(inspect(apiId, "{{json .Config}}"));
  const apiHostConfig = JSON.parse(inspect(apiId, "{{json .HostConfig}}"));
  assert(apiContainer.User === "node", "API is not running as the unprivileged node user.");
  assert(apiHostConfig.ReadonlyRootfs, "API root filesystem is not read-only.");

  for (const containerId of [dbId, apiId]) {
    const logging = JSON.parse(inspect(containerId, "{{json .HostConfig.LogConfig}}"));
    assert(
      logging.Type === "local" && logging.Config["max-size"] === "10m" && logging.Config["max-file"] === "5",
      `Container ${containerId} does not have bounded local logging.`,
    );
  }

  const apiLogs = run("docker", ["logs", apiId]).stdout;
  const databaseLogs = run("docker", ["logs", dbId]).stdout;
  assert(!apiLogs.includes(loginCanary), "API logs leaked a cookie or password canary.");
  assert(!apiLogs.includes(applicationPassword), "API logs leaked the database password.");
  assert(!apiLogs.includes(sessionSecret), "API logs leaked the session secret.");
  assert(!databaseLogs.includes(applicationPassword), "Database logs leaked the API password.");
  assert(!databaseLogs.includes(migratorPassword), "Database logs leaked the migrator password.");
  assert(!databaseLogs.includes(ownerPassword), "Database logs leaked the owner password.");
  assert(!databaseLogs.includes(sessionSecret), "Database logs leaked the session secret.");
  for (const line of apiLogs.split(/\r?\n/).filter(Boolean)) {
    assert(JSON.parse(line), "API emitted a non-JSON log line.");
  }

  console.log(
    "Compose smoke passed: migration ordering, loopback exposure, readiness, persistence, and safe bounded logs.",
  );
} catch (error) {
  for (const service of ["db", "migrate", "api"]) {
    const containerId = composeForDiagnostics("ps", "-aq", service).stdout.trim();
    if (containerId) {
      const logs = run("docker", ["logs", containerId], { allowFailure: true });
      console.error(`${service} container logs:\n${logs.stdout}${logs.stderr}`);
    }
  }
  throw error;
} finally {
  if (environmentFile) composeForDiagnostics("down", "--volumes", "--remove-orphans");
  await rm(temporaryDirectory, { recursive: true, force: true });
}
