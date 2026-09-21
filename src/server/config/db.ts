import { createDb, type DatabaseClient } from "@ttoltori/database";
import { validateEnv } from "./env";

let db: DatabaseClient | null = null;

export function getDb(): DatabaseClient {
  if (!db) {
    validateEnv();
    db = createDb();
  }
  return db;
}
