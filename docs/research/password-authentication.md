# Authentication, Authorization & Deployment Security — Single-Household MVP

Research for [#4](https://github.com/andikon/HomeOrg/issues/4), part of the [Wayfinder map](https://github.com/andikon/HomeOrg/issues/1).

**Scope:** TypeScript/Node.js API for a self-hosted, single-Household organization app. No public
self-registration; a Household Administrator provisions Members and can reset their passwords.
Docker Compose + PostgreSQL, behind host Nginx terminating public HTTPS, on Ubuntu.

---

## 1. Secure Password Handling

### Hashing algorithm & parameters

OWASP's Password Storage Cheat Sheet gives a clear, current priority order:

> "Use Argon2id with a minimum configuration of 19 MiB of memory, an iteration count of 2, and 1
> degree of parallelism. If Argon2id is not available, use scrypt … For legacy systems using
> bcrypt, use a work factor of 10 or more and with a password limit of 72 bytes." — [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

**Recommendation: Argon2id**, via the [`argon2`](https://github.com/ranisalt/node-argon2) npm
package (native bindings to the PHC reference implementation, first-class TypeScript typings,
prebuilt binaries for common Linux/Docker base images). Its default `argon2.hash()` parameters
already follow the Argon2 team's own recommendations, so no manual tuning is required for this
workload — "By default, argon2.hash will generate secure hashes according to the security
recommendations… For password hashing, there is no need to modify them." — [node-argon2 README](https://github.com/ranisalt/node-argon2)

Argon2id is preferred over `bcrypt` (npm [`bcrypt`](https://github.com/kelektiv/node.bcrypt.js))
because bcrypt silently truncates input at 72 bytes and has no memory-hardness against GPU/ASIC
cracking — both cited as concerns in the same cheat sheet and in the bcrypt package's own security
notes: "only the first 72 bytes of a string are used. Any extra bytes are ignored…" — [node.bcrypt.js README](https://github.com/kelektiv/node.bcrypt.js). If Argon2 native bindings ever fail to build in the
Docker image (e.g. musl/Alpine edge cases), bcrypt with a work factor ≥ 10 is an acceptable fallback
per the same OWASP guidance above — do not fall back to plain SHA-256/HMAC, which OWASP explicitly
rules out as "not suitable for password storage" because they are fast, not memory-hard.

Store only the algorithm's self-describing hash string (includes salt + parameters) in a single
`password_hash` column; never store salts separately or roll your own salting — the library
handles per-password random salt generation internally ([OWASP Password Storage Cheat Sheet — Salting](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)).

### Password policy

NIST SP 800-63B and the OWASP Authentication Cheat Sheet converge on the same modern guidance,
which directly overturns older "complexity + rotation" norms:

- **Minimum length ≥ 8 characters if MFA is enabled; ≥ 15 characters if not** — this MVP has no
  MFA, so enforce **15-character minimum** ([OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), citing [NIST SP 800-63B §Password Verifiers](https://pages.nist.gov/800-63-4/sp800-63b.html#passwordver)). If a 15-char minimum is judged too strict for a household app,
  at minimum enforce 12+ with a breached-password check.
- **Maximum length ≥ 64 characters** to allow passphrases, without silent truncation ([NIST SP 800-63B §Password Length](https://pages.nist.gov/800-63-4/sp800-63b.html#passwordlength); [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)).
- **No composition rules** (no forced upper/lower/digit/symbol mix) and **no periodic forced
  rotation** — "Avoid requiring periodic password changes; instead, encourage users to pick strong
  passwords… NIST guidelines [state] verifiers should not mandate arbitrary password changes." — [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- **Screen against known-breached/common passwords** (e.g. a local copy of the top-N breached list,
  or a library like [`zxcvbn-ts`](https://github.com/zxcvbn-ts/zxcvbn) for strength estimation) — recommended by both NIST and OWASP ([OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)).
- Allow all characters, including Unicode and whitespace; never silently truncate — pass the raw
  UTF-8 password straight to Argon2id (no length limit issue, unlike bcrypt's 72-byte cap) ([OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)).
- Compare hashes only via the library's constant-time `verify()` function; never do manual
  string/byte comparison ([OWASP Authentication Cheat Sheet — Compare Password Hashes Using Safe Functions](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)).

---

## 2. Authentication & Session Approach

### Stateful sessions vs. JWT — recommendation

**Use stateful, server-side sessions with an HttpOnly, Secure, SameSite cookie holding an opaque
session ID**, backed by a PostgreSQL-stored session table (e.g. `connect-pg-simple` style schema),
**not** JWT bearer tokens, for this deployment. Rationale:

- The OWASP JWT Cheat Sheet itself flags this pattern as commonly misapplied: "A JWT is often
  suggested for 'stateless' user sessions. However… you will need a solution for managing session
  invalidation… user sessions won't be completely stateless anymore which might defeat the benefits
  of stateless sessions." It links to the widely-cited critique ["Stop using JWT for sessions"](http://cryto.net/~joepie91/blog/2016/06/13/stop-using-jwt-for-sessions/) — [OWASP JSON Web Token Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_Cheat_Sheet.html).
- JWTs shine for stateless, multi-service, federated, or third-party-audience scenarios (e.g. OAuth
  2.0 access tokens per [RFC 9068](https://datatracker.ietf.org/doc/html/rfc9068), or OIDC ID tokens
  per [RFC 7519](https://datatracker.ietf.org/doc/html/rfc7519)) — none of which apply here: this is
  a single first-party API with one PostgreSQL database already in the stack, so a session store adds
  negligible operational cost and buys instant, reliable server-side revocation (immediate logout,
  instant admin-forced password-reset invalidation, no token-expiry/refresh complexity).
- OWASP's Session Management Cheat Sheet requirement of ≥ 64 bits of CSPRNG entropy for session IDs
  is trivially met by standard session middleware ([OWASP Session Management Cheat Sheet — Session ID Entropy](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)), and cookies remain the
  recommended session-ID exchange mechanism over URL parameters or custom headers because they
  support secure attributes and constrained scope ([OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), citing cookie RFCs [2965](https://www.ietf.org/rfc/rfc2965.txt) & [6265](https://datatracker.ietf.org/doc/html/rfc6265)).

### Cookie flags (RFC 6265 + OWASP)

Set on the session cookie:
- `Secure` — cookie is only sent over TLS, mandated by OWASP session management guidance to protect
  the session ID from network disclosure ([OWASP Session Management Cheat Sheet — Transport Layer Security](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html); attribute defined in [RFC 6265 §4.1.2.5](https://datatracker.ietf.org/doc/html/rfc6265)).
- `HttpOnly` — blocks JavaScript access, mitigating session-cookie theft via XSS ([RFC 6265 §4.1.2.6](https://datatracker.ietf.org/doc/html/rfc6265)).
- `SameSite=Lax` (or `Strict` if the SPA/API are always same-site and there's no need to follow
  cross-site links into an authenticated GET) — reduces CSRF exposure at the cookie layer; this is
  a browser-level defense, not a substitute for below.
- Do **not** use the default framework session cookie name (e.g. `connect.sid`); rename it to avoid
  trivial framework fingerprinting ([OWASP Session Management Cheat Sheet — Session ID Name Fingerprinting](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)).
- Regenerate the session ID (not just its data) on login to prevent session fixation, and again on
  privilege change — a foundational session-management control ([OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)).

### CSRF considerations

Because authentication state travels in a cookie, this app **is** CSRF-exposed and needs an explicit
defense, per OWASP: "CSRF tokens are still essential for web applications that rely on cookies for
authentication." — [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
Recommended layered defense for this API:
1. **Synchronizer token pattern**: issue a per-session CSRF token on login, require it in a custom
   header (e.g. `X-CSRF-Token`) on all state-changing (`POST`/`PUT`/`PATCH`/`DELETE`) requests, and
   reject requests missing/mismatching it — the primary technique recommended by OWASP ([OWASP CSRF Prevention Cheat Sheet — Synchronizer Token Pattern](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)).
2. As defense-in-depth, since `SameSite=Lax/Strict` already blocks most cross-site cookie-carrying
   requests in modern browsers, treat the CSRF token as the primary control and SameSite as a backstop
   (not vice versa), since XSS can defeat SameSite entirely if it can read the CSRF token from the DOM
   too — OWASP explicitly warns "XSS can defeat all CSRF mitigation techniques" ([OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)).

### Login endpoint behavior, brute-force defenses

- Transmit credentials only via `POST` body over TLS — never in the URL/query string — and require
  TLS for the login page itself and every authenticated route, since sending it over plaintext HTTP
  "allows an attacker to modify the login form action" or read the session cookie in transit ([OWASP Authentication Cheat Sheet — Transmit Passwords Only Over TLS](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)).
- On failed login, return a **generic, identical error** ("Invalid email or password") regardless of
  whether the email exists, to avoid user enumeration; keep timing consistent to avoid timing-based
  enumeration too — this mirrors the Forgot Password Cheat Sheet's enumeration guidance, which is a
  general anti-enumeration principle applicable to any auth endpoint ([OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)).
- Rate-limit and lock out/backoff per-account and per-IP on repeated failures. Since a
  single-household deployment has a tiny, fixed user set, prioritize simple, effective controls from
  the OWASP Credential Stuffing Prevention Cheat Sheet's "alternative defenses" list (MFA is called
  the best defense generally, but is optional for a v1 MVP): exponential backoff or temporary
  lockout after N failed attempts per account, plus a coarser per-IP rate limit at the reverse proxy
  or app layer ([OWASP Credential Stuffing Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html)).
- On password change, require re-entry of the *current* password before accepting a new one, to
  defend against session-hijacking/CSRF-driven silent takeover — "Current password verification…
  to ensure that it's the legitimate user who is changing the password" ([OWASP Authentication Cheat Sheet — Change Password Feature](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)).

### Logout / session invalidation

- `POST /logout` must destroy the server-side session record (delete the row in the session store),
  not just clear the cookie client-side, and reissue an expired `Set-Cookie` to clear the browser
  copy — this is the whole point of a stateful session versus a JWT, and is explicitly why OWASP
  flags JWT-based "session" schemes as needing an ad hoc deny-list to achieve the same effect ([OWASP JSON Web Token Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_Cheat_Sheet.html)).
- On an admin-driven password reset, invalidate all existing sessions for that Member immediately
  (delete all their session rows) — consistent with the Forgot Password Cheat Sheet's advice to
  "invalidate the sessions automatically" after a reset ([OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)).

---

## 3. Authorization Rules (Member vs. Household Administrator)

This is a **single-tenant** deployment (one Household), so full multi-tenant RBAC/ABAC machinery is
unnecessary — OWASP's Authorization Cheat Sheet frames the core requirement simply as enforcing
**least privilege**: "assigning users only the minimum privileges necessary to complete their
job… Least Privileges must be applied both horizontally and vertically." — [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)

**Recommended model:**
- A single `role` column/enum on the Member row: `member | admin` (or a boolean `is_admin`, which is
  equivalent here since there are exactly two roles and no hierarchy beyond them). This matches
  general RBAC guidance to model roles as a first-class, centrally enforced attribute rather than
  scattering ad hoc checks — see NIST's foundational role-based access control model, which defines
  authorization as verifying "a requested action or service is approved for a specific entity," with
  roles as the unit of grouping permissions ([OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), citing [NIST glossary — Authorization](https://csrc.nist.gov/glossary/term/authorization)).
- Enforce it via **route/middleware guards**, not scattered `if` checks in handlers: a
  `requireAuth` middleware establishes `req.user` from the session, and a `requireAdmin` middleware
  (composed after it) gates admin-only routes (`POST /members`, `POST /members/:id/reset-password`,
  member deactivation, etc.). Centralizing checks in middleware is the concrete mechanism for OWASP's
  broader access-control-by-design and "deny by default" recommendations, and avoids the classic
  broken-access-control failure mode where an endpoint added later forgets its check — OWASP notes
  Broken Access Control is the #1 ranked risk in the [OWASP Top 10 (2021)](https://owasp.org/Top10/A01_2021-Broken_Access_Control/), cited directly in the [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).
- Since there's only one Household, you can skip household/tenant-scoping checks on every query, but
  **still explicitly check "does this Member own this resource"** for any per-Member data (e.g. a
  Member editing another Member's private notes) to prevent horizontal privilege escalation between
  Members — "Horizontal privilege elevation (i.e. being able to access another user's resources) is
  an especially common weakness" ([OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)).
- Fail closed: unauthenticated or wrong-role requests get `401`/`403` before any business logic
  executes; do not rely on the frontend to hide admin-only UI as the actual control.

---

## 4. Bootstrap & Reset Mechanics

### Creating the first Household Administrator

There is no public registration, so the very first admin account cannot come through a normal API
flow. Recommended approach for a Docker Compose / self-hosted deployment:

- **Environment-variable-seeded bootstrap on first startup**: the API container reads
  `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` (or a generated one-time password printed to
  container logs) from Compose environment/secrets, and a startup routine creates the admin Member
  row **only if the Members table is empty**, hashing the password with Argon2id exactly as for any
  other Member. This keeps the operator (self-hoster) fully in control of the credential without
  building any email-based recovery infrastructure, and treats the docker-compose `.env`/secrets
  file with the same handling rigor recommended for any credential-bearing config.
- Alternatively, a **one-time setup token/CLI command** (`npm run create-admin` executed once inside
  the container) is equally valid and slightly safer operationally because it avoids a long-lived
  plaintext password sitting in `docker-compose.yml`/`.env`; prefer this if the deployment already
  requires shell access for initial setup.
- Either way: after first use, disable the seed path (guard on "table not empty") so it cannot be
  replayed to silently recreate/overwrite an admin, and require the admin to change the bootstrap
  password on first login (standard "initial credential is single-use" hygiene).

This substitutes for self-registration/email verification, which OWASP's identity-proofing framing
assumes exists for public-facing apps but is unnecessary here since the operator *is* the trusted
identity source for the one Household.

### Admin-driven Member password reset (no email infrastructure)

The OWASP Forgot Password Cheat Sheet is written for the self-service, email/SMS-token flow, but its
underlying goals justify why an **admin-set-password model is a reasonable, simpler substitute**
here:

- Its core requirements — that reset tokens be "randomly generated using a cryptographically safe
  algorithm," "single use," "stored securely," and that "no change [is made] to the account until a
  valid token is presented" — are all really about *proving the requester's identity before mutating
  credentials* ([OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)). In this app, the **Administrator's own authenticated, `requireAdmin`-gated
  session** already *is* that strong identity proof — a human who personally knows and trusts the
  household members, performing the reset in-app after their own login — so a side-channel
  email/SMS token adds no additional assurance and would be operational overhead this MVP doesn't
  need (no mail server, no deliverability/spam concerns, no token-expiry edge cases).
- **Recommended flow**: `POST /members/:id/reset-password` (admin-only, requires the admin's current
  password to defend against a hijacked admin session, per the Change Password Feature guidance
  above) either (a) sets a new admin-chosen or randomly generated temporary password directly, hashed
  with Argon2id before storage, and forces `must_change_password = true` on that Member so they are
  required to set their own password at next login, or (b) issues a short-lived, single-use,
  cryptographically random reset link (same entropy/expiry/single-use requirements as the OWASP
  cheat sheet lists) that the admin manually relays to the Member out-of-band (in person, chat,
  paper) instead of via automated email — this keeps the "side-channel" delivery requirement from the
  cheat sheet while removing the need for a mail server ([OWASP Forgot Password Cheat Sheet — General Security Practices](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)).
- In both cases: **invalidate all existing sessions** for that Member immediately, and require the
  Member to set a genuinely new password (not auto-login them) — "Don't automatically log the user
  in, as this introduces additional complexity… and increases the likelihood of introducing
  vulnerabilities" ([OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)).
- Do not silently email/notify anything (no mail infra), but do log the admin-initiated reset event
  for audit purposes so any Member can ask "who reset my password and when."

---

## 5. API and Deployment Implications

### Endpoint design & error messages

- `POST /login`, `POST /logout`, `POST /members/me/password` (self-service change, requires current
  password), `POST /members` (admin-only create), `POST /members/:id/reset-password` (admin-only).
- Use **uniform, generic error responses** on `/login` ("invalid email or password") to prevent
  account enumeration, and equally on any admin-facing "does this email already exist" check surface
  it only to the admin role, never to an unauthenticated caller — generalizing the anti-enumeration
  principle from the [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
- Never log plaintext passwords or full session tokens; log only event metadata (member id, action,
  timestamp, source IP).

### TLS/HSTS enforcement

- Terminate TLS at host Nginx with modern config: TLS 1.3 preferred, TLS 1.2 fallback only, AEAD
  cipher suites only, TLS 1.0/1.1 disabled — "Web applications must default to TLS 1.3 and may
  support TLS 1.2 for compatibility. TLS 1.0 and TLS 1.1 are formally deprecated by RFC 8996… and
  must be disabled." — [OWASP Transport Layer Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html), citing [RFC 8996](https://datatracker.ietf.org/doc/html/rfc8996). Mozilla's
  [SSL Configuration Generator](https://ssl-config.mozilla.org/) is referenced by the same cheat sheet as a practical way to produce a
  compliant Nginx config for the installed Nginx/OpenSSL version.
- Send `Strict-Transport-Security: max-age=63072000; includeSubDomains` (add `preload` only after
  confirming every subdomain is permanently HTTPS-only, since it has "PERMANENT CONSEQUENCES") —
  [OWASP HTTP Strict Transport Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Strict_Transport_Security_Cheat_Sheet.html), formalized in [RFC 6797](http://tools.ietf.org/html/rfc6797).
- Also set baseline hardening headers at Nginx or the app: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and `Cache-Control: no-store` on any response
  carrying session/auth data, per the [OWASP HTTP Headers Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html).
- Never allow the session to run over a mixed HTTP/HTTPS path or switch mid-session — "Do not switch
  a given session from HTTP to HTTPS, or vice-versa, as this will disclose the session ID in the
  clear" ([OWASP Session Management Cheat Sheet — Transport Layer Security](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)).

### Nginx ↔ Node.js proxying: headers, `trust proxy`, cookies

- Nginx (the public HTTPS edge) must forward standard proxy headers, e.g.:
  ```
  location / {
      proxy_pass       http://api:3000;
      proxy_set_header Host              $host;
      proxy_set_header X-Real-IP         $remote_addr;
      proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
  }
  ```
  based on the official [Nginx `ngx_http_proxy_module` documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) (`proxy_set_header` directive and its example
  configuration for `Host`/`X-Real-IP`).
- In the Node/Express app, set `app.set('trust proxy', ...)` to a **specific, narrow value** (e.g.
  the Docker internal subnet/`linklocal`/the Nginx container's address) rather than blanket `true`,
  and rely on `X-Forwarded-Proto` to correctly detect HTTPS for `Secure`-cookie logic and any
  HTTPS-redirect middleware. Express's own docs warn: "When setting to `true`, it is important to
  ensure that the last reverse proxy trusted is removing/overwriting all of the following HTTP
  headers: `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto`, otherwise it may be
  possible for the client to provide any value." — [Express — Express behind proxies](https://expressjs.com/en/guide/behind-proxies/). In a Docker Compose
  deployment where only Nginx can reach the API container, scoping `trust proxy` to the compose
  network's fixed proxy address (rather than `true`) removes the spoofing risk entirely.
- Because TLS terminates at Nginx and the Nginx↔API hop inside Compose is plain HTTP over the
  internal Docker network, the session cookie's `Secure` flag must be set based on the **original**
  scheme (`X-Forwarded-Proto`), not the internal connection's scheme — this is exactly why `trust
  proxy` must be configured correctly, otherwise `req.secure` will be `false` and the app may either
  reject the cookie or, worse, downgrade it to non-`Secure`.
- Keep the Docker Compose network topology such that PostgreSQL and the session store are **not**
  published on host ports — only Nginx is publicly reachable; the API and DB communicate over the
  internal Compose network — a straightforward extension of least-privilege network exposure
  consistent with the access-control principle above ([OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)).

---

## Decision Gist

Use Argon2id-hashed passwords with a 15-character minimum and no forced rotation, authenticate Members via server-side sessions in `Secure`/`HttpOnly`/`SameSite` cookies (with CSRF tokens) rather than JWTs, enforce a simple `member`/`admin` role via centralized middleware guards, bootstrap the first Household Administrator from an environment-seeded one-time setup step, let that Administrator directly reset Member passwords (invalidating sessions) in lieu of email-based recovery, and terminate TLS with HSTS at Nginx while forwarding `X-Forwarded-Proto` to a narrowly-scoped Express `trust proxy` setting so cookies stay secure end-to-end.
