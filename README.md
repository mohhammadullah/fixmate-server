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
