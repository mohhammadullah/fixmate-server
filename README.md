# FixMate Server

## Image uploads (ImgBB)

Technician service images are uploaded with `POST /api/uploads/image` and stored on
ImgBB. The API key is **server-only** and never shipped to the browser.

Setup:

1. Create a free ImgBB API key at <https://imgbb.com/>.
2. Add it to your local `.env` (copy `.env.example` first):

   ```env
   IMGBB_API_KEY=your-real-key-here
   ```

3. Restart the server. If the key is absent, uploads return `503` with a safe
   message — the rest of the API keeps working.

Optional: `IMGBB_UPLOAD_URL` overrides the ImgBB endpoint (default
`https://api.imgbb.com/1/upload`). It exists for local tests with a mock server.

The real `.env` must never be committed. Accepted images: JPEG, PNG, WebP up to
5 MB; validation happens both in the browser and on the server.

## Admin hierarchy and Main Admin transfer

FixMate has a two-tier admin hierarchy on top of Better Auth's managed
`user` documents — no extra collection is introduced; the Main Admin
designation is the server-managed `isMainAdmin: true` field on an admin's
`user` document and is never settable through registration, profile or
role-update input.

**Main Admin** (exactly one at a time): promoted by bootstrap, or the
current Main Admin can hand the designation to another existing **Normal
Admin** with `POST /api/admin/main-admin/transfer`.

**Promotion (any admin may do):** an authenticated Admin may promote an
existing Customer or Technician to Admin through
`PATCH /api/admin/users/:id/role` with `{ "role": "admin" }`. Promotion
never grants Main Admin status, and it never creates accounts or touches
passwords.

**Demotion (Main Admin only):** only the Main Admin may demote an Admin to
Customer or Technician. Normal Admins receive 403 for any admin demotion.
The Main Admin can never be demoted or modified by anyone — not by themself
(self-changes are rejected), not by another Admin. There is no path around
these rules through any other endpoint: `PATCH /api/users/me` (and every
other user-facing update path) only edits name/phone/area/bio.

**Ownership transfer** — `POST /api/admin/main-admin/transfer`:

```jsonc
{ "targetUserId": "<24-hex ObjectId of an existing Normal Admin>", "password": "<current Main Admin password>" }
```

- Caller must be an authenticated Admin **and** the Main Admin (both checked
  against the database, not the JWT).
- Target must be an existing **Normal Admin** — a different account, never a
  customer, technician or another/secondary Main Admin.
- Requires the current Main Admin's password (re-authentication against
  Better Auth's credential account; the password is never logged or
  returned).
- The swap is a single **multi-document MongoDB transaction** (requires a
  replica set, which Atlas provides): both writes land or neither does;
  invariants assert exactly one Main Admin before commit. If transactions
  are unavailable, the endpoint fails safely with 503 — there is no
  non-atomic two-write fallback.
- Both accounts keep the admin role; only the `isMainAdmin` designation
  moves. Afterwards the former Main Admin is a Normal Admin.

**Bootstrap and recovery:**

- Initial Main Admin: `npm run bootstrap:admin` with
  `ADMIN_BOOTSTRAP_EMAIL=<email of an existing user>` and
  `ADMIN_BOOTSTRAP_CONFIRM=true`. The script promotes the user to admin and,
  if no Main Admin exists yet, designates them as Main Admin. Re-running it
  for later admins never designates another Main Admin.
- Recovering a lost Main Admin on a live deployment (designated admin is
  gone; exactly one Main Admin must always remain):
  `ADMIN_BOOTSTRAP_DESIGNATE_MAIN=true ADMIN_BOOTSTRAP_EMAIL=<existing admin email> ADMIN_BOOTSTRAP_CONFIRM=true npm run bootstrap:admin`
  — this designates an **existing** admin as Main Admin and refuses to run
  if any Main Admin already exists.
- Recovery from zero admins: re-run the normal bootstrap with any trusted
  existing account email.

**Role issuance note:** role is embedded in the JWT at issuance time, so a
promoted Admin must call `/api/auth/token` again before their new admin
authorities apply elsewhere. The `isMainAdmin` flag is read fresh from the
database on every admin-sensitive operation.

## Stripe payments

Customers pay for their own `completed` bookings with `paymentStatus:
"unpaid"` through Stripe Checkout. The flow:

1. `POST /api/payments/checkout-session` (customer JWT) with `{ "bookingId" }`
   only. Amount and currency are taken from the server-side booking document
   (`finalAmount`) — never from the request. At most one pending Checkout
   Session may exist per booking (partial unique index
   `payments_one_pending_per_booking_unique`); repeat calls and concurrent
   requests return the same hosted URL. A fresh session may be opened once a
   previous one expires or fails.
2. The customer pays on Stripe's hosted page (`success_url`
   `CLIENT_URL/dashboard/payments/success?booking_id=<id>`, `cancel_url`
   `.../cancel?booking_id=<id>` — these are navigation hints only; nothing is
   marked paid based on them).
3. Stripe calls `POST /api/payments/webhook`. The endpoint verifies the
   `stripe-signature` header against the **raw** request body with
   `STRIPE_WEBHOOK_SECRET`, then cross-checks the session's metadata booking
   reference, `amount_total` and `currency` against the stored payment
   record. Only then is the booking atomically flipped to `paid` (the
   payment record moves `pending → succeeded`; duplicate deliveries are
   no-ops and self-heal the booking). `checkout.session.expired` and
   `checkout.session.async_payment_failed` mark the payment `expired` /
   `failed` and never touch the booking.
4. `GET /api/payments/my` (customer JWT) returns the caller's own payment
   history, newest first, paginated (`page`, `limit` — default 10, max 50).
   `amount` is in major currency units; `currency` is the lowercase ISO 4217
   code used for the session.

`STRIPE_CURRENCY` defaults to `usd` — the safe default that works on any
Stripe account. Set it to `bdt` (taka) only if your Stripe account's region
and payment method support charging in BDT; otherwise Checkout Session
creation fails with a safe 502. Zero- and three-decimal currencies are
converted to Stripe's minor units automatically.

### Test-mode webhook setup

1. Create a Stripe test account and grab the test secret key from
   <https://dashboard.stripe.com/test/apikeys>; set `STRIPE_SECRET_KEY` in
   `.env` (never commit it).
2. Install the Stripe CLI and forward events to the local server:

   ```bash
   stripe listen --forward-to http://localhost:5000/api/payments/webhook
   ```

   The CLI prints a `whsec_...` signing secret; set it as
   `STRIPE_WEBHOOK_SECRET` in `.env` and restart the server.
3. Trigger the relevant events (the endpoint verifies signatures, so a raw
   `curl` without a valid signature is rejected with 400):

   ```bash
   stripe trigger checkout.session.completed
   ```

   Note: `stripe trigger` sends synthetic events whose session does not
   exist in the local `payments` collection — the endpoint acknowledges them
   with 200 and ignores them. To exercise the full reconciliation path,
   create a real test checkout through the site and pay with Stripe's test
   card `4242 4242 4242 4242` (any future expiry, any CVC).
4. In production, create a Dashboard webhook (Developers → Webhooks → Add
   endpoint) pointing at `https://<your-domain>/api/payments/webhook` with
   the events `checkout.session.completed`, `checkout.session.expired` and
   `checkout.session.async_payment_failed`; set the Dashboard's signing
   secret as `STRIPE_WEBHOOK_SECRET`.

`STRIPE_API_BASE` exists solely to point the API client at a local mock of
the Stripe API in tests; never set it in production. `npm test` runs
`scripts/payments-test.mjs`, which boots its own copy of this app against a
mock Stripe and needs no real keys.
