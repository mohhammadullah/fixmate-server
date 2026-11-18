# Backend Deployment Guide

This document lists every environment variable, build step and external
dependency required to deploy the FixMate server to a Node.js-capable host
(Render, Railway, Fly.io, self-hosted VPS, etc.) or to run it against
MongoDB Atlas in production. None of the values below are committed to this
repository. Fill them in at the host's dashboard, in a private CI secret,
or in a gitignored `.env`.

## Build and run commands

| Step            | Command                                              |
| --------------- | ---------------------------------------------------- |
| Install         | `npm ci`                                             |
| Type-check      | `npm run type-check` (good to run pre-deploy)        |
| Build           | `npm run build` (`tsc` → `dist/`)                    |
| Start (prod)    | `npm start` (`node dist/server.js`)                  |
| Health check    | `GET /api/health` → `200 OK …`                       |
| Test (pre-flight) | `npm run build && npm test` (see caveats below)    |

The server **requires `npm run build` before the isolated test suites will
run** — suites spawn `../dist/server.js` / import `../dist`.

Node version: **≥ 20.x** (LTS recommended: 22.x).

## Required environment variables

These are **mandatory** — the server refuses to boot without them
(`src/config/env.ts` validates and exits).

| Variable              | Scope                    | Example value                                             | Required by     |
| --------------------- | ------------------------ | --------------------------------------------------------- | --------------- |
| `NODE_ENV`            | runtime                  | `production`                                              | boot            |
| `PORT`                | runtime                  | `5000` (or the platform's injected `PORT`)                | boot            |
| `CLIENT_URL`          | runtime → CORS           | `https://fixmate.example.com`                              | CORS + Better Auth trusted origin |
| `MONGODB_URI`         | infra                    | `mongodb+srv://user:…@cluster…/`                          | Mongo connectivity |
| `MONGODB_DB_NAME`     | infra                    | `fixmate`                                                  | Mongo connectivity |
| `BETTER_AUTH_URL`     | runtime → JWT issuer     | `https://fixmate-api.example.com`                          | JWT issuer/audience for every token |
| `BETTER_AUTH_SECRET`  | **secret**               | `openssl rand -base64 32`                                 | JWT signing/verification |
| `IMGBB_API_KEY`       | **secret** (optional)    | from <https://api.imgbb.com/>                              | ImgBB proxy endpoints |
| `STRIPE_SECRET_KEY`   | **secret** (optional)    | from <https://dashboard.com/apikeys>                       | Stripe Checkout |
| `STRIPE_WEBHOOK_SECRET` | **secret** (optional)  | from `stripe listen` (dev) or Dashboard → Webhooks (prod) | Stripe webhook signature |

Optional configuration:

| Variable                | Default                  | Notes                                                     |
| ----------------------- | ------------------------ | --------------------------------------------------------- |
| `STRIPE_CURRENCY`       | `usd`                    | lowercase ISO 4217; `bdt` only if your Stripe account supports charging in BDT |
| `STRIPE_API_BASE`       | (unset)                  | **test-only** host override; never set in production |
| `IMGBB_UPLOAD_URL`      | `https://api.imgbb.com/1/upload` | override for testing with a mocked ImgBB server |

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
  nothing manual is required. The `bookings`
  `bookings_active_customer_service_unique` partial index is the reason the
  constraint on duplicate active bookings cannot be bypassed by
  application-level races.

## Stripe webhook

- Create a Dashboard → Developers → Webhooks endpoint at
  `https://<YOUR_DOMAIN>/api/payments/webhook`.
- Subscribe to: `checkout.session.completed`, `checkout.session.expired`,
  `checkout.session.async_payment_failed`.
- Copy the signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
- The endpoint **verifies the signature** with the raw request body before
  calling any business logic. A wrong, missing or expired signature returns
  400/401. The raw body is mounted upstream of `express.json()` in
  `src/app.ts`; do not add body-parsing middleware above it.
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

- `trust proxy: 1` is set in `src/app.ts` — one hop of trusted proxy is
  assumed. If you deploy behind a different number of hops (e.g.
  Cloudflare + nginx), raise the hop count accordingly so
  `express-rate-limit` can key on the true client IP.
- Better Auth runs its own, path-aware rate limiting on `/api/auth`
  (explicit configuration in `src/config/auth.ts`): 10 sign-in/sign-up
  attempts per minute per client IP in production, 5 per 5 minutes for
  email-recovery endpoints, and a generous 100/minute general budget.
  Express does **not** add a second limiter on those paths.
- Better Auth reads `X-Forwarded-For` itself (Express's `trust proxy` does
  not apply to it). Set `TRUSTED_PROXIES=<proxy IPs/CIDRs>` in production
  so it can resolve the real client IP from a multi-hop proxy chain.
  Without it (or without `X-Forwarded-For` at all), Better Auth falls back
  to a **single shared bucket** for all users and sign-in will start
  returning 429 for everyone after the budget is spent.
- Rate-limit counters are stored in per-process memory. With more than one
  replica, raise `rateLimit.storage` in `src/config/auth.ts` to `database`
  (or a shared secondary storage) so the budget is shared across replicas.
- `helmet` sets sensible defaults (CSP, `X-Frame-Options: SAMEORIGIN`, …).
- `x-powered-by` is disabled.
- The server is compatible with HTTP/1.1 and HTTP/2 fronting; termination is
  expected at the reverse proxy or platform (Fly.io/Render already handle
  this).

## Health check

`GET /api/health` returns `200 { success: true, message: "FixMate server is
healthy!", timestamp: "…" }`. Use this for the platform's readiness/liveness
probe.

## Known blockers / caveats

- **Replica set is mandatory** for the Main Admin transfer and admin
  demotion transactions. A standalone mongod (even a single-node
  `mongodb:4.4`) throws `MongoServerError: Only servers in a sharded
  cluster can start a new transaction` — the endpoints fail closed with
  503.
- **Smoke-test password:** the built-in test harness requires
  `TEST_USER_PASSWORD` to be set to the password of
  `fixmate.test@example.com`. Without it the suite stops at sign-in. All
  other suites pass without any external password.
- **ImgBB is a single point of failure** for service-image upload. Without
  `IMGBB_API_KEY` uploads return 503 against `POST /api/uploads/image` —
  the rest of the product keeps working.
- **Test-mode Stripe only** by default — rotate to live keys only after
  confirming real transactions with real card numbers (and the resulting
  webhook signatures) end-to-end.
- **`.env` must never be committed.** `.env.example` is the only committed
  artifact from the `.env.*` family — it contains placeholders, not
  secrets.

## Suggested Vercel/Render split

FixMate is deployed as **two separate repositories** — never as a monorepo:

- **Client (Vercel)** — `fixmate-client` → <https://vercel.com/new>
  - Framework: Next.js (auto-detected)
  - Env: `NEXT_PUBLIC_API_URL=https://<your-server-domain>`
- **Server (Render)** — `fixmate-server` → <https://render.com/new>
  - Build: `npm run build`
  - Start: `npm start`
  - Health check path: `/api/health`
  - Env: all REQUIRED variables from the table above
- **Database (MongoDB Atlas)** — M0 free tier is sufficient for a demo

The two repositories reference each other only through the public URLs
above; neither imports code from the other and neither shares a package
manager manifest.
