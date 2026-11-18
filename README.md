# FixMate Server

FixMate is a role-based application that connects customers who need home
appliance and device repairs with independent repair technicians. This
repository is the **backend API** — the client is a separate repository
(`fixmate-client`). Every state-changing decision is made server-side;
authorization is enforced with Better Auth session JWTs and, for
administrative actions, fresh database role/`isMainAdmin` checks. The
frontend is never trusted with ownership, role, status or amounts.

## Project overview

- Every customer request flows through exactly **four** application-owned
  MongoDB collections: `user` (Better Auth managed), `services`,
  `bookings`, `payments`. No extra collection is introduced anywhere in
  the codebase.
- Authentication is email + password via Better Auth. Session and API
  tokens are issued and verified locally; the public JWKS endpoint
  (`/api/auth/jwks`) signs and publishes the keys that the backend itself
  uses to verify incoming bearer tokens (`jose`).
- Four user roles: `customer`, `technician`, `admin`, and the singleton
  `mainAdmin` (stored as the `isMainAdmin: true` flag on an admin's `user`
  document). Capabilities are listed in [Roles & permissions](#roles--permissions).
- Payments are handled through Stripe Checkout — the customer is redirected
  to Stripe's hosted page; only Stripe's verified webhook is able to mark a
  booking as paid.
- Technician service images are proxied to ImgBB; the API key never leaves
  the server.
- Repository hosts: [fixmate-server](https://github.com/mohhammadullah/fixmate-server)
  (this repo) and [fixmate-client](https://github.com/mohhammadullah/fixmate-client).

## Technology stack

- **Runtime:** Node.js ≥ 20 (works on 20.x and 22.x)
- **HTTP:** Express 5
- **Database:** MongoDB (Atlas-compatible; **replica set required** for
  multi-document transactions — see below)
- **Auth:** Better Auth (email + password, JWT plugin, MongoDB adapter)
- **Validation:** Zod
- **Stripe:** official `stripe` SDK (Checkout + webhook signature)
- **Security:** helmet, CORS (single allowed origin), express-rate-limit,
  `trust proxy`
- **Image upload:** ImgBB (server-side proxy)
- **Language:** TypeScript (strict)
- **Testing:** self-hosted integration suites using `tsx`, `mongodb`,
  Node built-ins; no test framework required

## Project layout

```
src/
  app.ts                    # Express app composition (helmet, CORS, rate limit, raw webhook)
  server.ts                 # Boot: connectDB -> ensureIndexes -> createAuth -> listen
  config/                   # env, db, auth, indexes, stripe
  middleware/               # verifyToken, verifyCustomer, verifyTechnician, verifyAdmin, errorHandler
  models/                   # payment, service, booking, technician-application
  routes/                   # one router per resource
  controllers/              # request handlers
  validators/               # Zod schemas
  utils/                    # currency helpers
scripts/                    # operational + test scripts
```

## Backend setup

### 1. Prerequisites

- Node.js ≥ 20.x
- A MongoDB deployment that is a **replica set** (MongoDB Atlas free tier
  works). Multi-document transactions — used by the Main Admin transfer and
  admin demotion flows — require it. A standalone mongod will fail with
  `MongoServerError: Only servers in a sharded cluster can start a new
  transaction` unless you create a single-node replica set.
- npm

### 2. Clone and install

```bash
git clone https://github.com/mohhammadullah/fixmate-server.git
cd fixmate-server
npm install
```

### 3. Environment

Copy the template and fill it in with **real** values (never commit):

```bash
cp .env.example .env
```

See [Environment variables](#environment-variables) below. The server
**refuses to boot** if `BETTER_AUTH_SECRET`, `MONGODB_URI`, `MONGODB_DB_NAME`
or `BETTER_AUTH_URL` are missing or invalid.

### 4. Run

```bash
npm run dev          # tsx watch src/server.ts
# or
npm run build && npm start   # node dist/server.js
```

The server listens on `http://localhost:5000` by default. `GET /api/health`
returns `{ success: true, message: "FixMate server is healthy!" }`.

### 5. Create the first admin (bootstrap)

Public signup always creates a `customer`. To become the first admin — and
at the same time become the Main Admin — run the one-time bootstrap script.

1. Sign up the desired account through the app (or via
   `POST /api/auth/sign-up/email` with body `{ email, password, name }`).
2. Set **two** environment variables only for this single run:

   ```bash
   ADMIN_BOOTSTRAP_EMAIL=you@example.com
   ADMIN_BOOTSTRAP_CONFIRM=true
   ```

3. Run it:

   ```bash
   npm run bootstrap:admin
   ```

4. **Remove both `ADMIN_BOOTSTRAP_*` variables afterwards** and restart.

The script enforces: variables are explicitly set; the target user exists
exactly once and is `customer`-role; no password is accepted; the update is
atomic. If a Main Admin is already designated, the script promotes to admin
only and does not touch the Main Admin designation.

Additional recovery paths are available if the Main Admin is lost:
`ADMIN_BOOTSTRAP_DESIGNATE_MAIN=true ADMIN_BOOTSTRAP_EMAIL=<existing admin email>
ADMIN_BOOTSTRAP_CONFIRM=true npm run bootstrap:admin` — designates an existing
admin as Main Admin and refuses to overwrite an existing Main Admin.

### 6. Point the frontend at this server

Set `NEXT_PUBLIC_API_URL` in the client to this server's base URL (default
`http://localhost:5000`) and start the client at <http://localhost:3000>.

## Environment variables

All values are validated in `src/config/env.ts`. Never commit real secrets.

Required:

| Variable              | Example                                      | Notes                                       |
| --------------------- | -------------------------------------------- | ------------------------------------------- |
| `MONGODB_URI`         | `mongodb+srv://user:pass@cluster/dbname`     | MongoDB Atlas (or replica-set) connection |
| `MONGODB_DB_NAME`     | `fixmate`                                    | database name                              |
| `BETTER_AUTH_SECRET`  | 32+ random chars                             | generate with `openssl rand -base64 32`     |
| `BETTER_AUTH_URL`     | `http://localhost:5000` (dev) / `https://<server-domain>` (prod) | MUST match the public server URL — it is the issuer and audience of every JWT |
| `CLIENT_URL`          | `http://localhost:3000`                      | public client origin (CORS + Better Auth trusted origin) |
| `NODE_ENV`            | `development` / `test` / `production`        | `production` mounts no `/api/test/*` routes |
| `PORT`                | `5000`                                       | HTTP port                                  |

Optional (server refuses only the related endpoint, not boot):

| Variable                | Example                    | Notes                                     |
| ----------------------- | -------------------------- | ----------------------------------------- |
| `STRIPE_SECRET_KEY`     | `sk_test_...`              | Stripe API key (server-only)              |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...`                | signing secret for `POST /api/payments/webhook` |
| `STRIPE_CURRENCY`       | `usd` (default)            | lowercase ISO 4217 code for new sessions  |
| `STRIPE_API_BASE`       | `http://127.0.0.1:…`       | test-only Stripe API override (never prod) |
| `IMGBB_API_KEY`         | `abcd…`                    | ImgBB API key (server-only)               |
| `IMGBB_UPLOAD_URL`      | `https://api.imgbb.com/1/upload` | override for tests (default)             |

The real `.env` must never be committed. `.env.example` has the same shape
with placeholder values.

## Database collections

Exactly four application-owned collections. Nothing else is created by the
server, ever.

| Collection   | Purpose                                                                                                    | Key indexes                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `user`       | Better Auth user accounts + server-managed fields: `role`, `phone`, `area`, `bio`, `technicianApplication` (subdocument), `isMainAdmin` (boolean) | `{ technicianApplication.status: 1, technicianApplication.submittedAt: -1 }` |
| `services`   | Technicians' repair service listings (pending/approved/rejected)                                           | `{ technicianId: 1 }`, `{ category: 1 }`, `{ createdAt: -1 }`, `{ approvalStatus: 1, availabilityStatus: 1, category: 1 }` |
| `bookings`   | Customer booking lifecycle requests (`requested → accepted|rejected|cancelled, → in-progress → completed`) | `{ customerId: 1, serviceId: 1 }` partial unique (active statuses only), `{ technicianId: 1, status: 1 }`, `{ customerId: 1, status: 1 }`, `{ createdAt: -1 }` |
| `payments`   | Stripe Checkout records (`pending → succeeded|expired|failed`) tied to a booking; webhook-controlled only | `{ bookingId: 1 }` partial unique `pending` **and** `{ bookingId: 1 }` partial unique `succeeded`, `{ stripeSessionId: 1 }` unique sparse, `{ customerId: 1, createdAt: -1 }`, `{ status: 1, createdAt: -1 }` |

## Authentication and sessions

Better Auth manages everything at `/api/auth/*`:

- `POST /api/auth/sign-up/email` with `{ email, password, name }` — creates a
  `customer` account. The signup path never accepts or stores a `role`
  field; role escalation from signup is impossible by design and is
  regression-tested.
- `POST /api/auth/sign-in/email` — issues a session cookie.
- `GET /api/auth/token` — short-lived JWT for the Bearer header.
- `GET /api/auth/jwks` — public key material for signature verification.
- Every protected request first verifies the JWT via remote JWKS with
  `jose` (`algorithm: RS/ES` as issued by Better Auth), then **looks up the
  fresh role from the database**. The JWT claim is never trusted for
  authorization; a stale token carrying an old role grants nothing until the
  database agrees.
- Expired or tampered tokens return 401; a deleted user document returns
  401; an unreadable database returns 503.

## Roles & permissions

| Capability                                    | Customer | Technician | Admin | Main Admin |
| --------------------------------------------- | :------: | :--------: | :---: | :--------: |
| Browse services (approved + available)        |    ✓     |     ✓      |   ✓   |     ✓      |
| Book a service                                |    ✓     |     ✓      |   —   |     —      |
| Manage own bookings / cancel requested        |    ✓     |     —      |   —   |     —      |
| Submit own technician application              |    ✓     |     ✓*     |   —   |     —      |
| See own application & own profile              |    ✓     |     ✓      |   ✓   |     ✓      |
| Edit own profile (name/phone/area/bio)        |    ✓     |     ✓      |   ✓   |     ✓      |
| Publish services (technician CRUD)            |    —     |     ✓      |   —   |     —      |
| Upload own service image                      |    —     |     ✓      |   —   |     —      |
| Accept / reject / advance own bookings        |    —     |     ✓      |   —   |     —      |
| See own payment history                       |    ✓     |     —      |   —   |     —      |
| Browse **all** users / bookings / services    |    —     |     —      |   ✓   |     ✓      |
| Approve / reject technician applications      |    —     |     —      |   ✓   |     ✓      |
| Moderate services (approve / reject)          |    —     |     —      |   ✓   |     ✓      |
| View admin dashboard statistics                |    —     |     —      |   ✓   |     ✓      |
| Promote customer → admin or technician → admin|    —     |     —      |   ✓   |     ✓      |
| **Demote an admin**                           |    —     |     —      |   —   |     ✓      |
| **Transfer Main Admin ownership**             |    —     |     —      |   —   |     ✓      |
| Read the admin payments list                  |    —     |     —      |   ✓   |     ✓      |

\* A technician who wants to be *also* re-approved through an admin flow is
intentionally out of scope; technicians in this system stay technicians.

Additional invariants:

- **Exactly one Main Admin at a time.** Promotion never grants Main Admin
  status; bootstrap does it once; an existing Main Admin can hand the flag
  to an existing admin only via a **re-authenticated MongoDB transaction**
  (`POST /api/admin/main-admin/transfer`).
- A Normal Admin can promote but never demote anyone.
- The Main Admin cannot be modified by anybody — self-changes are rejected
  before the transaction begins, and the target lookup verifies the target
  is not the current Main Admin inside the transaction itself.
- `customer → technician` promotion requires an **approved** technician
  application on file.

## API endpoint reference

All endpoints are served from `http://<BACKEND>/api/`. `Auth` = JWT Bearer.

### Public
| Method | Path                     | Auth | Notes |
| ------ | ------------------------ | ---- | ----- |
| GET    | `/api/health`            | —    | liveness check |
| GET    | `/api/test/public`       | dev only | returns 404 in production |
| GET    | `/api/services`          | —    | approved + available services only, paginated, filterable |
| GET    | `/api/services/:id`      | —    | approved service detail |
| POST   | `/api/auth/sign-up/email` | —   | creates a customer |
| POST   | `/api/auth/sign-in/email` | —   | issues session cookie |
| POST   | `/api/auth/token`        | cookie | short-lived JWT for Bearer auth |
| GET    | `/api/auth/jwks`         | —    | public keys |

### Technician applications
| Method | Path                             | Auth (role)        |
| ------ | -------------------------------- | ------------------ |
| POST   | `/api/technician-applications`   | Customer           |
| GET    | `/api/technician-applications/my`| any authenticated  |
| GET    | `/api/technician-applications`   | Admin              |
| PATCH  | `/api/technician-applications/:userId/review` | Admin           |

### Services
| Method | Path                          | Auth (role)    |
| ------ | ----------------------------- | -------------- |
| GET    | `/api/services`               | public         |
| GET    | `/api/services/my`            | Technician     |
| GET    | `/api/services/:id`           | public         |
| POST   | `/api/services`               | Technician     |
| PATCH  | `/api/services/:id`           | Technician (own) |
| DELETE | `/api/services/:id`           | Technician (own) |
| PATCH  | `/api/services/:id/approve`   | Admin          |
| PATCH  | `/api/services/:id/reject`    | Admin          |

### Bookings
| Method | Path                          | Auth (role)    |
| ------ | ----------------------------- | -------------- |
| POST   | `/api/bookings`               | Customer       |
| GET    | `/api/bookings/my`           | Customer       |
| GET    | `/api/bookings/:id`          | Customer (own) |
| PATCH  | `/api/bookings/:id/cancel`   | Customer (own) |
| GET    | `/api/bookings/technician`   | Technician     |
| PATCH  | `/api/bookings/:id/accept`   | Technician     |
| PATCH  | `/api/bookings/:id/reject`   | Technician     |
| PATCH  | `/api/bookings/:id/status`   | Technician     |

### Payments
| Method | Path                          | Auth (role)    |
| ------ | ----------------------------- | -------------- |
| POST   | `/api/payments/checkout-session` | Customer    |
| GET    | `/api/payments/my`            | Customer       |
| POST   | `/api/payments/webhook`       | verified by signature (no JWT) |
| GET    | `/api/admin/payments`         | Admin          |

### User profile & admin
| Method | Path                                   | Auth (role)    |
| ------ | -------------------------------------- | -------------- |
| GET    | `/api/users/me`                        | any authenticated |
| PATCH  | `/api/users/me`                        | any authenticated |
| GET    | `/api/admin/dashboard/stats`           | Admin          |
| GET    | `/api/admin/users`                     | Admin          |
| GET    | `/api/admin/users/:id`                 | Admin          |
| PATCH  | `/api/admin/users/:id/role`            | Admin          |
| POST   | `/api/admin/main-admin/transfer`       | Main Admin     |
| GET    | `/api/admin/bookings`                  | Admin          |
| GET    | `/api/admin/services`                  | Admin          |
| GET    | `/api/admin/payments`                  | Admin          |
| POST   | `/api/uploads/image`                   | Technician     |

## Customer booking workflow

1. Customer browses `/api/services` (public) and opens a service detail.
2. Customer calls `POST /api/bookings` with `{ serviceId, problemDescription }`.
   The server looks up the service, the technician and the service's current
   approval/availability — requests for non-available services are rejected.
3. Booking is created with status `requested` and `paymentStatus: "unpaid"`.
   The server rejects duplicate active bookings by the same customer for the
   same service (atomic unique partial index).
4. Technician sees the booking via `/api/bookings/technician`, then accepts
   or rejects it.
5. Accepted booking can be moved `accepted → in-progress → completed`, with
   the final repair charge set at the final step.
6. Customer sees the updated status in real time. Customers can cancel any
   `requested` booking (`PATCH /api/bookings/:id/cancel`).
7. Once booking is `completed`, the customer can pay — see
   [Stripe Checkout](#stripe-checkout--webhook).

## Stripe Checkout & webhook

Customers pay for `completed` bookings that are `paymentStatus: "unpaid"`.

1. `POST /api/payments/checkout-session` with `{ "bookingId": "…" }` only.
   **Amount, currency, customer and status come from the server-side
   booking — never from the client.** At most one pending Checkout Session
   per booking (partial unique index). Concurrent requests return the same
   hosted URL; the Stripe call happens at most once per pending slot.
2. The customer is redirected to `checkout.stripe.com`. No card data is
   collected by FixMate.
3. Stripe calls `POST /api/payments/webhook`. The raw request body is
   verified against `STRIPE_WEBHOOK_SECRET` via `stripe.webhooks.constructEvent`.
   The payload's `client_reference_id` and `metadata.bookingId` must match
   a stored `pending` payment; `amount_total` and `currency` are
   re-validated against the stored record. Only then are the booking and
   payment flipped to `paid`/`succeeded` in the same atomic step.
   `checkout.session.expired` and `checkout.session.async_payment_failed`
   mark the payment `expired`/`failed` — the booking is never marked paid
   by an unverified redirect from the frontend.
4. Customer payment history (`GET /api/payments/my`) renders every payment
   the customer has made, newest first, with amount, currency, status and
   date. Admins see the same data for every customer at
   `GET /api/admin/payments`.

### Test mode

1. Create a Stripe **test** account; use the test keys from
   <https://dashboard.stripe.com/test/apikeys>.
2. Install the Stripe CLI and forward events to the webhook:

   ```bash
   stripe listen --forward-to http://localhost:5000/api/payments/webhook
   ```

   The CLI prints a `whsec_...` secret; set it as `STRIPE_WEBHOOK_SECRET`
   and restart the server.
3. Trigger the relevant events, e.g. `stripe trigger checkout.session.completed` —
   the endpoint acknowledges synthetic events with 200 and ignores ones whose
   session does not match, by design (fail-closed). To exercise the
   reconciliation path, run a real test checkout locally and pay with the
   test card `4242 4242 4242 4242` (any future expiry, any CVC).

## ImgBB image upload setup

Technician service images upload through the server:

1. Create a free ImgBB account and copy the API key.
2. Set `IMGBB_API_KEY=…` (never commit it).
3. Restart the server. Uploads return `503` when the key is missing — the
   rest of the API keeps working.
4. Accepted formats: JPEG, PNG, WebP; max 5 MB; validation happens both in
   the browser and on the server.

`IMGBB_UPLOAD_URL` overrides the ImgBB endpoint for test environments only;
it is not required in production. The server proxies the bytes — the client
never holds the key.

## Testing

All test suites are driven by `npm test` (see `package.json`). Most suites
run through `scripts/with-isolated-app.mjs`, which boots its **own copy of the
API on an ephemeral port** with a fresh auth rate-limit window — tests never
hit the `localhost:5000` development server. The isolated API talks to the
**same development MongoDB database** configured in `.env` (`MONGODB_URI`);
suites create uniquely-named throwaway records and do not rely on data
outside that database. If you want a clean slate, point `MONGODB_URI` at a
scratch database before running the suites.

```bash
npm test          # all suites
npm run build     # tsc — required before isolated tests (they import ../dist)
```

Validation order: `npm run type-check && npm run build && npm test`.

Suites cover: auth hardening (prod test-route 404, fresh DB role lookup,
stale-JWT rejection), auth rate limiting (dev budget not prematurely hit;
prod throttles credential paths per client IP after 10 attempts/minute), payments (Stripe mocked; full checkout + webhook
reconciliation), bookings (ownership, state machine, cancellation), services
(mine/theirs, image upload, listing), admin dashboard, admin payments,
admin services, technician applications, profile and Main Admin transfer /
hierarchy. If your checkout fails at the **smoke-test** stage, export
`TEST_USER_PASSWORD` to the password used for the account
`fixmate.test@example.com` at first signup, or create it afresh via the
test harness against a scratch `MONGODB_URI`. The suite is documented as
needing this password and is otherwise self-contained.

## Known limitations

- **Stripe `bdt` is not enabled by default** — only accounts whose Stripe
  region and payment method support charging in Bangladeshi taka can use
  `STRIPE_CURRENCY=bdt`. The default `usd` works on any account.
- **Transactions require a replica set**, including single-node local
  setups. A standalone `mongod` will refuse multi-document transactions with
  `MongoServerError: Only servers in a sharded cluster can start a new
  transaction`.
- **Smoke test needs `TEST_USER_PASSWORD`.** The harness trusts the account
  `fixmate.test@example.com` to exist; it does not create it.
- **`npm test` does not pass cleanly** without the above. Every other suite
  is self-contained and passes in isolation.
- **Timer-based webhooks** — Stripe retries unreachable webhook endpoints
  for roughly 3 days; the endpoint is idempotent and safe to redeliver.
- **Image upload** goes through ImgBB — a third-party dependency. The API
  key never reaches the client, but ImgBB outages affect uploads (the rest
  of the product keeps working).
- **Online-deploy constraints** — if you deploy this, use a real HTTPS
  domain, a strong `BETTER_AUTH_SECRET`, a private database, and consider
  tightening CORS to exactly one origin.

## Production deployment requirements

See [DEPLOYMENT.md](./DEPLOYMENT.md) for the environment variable inventory,
CORS/trusted-origins, replica-set requirement, webhook URL, reverse proxy
headers and error-reporting checklist. Real secrets are **never** committed;
`.env.example` is a template.
