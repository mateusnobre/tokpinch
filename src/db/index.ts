import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../utils/logger.js";
import { runMigrations } from "./migrations.js";
import { createQueries, type Queries } from "./queries.js";

const log = createLogger("db");

// ---------------------------------------------------------------------------
// Module-level singleton — one DB connection per process lifetime
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null;
let _queries: Queries | null = null;

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initDb(dbPath: string): void {
  if (_db) {
    log.warn("initDb() called more than once — ignoring");
    return;
  }

  // Ensure the data directory exists
  const dir = path.dirname(path.resolve(dbPath));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.error({ err, dir }, "Failed to create database directory");
    throw err;
  }

  // Open the database
  try {
    _db = new Database(dbPath);
  } catch (err) {
    log.error({ err, dbPath }, "Failed to open SQLite database");
    throw err;
  }

  // Restrict file permissions to owner-only (no-op on Windows but harmless)
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    // Windows doesn't support Unix-style chmod — skip silently
  }

  // Run migrations (sets pragmas, creates tables, applies pending changes)
  try {
    runMigrations(_db);
  } catch (err) {
    _db.close();
    _db = null;
    log.error({ err }, "Migrations failed — database connection closed");
    throw err;
  }

  // One-time cleanup: rewrite legacy alert records that reference the old product name
  try {
    const result = _db
      .prepare("UPDATE alerts SET message = REPLACE(message, 'ClawShield', 'TokPinch') WHERE message LIKE '%ClawShield%'")
      .run();
    if (result.changes > 0) {
      log.info({ updated: result.changes }, "Rewrote legacy ClawShield alert records to TokPinch");
    }
  } catch {
    // Non-fatal — old records are cosmetic only
  }

  // Prepare all statements upfront so binding errors surface at startup
  _queries = createQueries(_db);

  log.info({ dbPath }, "Database ready");
}

// ---------------------------------------------------------------------------
// Accessors — throw early rather than returning null to keep call sites clean
// ---------------------------------------------------------------------------

export function getDb(): Database.Database {
  if (!_db) throw new Error("Database not initialised — call initDb() first");
  return _db;
}

export function getQueries(): Queries {
  if (!_queries)
    throw new Error("Database not initialised — call initDb() first");
  return _queries;
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

export function closeDb(): void {
  if (!_db) return;
  try {
    _db.close();
    log.info("Database connection closed");
  } catch (err) {
    log.error({ err }, "Error closing database");
  } finally {
    _db = null;
    _queries = null;
  }
}
