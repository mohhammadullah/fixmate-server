
import Stripe from "stripe";
import { env } from "./env.js";

// Stripe client is created lazily so the server and the test suite can
// start without Stripe credentials. Every payment endpoint checks
// `isStripeConfigured` (or a null client) and answers with a safe 503 —
// the rest of the API is unaffected.
//
// `STRIPE_API_BASE` may point the client at a mock of the Stripe API for
// local tests. It is never set in production.
// env validation guarantees the key/secret pair is either complete or absent.
// Using the shared flag keeps checkout and webhook availability consistent.
export const isStripeConfigured = env.paymentsConfigured;

export const stripeCurrency = env.STRIPE_CURRENCY;

let client: Stripe | null = null;

export const getStripeClient = (): Stripe | null => {
  if (!env.STRIPE_SECRET_KEY) {
    return null;
  }

  if (client) {
    return client;
  }

  const config: Stripe.StripeConfig = {};

  if (env.STRIPE_API_BASE) {
    const url = new URL(env.STRIPE_API_BASE);
    const protocol = url.protocol.replace(/:$/, "");
    config.protocol = protocol === "http" ? "http" : "https";
    config.host = url.hostname;
    if (url.port) {
      config.port = url.port;
    }
  }

  client = new Stripe(env.STRIPE_SECRET_KEY, config);
  return client;
};
