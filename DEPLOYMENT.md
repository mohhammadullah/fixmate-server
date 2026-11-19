# Backend Deployment Guide

This document lists every environment variable, build step and external
dependency required to deploy the FixMate server to a Node.js-capable host
(Render, Railway, Fly.io, self-hosted VPS, etc.) or to run it against
MongoDB Atlas in production. None of the values below are committed to this
repository. Fill them in at the host's dashboard, in a private CI secret,
or in a gitignored `.env`.

## Build and run commands

| Step              | Command                                                        |
| ----------------- | -------------------------------------------------------------- |
| Install           | `npm ci`                                                       |
| Type-check        | `npm run type-check` (good to run pre-deploy)                  |
| Build             | `npm run build` (`tsc` → `dist/`)                              |
| Start (prod)      | `npm start` (`node dist/server.js`)                            |
| Liveness check    | `GET /api/health` → `200 OK` (lightweight, no DB dependency)   |
| Readiness check   | `GET /api/ready` → `200` when ready, `503` when not ready      |
| Test (pre-flight) | `npm run build && npm test` (see caveats below)                |
| Config guards     | `npm run build && node scripts/config-guard-test.mjs` (no DB writes) |

The server **requires `npm run build` before the isolated test suites will
run** — suites spawn `../dist/server.js` / import `../dist`.

Node version: **≥ 20.x** (LTS recommended: 22.x).

## Required environment variables

These are **mandatory** — the server refuses to boot without them
(`src/config/env.ts` validates and exits).

| Variable              | Scope                    | Example value                                             | Required by     |
| --------------------- | ------------------------ | --------------------------------------------------------- | --------------- |
| `NODE_ENV`            | runtime                  | `production` (must be explicit — unset stays `development`) | boot / prod-only behavior |
| `PORT`                | runtime                  | `5000` (or the platform's injected `PORT`)                | boot            |
| `CLIENT_URL`          | runtime → CORS           | `https://fixmate.example.com`                              | CORS + Better Auth trusted origin |
| `MONGODB_URI`         | infra                    | `mongodb+srv://user:…@cluster…/`                          | Mongo connectivity |
| `MONGODB_DB_NAME`     | infra                    | `fixmate`                                                  | Mongo connectivity |
| `BETTER_AUTH_URL`     | runtime → JWT issuer     | `https://fixmate-api.example.com`                          | JWT issuer/audience for every token |
| `BETTER_AUTH_SECRET`  | **secret**               | `openssl rand -base64 32`                                 | JWT signing/verification |
| `IMGBB_API_KEY`       | **secret** (optional)    | from <https://api.imgbb.com/>                              | ImgBB proxy endpoints |
| `STRIPE_SECRET_KEY`   | **secret** (optional)    | from <https://dashboard.com/apikeys>                       | Stripe Checkout |
| `STRIPE_WEBHOOK_SECRET` | **secret** (optional)  | from `stripe listen` (dev) or Dashboard → Webhooks (prod) | Stripe webhook signature |
| `TRUST_PROXY`         | runtime (optional)       | `1` (hop count) or `10.0.0.0/8,192.168.1.10`               | Express/rate-limit client IP resolution; must match proxy topology |
| `TRUSTED_PROXIES`     | runtime (optional)       | `10.0.0.0/8,192.168.1.10`                                  | Better Auth client IP resolution from `X-Forwarded-For` |

`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` must be configured **as a
pair** or both omitted. A partial configuration fails startup so an unpayable
Checkout Session can never be created. `CLIENT_URL` and `BETTER_AUTH_URL` must
be public HTTPS URLs in production (loopback HTTP is allowed only for isolated
production-mode tests). `STRIPE_API_BASE` and `IMGBB_UPLOAD_URL` are test-only
overrides and are rejected when `NODE_ENV=production`.

Optional configuration:

| Variable                | Default                  | Notes                                                     |
| ----------------------- | ------------------------ | --------------------------------------------------------- |
| `STRIPE_CURRENCY`       | `usd`                    | lowercase ISO 4217; `bdt` only if your Stripe account supports charging in BDT |
| `STRIPE_API_BASE`       | (unset)                  | **test-only** host override; never set in production |
| `IMGBB_UPLOAD_URL`      | `https://api.imgbb.com/1/upload` | override for testing with a mocked ImgBB server |
| `INVOICE_TAX_RATE`      | (unset)                  | optional platform tax rate (e.g. `0.05`), applied **inclusive** to invoices |

The pattern is always **server-only** — no secret is ever exposed through
`NEXT_PUBLIC_*` (client), inlined in a client bundle, or logged.

## MongoDB Atlas (or any replica set)

- Create a free M0 (or larger) cluster at <https://cloud.mongodb.com/>.
- Network Access → allow your deploy target's outbound IP, or at minimum
  `0.0.0.0/0` for a class demo (tighten later).
- Database Access → create a least-privilege user (`readWrite` on the
  deployment DB only; not Atlas admin).
- Copy the connection string into `MONGODB_URI`. Append
  `?retryWrites=true&w=majority` if not already present and **use the
  replica-set style SRV string** — transactions need it.
- The server creates its indexes once at startup via `ensureIndexes()` —
  nothing manual is required. Index creation is **fatal**: the server refuses
  to accept traffic if any required index cannot be created.
- **Safe recovery for duplicate legacy records:** if startup fails because
  duplicates block a unique index, the error names the exact collection/index
  and conflicting key. Inspect the reported collection in MongoDB, identify
  the duplicate documents, and manually merge or remove only the conflicting
  legacy records you have verified are safe to remediate. Do not run automated
  destructive cleanup. Restart the server after remediation so index creation
  can complete.
- Critical indexes include booking/payment uniqueness guards (e.g.
  `bookings_active_customer_service_unique`,
  `bookings_technician_schedule_active_unique`, pending/succeeded payment
  uniqueness indexes) and query-support indexes for reviews, technician
  payments, and settled per-customer coupon redemption counting on `payments`
  (`payments_customerId_1_status_1_appliedCoupon_code_1`). The bookings
  coupon partial index stores booking-level coupon metadata; redemption-limit
  enforcement is based on settled successful payment records.

## Stripe webhook

- Create a Dashboard → Developers → Webhooks endpoint at
  `https://<YOUR_DOMAIN>/api/payments/webhook`.
- Subscribe to: `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`,
  **`charge.refunded`** (required for refund reconciliation).
- Copy the signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
- The endpoint **verifies the Stripe signature** with the raw request body
  before calling any business logic. A wrong, missing or expired signature is
  rejected. The raw body is mounted upstream of `express.json()` in
  `src/app.ts`; do not add body-parsing middleware above it.
- The webhook path is exempted from the general per-IP API rate limiter so
  legitimate Stripe deliveries/retries are not blocked; request size limits
  and signature verification remain in place.
- `stripe listen --forward-to http://localhost:5000/api/payments/webhook`
  for local development (prints a `whsec_…` you can use in `.env`).

## Better Auth and CORS

- `BETTER_AUTH_URL` is the issuer and audience embedded in every JWT.
  Setting it to the **public URL** of the server (e.g.
  `https://fixmate-api.example.com`) is required for JWTs to verify on the
  client machine that talks to both the browser's origin and the API.
- `CLIENT_URL` is trusted by Better Auth for CORS (`origin`) and for the
  `callbackURL` Better Auth returns after sign-in. Set it to the public
  client origin.
- The client's `NEXT_PUBLIC_API_URL` must point at the same server, or
  Better Auth will refuse to issue tokens and the browser will block CORS.

## Reverse proxy and headers

- **Proxy configuration assumptions:** Express and Better Auth resolve client
  IPs differently. Set `TRUST_PROXY` (Express `trust proxy`) to the correct
  hop count or trusted proxy address/CIDR list for your deployment so
  `express-rate-limit` keys on the real client IP. Set `TRUSTED_PROXIES` for
  Better Auth's `/api/auth` rate limiting and IP resolution. These must
  reflect the same actual proxy topology; do not trust all proxies.
- When `TRUST_PROXY` is unset, the server preserves the previous default of
  one trusted hop. Local direct-connection development remains supported.
- Better Auth runs its own, path-aware rate limiting on `/api/auth`
  (explicit configuration in `src/config/auth.ts`): 10 sign-in/sign-up
  attempts per minute per client IP in production, 5 per 5 minutes for
  email-recovery endpoints, and a generous 100/minute general budget.
  Express does **not** add a second limiter on those paths.
- **Rate-limit limitation (single instance):** Better Auth and Express
  rate-limit counters are stored in per-process memory. This provides
  per-instance protection only. If the backend runs with more than one
  instance/replica, limits are not shared across instances unless a shared
  store is configured in code/infrastructure. Socket.IO rooms are also
  per-process in the current architecture.
- `helmet` sets sensible defaults. `x-powered-by` is disabled.
- The server is compatible with HTTP/1.1 and HTTP/2 fronting; TLS
  termination is expected at the reverse proxy or platform.

## Socket.IO

- The server attaches Socket.IO at `/socket.io` (HTTP `GET` returns the
  handshake; transports `polling` + `websocket`).
- Clients must connect with the Better Auth JWT in the handshake
  (`auth.token`). The token is verified against the JWKS (`BETTER_AUTH_URL`)
  and the role is re-read from the database on every connection.
- Reverse proxies must forward `Upgrade` / `Connection` headers for the
  websocket path (usually already enabled for `/socket.io`), or clients
  fall back to long-polling automatically.
- In-memory rooms (`user:<hex>`, `booking:<hex>`) are per server process;
  multi-instance deployments would need a shared adapter (e.g. Redis) for
  cross-instance delivery. Single-instance deployments need nothing.

## Health checks

- **Liveness:** `GET /api/health` returns `200` with a lightweight JSON body
  (`{ success: true, status: "ok", timestamp }`). It does not query MongoDB
  and is exempt from the general API rate limiter. Use this for
  platform/container liveness probes.
- **Readiness:** `GET /api/ready` returns `200` when required dependencies are
  reachable (currently MongoDB ping) and `503` when not ready. It does not
  expose internal error details. Use this for readiness/dependency probes when
  your platform distinguishes them.

## Known blockers / caveats

- **Replica set is mandatory** for transactions and MongoDB-backed invariants.
  A standalone mongod can break transactional flows; the database must be a
  replica set / Atlas cluster.
- **Rate limiting and sockets are single-instance by default:** in-memory
  rate-limit buckets and Socket.IO rooms are not shared across replicas.
  Multi-instance deployments require shared infrastructure/adapters not added
  in this batch.
- **JWT/logout limitation:** authentication uses stateless JWTs verified by
  the server. Signing out clears the client session/token state but does not
  create a server-side revocation list; issued JWTs remain valid until their
  normal expiry.
- **Logging limitation:** the server uses lightweight console-based logging.
  Avoid logging secrets, tokens, auth headers, or sensitive customer/payment
  details; prefer structured operational messages where available.
- **ImgBB is optional:** without `IMGBB_API_KEY`, image upload endpoints
  return 503 while the rest of the product keeps working.
- **Stripe is optional for startup:** payment endpoints require complete Stripe
  configuration and verified webhooks; test-mode keys should be used until
  real end-to-end verification is complete.
- **`.env` must never be committed.** `.env.example` is the only committed
  env template and contains placeholders only.

## Suggested Vercel/Render split

FixMate is deployed as **two separate repositories** — never as a monorepo:

- **Client (Vercel)** — `fixmate-client`
  - Framework: Next.js (auto-detected)
  - Env: `NEXT_PUBLIC_API_URL=https://<your-server-domain>` and optionally
    `NEXT_PUBLIC_SITE_URL=https://<your-client-domain>` for canonical/SEO URLs
- **Server (persistent Node.js host, e.g. Render/Railway/Fly/VPS)** — `fixmate-server`
  - Build: `npm run build`
  - Start: `npm start`
  - Liveness probe: `/api/health` (or `/api/ready` when a readiness probe is supported)
  - Env: required variables above, plus proxy/Stripe/ImgBB settings as needed
- **Database (MongoDB Atlas)** — replica set required

The two repositories reference each other only through public URLs and do not
share code or package manifests. Verify the actual hosting platform's proxy
topology and configure `TRUST_PROXY` / `TRUSTED_PROXIES` accordingly.
