
import { MongoClient, Db } from "mongodb";
import { env } from "./env.js";

export const mongoClient = new MongoClient(env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
});

let database: Db | undefined;

export const connectDB = async (): Promise<void> => {
  await mongoClient.connect();

  const db = mongoClient.db(env.MONGODB_DB_NAME);

  await db.command({ ping: 1 });

  database = db;

  console.log("MongoDB connected successfully!");
};

export const getDB = (): Db => {
  if (!database) {
    throw new Error("Database is not connected yet.");
  }

  return database;
};

export const closeDB = async (): Promise<void> => {
  await mongoClient.close();
  database = undefined;
};
