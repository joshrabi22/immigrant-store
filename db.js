// db.js — Database layer supporting both local SQLite and Turso cloud
// Run standalone to initialize: node db.js
//
// Uses Turso cloud when TURSO_DATABASE_URL is set, otherwise local file.
// Provides an async API that wraps @libsql/client.

const { createClient } = require("@libsql/client");
const path = require("path");

const DB_PATH = path.join(__dirname, "data.db");
const IS_TURSO = !!process.env.TURSO_DATABASE_URL;

let _client = null;

function getDb() {
  if (_client) return _client;

  if (IS_TURSO) {
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
  console.log(`[db] Initializing schema (turso=${IS_TURSO})...`);

  // First check if tables already exist by trying a simple SELECT
  try {
    const result = await db.execute("SELECT COUNT(*) as c FROM candidates");
    const count = result.rows[0]?.c || 0;
    console.log(`[db] Tables exist. Candidates: ${count}. Skipping schema creation.`);
    return; // Tables exist, nothing to do
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
      original_image_path TEXT
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

module.exports = { getDb, initSchema, queryAll, queryOne, run };
