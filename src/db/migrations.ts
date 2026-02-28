import type Database from "better-sqlite3";
import { createLogger } from "../utils/logger.js";
import {
  CREATE_SCHEMA_VERSION,
  CREATE_REQUESTS,
  CREATE_DAILY_COSTS,
  CREATE_BUDGETS,
  CREATE_ALERTS,
  INDEXES,
} from "./schema.js";

const log = createLogger("db:migrations");

// ---------------------------------------------------------------------------
// Migration registry — add new entries here; never modify existing ones.
// Each migration runs exactly once, tracked by version number in schema_version.
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up: (db) => {
      db.exec(CREATE_REQUESTS);
      db.exec(CREATE_DAILY_COSTS);
      db.exec(CREATE_BUDGETS);
      db.exec(CREATE_ALERTS);
      for (const idx of INDEXES) {
        db.exec(idx);
      }
    },
  },
  {
    // SQLite doesn't support ALTER TABLE ADD CONSTRAINT — must recreate the
    // table to expand the CHECK on `status` to include 'override'.
    version: 2,
    name: "budgets_add_override_status",
    up: (db) => {
      db.exec(`
        CREATE TABLE budgets_new (
          id            TEXT PRIMARY KEY,
          type          TEXT NOT NULL CHECK(type IN ('daily', 'weekly', 'monthly')),
          limit_usd     REAL NOT NULL,
          current_spend REAL DEFAULT 0,
          status        TEXT DEFAULT 'active'
                             CHECK(status IN ('active', 'warning', 'paused', 'override')),
          period_start  TEXT NOT NULL,
          period_end    TEXT NOT NULL,
          created_at    TEXT DEFAULT (datetime('now'))
        )
      `);
      db.exec(`INSERT INTO budgets_new SELECT * FROM budgets`);
      db.exec(`DROP TABLE budgets`);
      db.exec(`ALTER TABLE budgets_new RENAME TO budgets`);
    },
  },
  {
    version: 3,
    name: "alerts_rename_clawshield_to_tokpinch",
    up: (db) => {
      db.exec(`
        UPDATE alerts
        SET message = REPLACE(message, 'ClawShield', 'TokPinch')
        WHERE instr(message, 'ClawShield') > 0
      `);
    },
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function runMigrations(db: Database.Database): void {
  // Apply performance pragmas before anything else
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("cache_size = -20000"); // 20 MB page cache

  // Bootstrap the version-tracking table
  db.exec(CREATE_SCHEMA_VERSION);

  const getCurrentVersion = db.prepare<[], { v: number | null }>(
    "SELECT MAX(version) as v FROM schema_version"
  );
  const currentVersion = getCurrentVersion.get()?.v ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    log.debug({ currentVersion }, "Schema up-to-date, no migrations needed");
    return;
  }

  log.info(
    { from: currentVersion, to: pending.at(-1)!.version, count: pending.length },
    "Running migrations"
  );

  const recordMigration = db.prepare(
    "INSERT INTO schema_version (version, name) VALUES (?, ?)"
  );

  for (const migration of pending) {
    // Each migration is wrapped in its own transaction so a failure is atomic
    const apply = db.transaction(() => {
      migration.up(db);
      recordMigration.run(migration.version, migration.name);
    });

    try {
      apply();
      log.info(
        { version: migration.version, name: migration.name },
        "Migration applied"
      );
    } catch (err) {
      log.error(
        { version: migration.version, name: migration.name, err },
        "Migration failed — database left in consistent state"
      );
      throw err; // Bubble up — server should not start with a broken schema
    }
  }

  log.info(
    { version: pending.at(-1)!.version },
    "All migrations complete"
  );
}
