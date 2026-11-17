
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { jwt } from "better-auth/plugins";
import { getDB } from "./db.js";
import { env } from "./env.js";

// Better Auth must be created AFTER the MongoDB connection is established,
// because the MongoDB adapter reads from the live Db instance at request time.
// server.ts enforces this order: connectDB() -> createAuth() -> createApp().
export const createAuth = () => {
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,

    // The frontend origin is trusted for credentialed CORS and for
    // Better Auth's origin/CSRF checks on state-changing requests.
    trustedOrigins: [env.CLIENT_URL],

    database: mongodbAdapter(getDB()),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },

    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "customer",
          // Never accepted from public signup/update input. Role changes
          // must go through a trusted server-side path (e.g. admin tooling).
          input: false,
        },
        phone: {
          type: "string",
          required: false,
        },
        area: {
          type: "string",
          required: false,
        },
        bio: {
          type: "string",
          required: false,
        },
      },
    },

    plugins: [
      jwt({
        jwt: {
          definePayload: ({ user }) => ({
            id: user.id,
            email: user.email,
            role: user.role,
          }),
        },
      }),
    ],
  });
};

export type Auth = ReturnType<typeof createAuth>;
