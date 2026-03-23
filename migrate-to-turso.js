// migrate-to-turso.js — Migrate local data.db to Turso cloud
// Usage: node migrate-to-turso.js
//
// Reads all data from local data.db and writes to Turso.
// Requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env.

require("dotenv").config();
const { createClient } = require("@libsql/client");
const path = require("path");

const LOCAL_DB_PATH = path.join(__dirname, "data.db");
const TABLES = ["orders", "candidates", "taste_profile", "swipe_decisions", "image_processing"];
const BATCH_SIZE = 50;

async function main() {
  console.log("=== IMMIGRANT — Migrate to Turso ===\n");

  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    console.error("Error: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set in .env");
    process.exit(1);
  }

  // Connect to local SQLite
  const local = createClient({ url: `file:${LOCAL_DB_PATH}` });
  console.log(`Local database: ${LOCAL_DB_PATH}`);

  // Connect to Turso cloud
  const cloud = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  console.log(`Turso database: ${process.env.TURSO_DATABASE_URL}\n`);

  // Step 1: Initialize schema on Turso
  console.log("Initializing schema on Turso...");
  const { initSchema } = require("./db");
  // Temporarily point getDb to cloud — initSchema expects a client
  await initSchema(cloud);
  console.log("Schema ready.\n");

  // Step 2: Migrate each table
  for (const table of TABLES) {
    // Get local row count
    const countResult = await local.execute(`SELECT COUNT(*) as c FROM ${table}`);
    const totalRows = countResult.rows[0].c;

    if (totalRows === 0) {
      console.log(`${table}: 0 rows — skipping`);
      continue;
    }

    // Get column names
    const colsResult = await local.execute(`PRAGMA table_info(${table})`);
    const columns = colsResult.rows.map((r) => r.name);

    // Check existing rows in cloud to avoid duplicates
    const cloudCount = await cloud.execute(`SELECT COUNT(*) as c FROM ${table}`);
    if (cloudCount.rows[0].c > 0) {
      console.log(`${table}: ${cloudCount.rows[0].c} rows already in Turso — clearing first...`);
      await cloud.execute(`DELETE FROM ${table}`);
    }

    console.log(`${table}: migrating ${totalRows} rows...`);

    // Read all rows from local
    const allRows = await local.execute(`SELECT * FROM ${table}`);

    // Insert in batches
    let migrated = 0;
    for (let i = 0; i < allRows.rows.length; i += BATCH_SIZE) {
      const batch = allRows.rows.slice(i, i + BATCH_SIZE);
      const stmts = [];

      for (const row of batch) {
        const placeholders = columns.map(() => "?").join(", ");
        const values = columns.map((col) => {
          const val = row[col];
          return val === undefined ? null : val;
        });

        stmts.push({
          sql: `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
          args: values,
        });
      }

      await cloud.batch(stmts);
      migrated += batch.length;
      process.stdout.write(`  ${migrated}/${totalRows}\r`);
    }

    console.log(`  ${migrated}/${totalRows} — done`);
  }

  // Verify
  console.log("\n=== Verification ===\n");
  for (const table of TABLES) {
    const localCount = await local.execute(`SELECT COUNT(*) as c FROM ${table}`);
    const cloudCount = await cloud.execute(`SELECT COUNT(*) as c FROM ${table}`);
    const match = localCount.rows[0].c === cloudCount.rows[0].c;
    console.log(`${table}: local=${localCount.rows[0].c} cloud=${cloudCount.rows[0].c} ${match ? "✓" : "✗ MISMATCH"}`);
  }

  console.log("\n=== Migration complete ===");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
