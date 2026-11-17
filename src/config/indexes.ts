
import type { IndexDescription } from "mongodb";
import { getDB } from "./db.js";
import { SERVICES_COLLECTION } from "../models/service.model.js";

// Index definitions for the `services` collection.
//
// Notes:
// - The { approvalStatus: 1, availabilityStatus: 1, category: 1 } compound
//   index supports public discovery queries and can also serve queries on
//   approvalStatus alone (MongoDB uses leftmost prefixes), so a standalone
//   approvalStatus index would be redundant and is intentionally omitted.
// - category appears last in the compound index and on its own supports
//   category browsing; it is not redundant with the compound.
// - createdAt (descending) supports newest-first listings.
export const servicesIndexes: IndexDescription[] = [
  {
    key: { technicianId: 1 },
    name: "services_technicianId_1",
  },
  {
    key: { category: 1 },
    name: "services_category_1",
  },
  {
    key: { createdAt: -1 },
    name: "services_createdAt_-1",
  },
  {
    key: { approvalStatus: 1, availabilityStatus: 1, category: 1 },
    name: "services_approvalStatus_1_availabilityStatus_1_category_1",
  },
];

// Creates the indexes once, at startup. createIndexes is idempotent, so
// re-running against identical definitions is a no-op on the server side.
export const ensureIndexes = async (): Promise<string[]> => {
  const db = getDB();

  return db.collection(SERVICES_COLLECTION).createIndexes(servicesIndexes);
};
