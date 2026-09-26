# MVP Acceptance and Delivery Verification

This matrix is the implementation handoff for the Household Organization API
MVP. Every scenario must have an automated test unless it is explicitly marked
as a manual first-deployment or restore procedure.

## Automated gate

Implementation provides `npm run verify`, which runs the Biome formatting and
lint checks, TypeScript type-check, unit tests, PostgreSQL integration tests,
Swagger Parser OpenAPI validation, production image build, and Compose smoke
test. GitHub Actions also runs the production dependency audit and Gitleaks
secret scan for pull requests and pushes to the default branch.

Tests do not pass on retry. They use generated credentials and tokens, control
time/randomness where needed, and isolate PostgreSQL state. CI may run Docker
and Compose locally but never deploys, accesses production secrets, or connects
to the public host. The gate rejects committed secrets and known high or
critical vulnerabilities in production dependencies.

| ID | Requirement | Verification | Expected result |
| --- | --- | --- | --- |
| AUTH-01 | First bootstrap and authentication | PostgreSQL integration | The seeded Household Administrator can sign in; incorrect email and password both return the same generic `401` response; no public registration exists. |
| AUTH-02 | Member administration | PostgreSQL integration | A Household Administrator provisions an ordinary Member and resets that Member's password; reset invalidates every existing session for that Member. |
| AUTH-03 | Session and CSRF protection | Route integration | Successful login sets the secure session cookie and returns a CSRF token; every mutation without a valid `X-CSRF-Token` returns `403`; logout invalidates only its current session. |
| AUTH-04 | Authorization | Route integration | Members can use shared Lists and Entries; Board Post authors can update/delete their own posts; another Member is forbidden; a Household Administrator may delete any Board Post but not edit another author’s post. |
| LIST-01 | Shared List and Entry lifecycle | PostgreSQL integration | Members create, read, patch, and permanently delete Lists and Entries created by any Member. List and Entry validation, duplicate display names/titles, nullable optional Entry fields, Due Dates, and reversible completion match the contract. |
| LIST-02 | Manual order and concurrency | PostgreSQL integration | Lists and Entries append on creation and move only within their own collection. Valid moves use anchors; self/foreign anchors fail; stale or missing preconditions return `412` or `428` without partial change. Entries cannot move between Lists. |
| LIST-03 | Permanent List deletion | PostgreSQL integration | A List delete with current composite List and Entry-collection ETags atomically deletes its Entries. A stale/missing condition fails without deletion. |
| BOARD-01 | Board lifecycle and pagination | PostgreSQL integration | Board Posts remain newest-first by immutable creation time, edits preserve position/author, and cursor traversal does not duplicate or reorder crossed posts. |
| API-01 | JSON and error contract | Route integration | Responses use documented casing, IDs, timestamps, nulls, content types, headers, status codes, and Problem Details types. Malformed JSON, unsupported media types, validation, missing resources, conflicts, rate limits, and preconditions have the specified outcomes. |
| API-02 | OpenAPI contract | Schema and route test | The generated `/openapi.json` validates as OpenAPI 3.x. Runtime Zod/Fastify schemas produce representative documented success and error responses; no separately maintained OpenAPI artifact or brittle full-document snapshot exists. |
| DB-01 | Schema and persistence | Testcontainers PostgreSQL | Migrations apply to an empty database and an upgrade fixture. Database constraints enforce Household data integrity, ordering/revisions survive API restart, and sessions persist/invalidate correctly. |
| DB-02 | Least-privilege database roles | Testcontainers PostgreSQL | The API role can perform required runtime data operations but cannot change schema; the migrator role can apply migrations. |
| DEPLOY-01 | Compose boundary and readiness | Black-box Compose smoke test | Only the loopback API port is published; PostgreSQL has no host port; the one-shot migration exits successfully before the API becomes ready; `/healthz` and `/readyz` behave as specified; a named volume preserves data through database restart. |
| DEPLOY-02 | Runtime observability | Black-box Compose smoke test | API logs are structured JSON with safe request metadata only. Docker local logging is bounded to five 10 MiB files; a canary cookie/password and mounted secrets do not appear in API logs. |
| DEPLOY-03 | Image and secret hygiene | CI image build, dependency audit, and Gitleaks | Runtime image uses digest-pinned Node base and production-only dependencies; PostgreSQL image is digest-pinned; high/critical production dependency advisories and detected secrets fail CI. |

## Manual first-deployment acceptance

Follow [deployment.md](deployment.md) for the full procedure. Run these checks
on the target Ubuntu host before first public release and when the proxy/TLS
configuration materially changes:

1. Confirm DNS resolves to the host and UFW exposes only intended SSH access,
   TCP 80, and TCP 443.
2. Run the documented Compose migration/release sequence; verify `db` health,
   `/healthz`, `/readyz`, and normal authenticated API behavior through Nginx.
3. Confirm HTTP redirects to HTTPS, the certificate is valid for the hostname,
   TLS 1.2/1.3 and HSTS are active, Certbot renewal succeeds with a dry run,
   and Secure session cookies work through the one trusted proxy hop.
4. Verify Nginx exposes only `/api/v1/`, `/openapi.json`, `/docs`,
   `/healthz`, and `/readyz`; secret/source paths are inaccessible; and
   login throttling is active.
5. Inspect Docker and Nginx logs and confirm rotation/bounds without sensitive
   values. Confirm UFW exposes only intended SSH access, TCP 80, and TCP 443.

## Manual restore drill

Before relying on the deployment, create a custom-format PostgreSQL dump,
perform the documented destructive restore into a stopped deployment, and
verify representative Household data through the API. Then rotate the session
secret and prove all sessions issued before restoration no longer authenticate.
The drill acknowledges that post-dump writes are lost.

## Deliberately deferred verification

The MVP has no numeric performance or availability SLO, load/stress benchmark,
external monitoring, alerting, log aggregation, automated backup scheduling,
external backup storage, separate security platform, or penetration-test
requirement. These are not implied by a passing acceptance gate.
