// db.js — Database layer supporting both local SQLite and Turso cloud
// Run standalone to initialize: node db.js
//
// Uses Turso cloud when TURSO_DATABASE_URL is set, otherwise local file.
// Provides an async API that wraps @libsql/client (Turso) or the raw libsql
// driver (local mode — single connection to avoid dual-handle corruption).

const { createClient } = require("@libsql/client");
const path = require("path");

const DB_PATH = path.join(__dirname, "data.db");
const IS_TURSO = !!process.env.TURSO_DATABASE_URL;

let _client = null;
let _rawDb = null; // Raw libsql Database for local mode (single connection for reads + writes)

function getDb() {
  if (_client) return _client;

  if (IS_TURSO) {
    // Sanitize env vars — strip whitespace/newlines that Railway might add
    const url = process.env.TURSO_DATABASE_URL.trim();
    const authToken = process.env.TURSO_AUTH_TOKEN.trim();

    console.log(`[db] Turso URL: "${url}"`);
    console.log(`[db] Turso URL protocol: ${url.split("://")[0]}`);
    console.log(`[db] Turso token length: ${authToken.length}`);

    _client = createClient({ url, authToken });
    console.log(`[db] Connected to Turso cloud`);
  } else {
    // Local mode: use a SINGLE raw libsql Database connection for everything.
    //
    // CRITICAL: Previous implementation opened TWO connections to the same file:
    //   - @libsql/client (for reads/schema via initSchema, queryAll, queryOne)
    //   - raw libsql Database (for writes via run())
    // This caused row-level corruption: ALTER TABLE ADD COLUMN through connection A
    // created columns that connection B's compiled UPDATE bytecode didn't know about.
    // SQLite UPDATEs read the full row, modify named columns, and write the full row
    // back. With a stale column count, values shifted into wrong column positions.
    //
    // Fix: single connection wrapped to provide db.execute() for initSchema compat.
    try {
      const Database = require("libsql");
      const rawDb = new Database(DB_PATH);
      _rawDb = rawDb; // same instance used by getRawDb() / run()

      _client = {
        execute(stmtOrSql) {
          let sql, args;
          if (typeof stmtOrSql === "string") {
            sql = stmtOrSql;
            args = [];
          } else {
            sql = stmtOrSql.sql;
            args = Array.isArray(stmtOrSql.args) ? stmtOrSql.args : [];
          }
          const stmt = rawDb.prepare(sql);
          if (stmt.reader) {
            // SELECT, PRAGMA with results — return rows
            const rows = stmt.all(args);
            return { rows, rowsAffected: 0, lastInsertRowid: undefined };
          } else {
            // INSERT, UPDATE, DELETE, CREATE TABLE, ALTER TABLE — execute and return info
            const info = stmt.run(args);
            return { rows: [], rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
          }
        },
        close() {
          rawDb.close();
        },
      };

      console.log(`[db] Using local SQLite (single raw driver connection): ${DB_PATH}`);
    } catch (err) {
      // Fallback to @libsql/client if raw driver unavailable (e.g. missing native module).
      // NOTE: @libsql/client v0.17.2 has a bug where DML goes through the reader path
      // (rowsAffected always 0, writes may not persist). This fallback is a last resort.
      console.warn(`[db] Raw libsql driver unavailable (${err.message}) — falling back to @libsql/client`);
      _client = createClient({ url: `file:${DB_PATH}` });
      console.log(`[db] Using local SQLite (via @libsql/client): ${DB_PATH}`);
    }
  }

  return _client;
}

// Returns the raw libsql Database instance for local writes.
// In local mode, this is the SAME instance that getDb() created — single connection.
// In Turso mode, returns null (HTTP-based, no raw driver).
function getRawDb() {
  if (_rawDb) return _rawDb;
  if (IS_TURSO) return null;
  // If getDb() fell back to @libsql/client, try raw driver here as last resort
  try {
    const Database = require("libsql");
    _rawDb = new Database(DB_PATH);
    console.log(`[db] Raw libsql driver ready for local writes (separate connection — fallback)`);
    return _rawDb;
  } catch (err) {
    console.warn(`[db] Raw libsql driver unavailable (${err.message}) — falling back to @libsql/client for writes`);
    return null;
  }
}

// All columns that must exist on the candidates table.
// Add new columns here when the schema evolves — initSchema will ADD COLUMN for any that are missing.
const CANDIDATE_COLUMNS = [
  // Original columns
  ["image_url", "TEXT"],
  ["image_path", "TEXT"],
  ["source", "TEXT"],
  ["ali_product_id", "TEXT"],
  ["price", "REAL"],
  ["shipping_cost", "REAL"],
  ["score", "REAL"],
  ["status", "TEXT DEFAULT 'new'"],
  ["created_at", "TEXT"],
  ["immigrant_name", "TEXT"],
  ["immigrant_description", "TEXT"],
  ["retail_price", "REAL"],
  ["price_reasoning", "TEXT"],
  ["image_flags", "TEXT"],
  ["processed_images", "TEXT"],
  ["shopify_product_id", "TEXT"],
  ["score_breakdown", "TEXT"],
  ["namer_data", "TEXT"],
  ["cj_product_id", "TEXT"],
  ["product_url", "TEXT"],
  ["gender", "TEXT DEFAULT 'unisex'"],
  ["detected_category", "TEXT"],
  ["edited_name", "TEXT"],
  ["edited_description", "TEXT"],
  ["edited_price", "REAL"],
  ["edited_colors", "TEXT"],
  ["edited_sizes", "TEXT"],
  ["shopify_url", "TEXT"],
  ["original_image_path", "TEXT"],
  ["processing_status", "TEXT DEFAULT 'pending'"],
  ["processed_image_url", "TEXT"],
  ["all_images", "TEXT"],
  ["variant_specifics", "TEXT"],
  ["parent_url", "TEXT"],
  // Canonical state model (added via migrate-canonical.js)
  ["stage", "TEXT"],
  ["review_status", "TEXT"],
  ["review_session_id", "TEXT"],
  ["parent_id", "INTEGER"],
  ["split_group_id", "INTEGER"],
  ["is_split_child", "INTEGER DEFAULT 0"],
  ["generated_name", "TEXT"],
  ["generated_description", "TEXT"],
  ["staged_at", "TEXT"],
  ["processing_started_at", "TEXT"],
  ["processing_completed_at", "TEXT"],
  ["reviewed_at", "TEXT"],
  ["approved_at", "TEXT"],
  ["published_at", "TEXT"],
  ["updated_at", "TEXT"],
];

async function ensureCandidateColumns(db) {
  let existing;
  try {
    const result = await db.execute("PRAGMA table_info(candidates)");
    existing = new Set(result.rows.map((r) => r.name));
  } catch (err) {
    console.warn(`[db] Could not read table_info: ${err.message}`);
    return;
  }
  let added = 0;
  for (const [col, type] of CANDIDATE_COLUMNS) {
    if (existing.has(col)) continue;
    try {
      await db.execute(`ALTER TABLE candidates ADD COLUMN ${col} ${type}`);
      console.log(`[db] Added missing column: candidates.${col}`);
      added++;
    } catch (err) {
      // Ignore "duplicate column" errors (race or already exists)
      if (!err.message.includes("duplicate column")) {
        console.warn(`[db] Could not add column ${col}: ${err.message}`);
      }
    }
  }
  if (added > 0) console.log(`[db] Column migration complete: ${added} column(s) added.`);
}

async function initSchema(db) {
  console.log(`[db] Initializing schema (turso=${IS_TURSO})...`);

  // First check if tables already exist by trying a simple SELECT
  try {
    const result = await db.execute("SELECT COUNT(*) as c FROM candidates");
    const count = result.rows[0]?.c || 0;
    console.log(`[db] Tables exist. Candidates: ${count}. Checking for missing columns...`);
    await ensureCandidateColumns(db);
    return;
  } catch (err) {
    console.log(`[db] Tables don't exist yet (${err.message}). Creating...`);
  }

  // Tables don't exist — create them. Only runs on fresh database.
  // Use simple SQL compatible with both SQLite and Turso HTTP.
  const createStatements = [
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_title TEXT NOT NULL,
      image_url TEXT,
      image_path TEXT,
      category TEXT,
      price REAL,
      seller_id TEXT,
      order_date TEXT,
      created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      image_url TEXT,
      image_path TEXT,
      source TEXT,
      ali_product_id TEXT,
      price REAL,
      shipping_cost REAL,
      score REAL,
      status TEXT DEFAULT 'new',
      created_at TEXT,
      immigrant_name TEXT,
      immigrant_description TEXT,
      retail_price REAL,
      price_reasoning TEXT,
      image_flags TEXT,
      processed_images TEXT,
      shopify_product_id TEXT,
      score_breakdown TEXT,
      namer_data TEXT,
      cj_product_id TEXT,
      product_url TEXT,
      gender TEXT DEFAULT 'unisex',
      detected_category TEXT,
      edited_name TEXT,
      edited_description TEXT,
      edited_price REAL,
      edited_colors TEXT,
      edited_sizes TEXT,
      shopify_url TEXT,
      original_image_path TEXT,
      processing_status TEXT DEFAULT 'pending',
      processed_image_url TEXT,
      all_images TEXT,
      variant_specifics TEXT,
      parent_url TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS taste_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS swipe_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      decision TEXT NOT NULL,
      batch_number INTEGER,
      created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS image_processing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      original_url TEXT,
      processed_path TEXT,
      flags TEXT,
      hidden INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS item_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      from_stage TEXT,
      to_stage TEXT,
      metadata TEXT,
      created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS processing_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      stage_1_result TEXT,
      stage_2_result TEXT,
      stage_3_result TEXT,
      cloudinary_url TEXT,
      error_message TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS review_sessions (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      batch_size INTEGER,
      items_reviewed INTEGER DEFAULT 0,
      items_accepted INTEGER DEFAULT 0,
      items_rejected INTEGER DEFAULT 0,
      items_discarded INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT,
      completed_at TEXT
    )`,
  ];

  for (const sql of createStatements) {
    try {
      await db.execute(sql);
    } catch (err) {
      console.error(`[db] Create table error: ${err.message}`);
    }
  }

  // Verify
  try {
    const result = await db.execute("SELECT COUNT(*) as c FROM candidates");
    console.log(`[db] Schema created. Candidates: ${result.rows[0]?.c || 0}`);
  } catch (err) {
    console.error(`[db] Verification failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Helper wrappers
// ---------------------------------------------------------------------------

async function queryAll(db, sql, params = []) {
  const result = await db.execute({ sql, args: params });
  return result.rows;
}

async function queryOne(db, sql, params = []) {
  const result = await db.execute({ sql, args: params });
  return result.rows[0] || null;
}

async function run(db, sql, params = []) {
  // Local mode: use raw libsql driver for DML.
  // In the single-connection setup, getRawDb() returns the same instance that
  // getDb() created — no dual-handle corruption risk.
  const rawDb = getRawDb();
  if (rawDb) {
    const stmt = rawDb.prepare(sql);
    const info = stmt.run(params);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  }
  // Turso or raw driver unavailable: use @libsql/client
  const result = await db.execute({ sql, args: params });
  return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
}

// Run standalone
if (require.main === module) {
  require("dotenv").config();
  (async () => {
    const db = getDb();
    await initSchema(db);
  })();
}

function closeDb() {
  if (_rawDb) {
    try { _rawDb.close(); } catch (_) {}
    _rawDb = null;
  }
  if (_client && _client !== _rawDb) {
    try { _client.close(); } catch (_) {}
  }
  _client = null;
}

module.exports = { getDb, initSchema, queryAll, queryOne, run, closeDb };
