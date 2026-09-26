# Household Organization API

The API foundation uses Fastify, Drizzle ORM, and PostgreSQL. The current
prototype exposes health/readiness checks and generated OpenAPI documentation;
Household features are added in subsequent implementation tickets.

## Local development

Requirements: Node.js 20 or later and a local PostgreSQL database, or Docker
available to Testcontainers for the integration tests.

1. Copy `.env.example` to `.env` and set `DATABASE_URL` to a development
   PostgreSQL database. Create `.secrets/session-secret` with at least 32
   random bytes. For first-time setup, configure both bootstrap administrator
   secret-file settings; remove them after confirming the Administrator can
   sign in.
2. Install dependencies with `npm ci`.
3. Apply the checked-in PostgreSQL migrations with `npm run db:migrate`.
4. Start the API with `npm run dev`.
5. Open `/healthz`, `/readyz`, `/openapi.json`, or `/docs/` on the configured
   host and port.

`npm test` runs HTTP integration tests against disposable PostgreSQL
Testcontainers. `npm run typecheck` checks the TypeScript sources, and
`npm run build` creates the production JavaScript output.