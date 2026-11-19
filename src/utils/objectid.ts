import { ObjectId } from "mongodb";

export const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/** Strict ObjectId validation: accepts only canonical 24-hex strings. */
export const isObjectIdHex = (value: unknown): value is string =>
  typeof value === "string" && OBJECT_ID_HEX.test(value);

export const toObjectId = (value: string): ObjectId => new ObjectId(value);