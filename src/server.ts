
import { createServer, type Server } from "node:http";
import { connectDB, closeDB } from "./config/db.js";
import { ensureIndexes } from "./config/indexes.js";
import { createAuth } from "./config/auth.js";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { initSocketServer, closeSocketServer } from "./socket.js";

const startServer = async (): Promise<void> => {
  // Connect to MongoDB BEFORE creating Better Auth so the adapter
  // always sees a live Db instance.
  await connectDB();

  // Create MongoDB indexes once at startup (never per request). Kept
  // non-fatal so index provisioning issues cannot block Better Auth
  // initialization or server startup; failures are logged loudly instead.
  try {
    const indexNames = await ensureIndexes();
    console.log(`MongoDB indexes ensured: ${indexNames.join(", ")}`);
  } catch (error) {
    console.error(
      "Failed to create MongoDB indexes. Server will start anyway:",
      error
    );
  }

  const auth = createAuth();
  const app = createApp(auth);

  const server: Server = createServer(app);
  // Attach the Socket.IO layer (authenticated via Better Auth JWTs).
  initSocketServer(server);
  console.log("Socket.IO attached at /socket.io");

  server.listen(env.PORT, () => {
    console.log(`FixMate server running on port ${env.PORT}`);
    console.log(`Local URL: http://localhost:${env.PORT}`);
  });

  const shutdown = (signal: string): void => {
    console.log(`${signal} received. Shutting down gracefully...`);

    server.close(async () => {
      try {
        await closeSocketServer();
        await closeDB();
        console.log("MongoDB connection closed.");
        process.exit(0);
      } catch (error) {
        console.error("Error while shutting down:", error);
        process.exit(1);
      }
    });

    // Force-exit if connections do not drain in time.
    setTimeout(() => {
      console.error("Graceful shutdown timed out. Forcing exit.");
      process.exit(1);
    }, 10000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

startServer().catch((error) => {
  console.error("Failed to start FixMate server:", error);
  process.exit(1);
});
