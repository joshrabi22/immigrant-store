// db.js — Database layer supporting both local SQLite and Turso cloud
// Run standalone to initialize: node db.js
//
// Uses Turso cloud when TURSO_DATABASE_URL is set, otherwise local file.
// Provides an async API that wraps @libsql/client.

const { createClient } = require("@libsql/client");
const path = require("path");

const DB_PATH = path.join(__dirname, "data.db");

let _client = null;

function getDb() {
  if (_client) return _client;

  if (process.env.TURSO_DATABASE_URL) {
    _client = createClient({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
    console.log(`[db] Connected to Turso cloud: ${process.env.TURSO_DATABASE_URL}`);
  } else {
    _client = createClient({ url: `file:${DB_PATH}` });
    console.log(`[db] Using local SQLite: ${DB_PATH}`);
  }

  return _client;
}

async function initSchema(db) {
  // Phase 1 tables
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_title TEXT NOT NULL,
      image_url TEXT,
      image_path TEXT,
      category TEXT,
      price REAL,
      seller_id TEXT,
      order_date TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS candidates (
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
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS taste_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS swipe_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      decision TEXT NOT NULL,
      batch_number INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS image_processing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      original_url TEXT,
      processed_path TEXT,
      flags TEXT,
      hidden INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Phase 2 columns — add safely
  const phase2Columns = [
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
    ["edited_colors", "TEXT"],     // JSON array of color names
    ["edited_sizes", "TEXT"],      // JSON array of selected sizes
    ["shopify_url", "TEXT"],
    ["original_image_path", "TEXT"], // backup before enhancement
  ];

  // Get existing columns
  const colResult = await db.execute("PRAGMA table_info(candidates)");
  const existingCols = new Set(colResult.rows.map((r) => r.name || r[1]));

  for (const [col, type] of phase2Columns) {
    if (!existingCols.has(col)) {
      try {
        await db.execute(`ALTER TABLE candidates ADD COLUMN ${col} ${type}`);
      } catch (_) {} // Column may already exist
    }
  }
}

// ---------------------------------------------------------------------------
// Helper wrappers for common patterns (sync-style convenience)
// ---------------------------------------------------------------------------

// Execute a query and return all rows
async function queryAll(db, sql, params = []) {
  const result = await db.execute({ sql, args: params });
  return result.rows;
}

// Execute a query and return the first row
async function queryOne(db, sql, params = []) {
  const result = await db.execute({ sql, args: params });
  return result.rows[0] || null;
}

// Execute a statement (INSERT/UPDATE/DELETE) and return { changes, lastInsertRowid }
async function run(db, sql, params = []) {
  const result = await db.execute({ sql, args: params });
  return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid };
}

// Run standalone to create/reset the schema
if (require.main === module) {
  require("dotenv").config();
  (async () => {
    const db = getDb();
    await initSchema(db);
    console.log("Database initialized");

    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    console.log("Tables:", tables.rows.map((t) => t.name || t[0]).join(", "));

    const cols = await db.execute("PRAGMA table_info(candidates)");
    console.log("\nCandidates columns:", cols.rows.map((c) => c.name || c[1]).join(", "));
  })();
}

module.exports = { getDb, initSchema, queryAll, queryOne, run };
