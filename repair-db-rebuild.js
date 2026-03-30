#!/usr/bin/env node
// repair-db-rebuild.js — Rebuild data.db to fix page-level corruption
//
// IMPORTANT: Stop the server before running this.
//   1. Stop: Ctrl-C the running `node server.js`
//   2. Run:  TURSO_DATABASE_URL= node repair-db-rebuild.js
//   3. Restart: TURSO_DATABASE_URL= TURSO_AUTH_TOKEN= node server.js
//
// What this does:
//   1. Backs up data.db → data.db.pre-rebuild
//   2. Dumps all data via .dump
//   3. Rebuilds data.db from the dump
//   4. Repairs known corrupted rows (1041, 1049 — null-byte stage corruption)
//   5. Runs PRAGMA integrity_check
//
// Root cause: concurrent access from different SQLite implementations
// (libsql native driver in server.js + standard sqlite3 from Python)
// caused page-level corruption (duplicate page references, null-byte smearing).

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DB_PATH = path.join(__dirname, "data.db");
const BACKUP_PATH = path.join(__dirname, "data.db.pre-rebuild");

// Use the raw libsql driver (same as server uses)
let Database;
try {
  Database = require("libsql");
} catch (e) {
  console.error("libsql not available. Install with: npm install libsql");
  process.exit(1);
}

console.log("=== data.db Rebuild Script ===\n");

// Step 1: Check server isn't running
try {
  const db = new Database(DB_PATH);
  // Try a write to see if we have exclusive access
  db.exec("BEGIN EXCLUSIVE");
  db.exec("COMMIT");
  db.close();
} catch (e) {
  if (e.message.includes("locked") || e.message.includes("busy")) {
    console.error("ERROR: Database is locked. Stop the server first:");
    console.error("  Ctrl-C the running server, then re-run this script.");
    process.exit(1);
  }
}

// Step 2: Backup
if (fs.existsSync(BACKUP_PATH)) {
  fs.unlinkSync(BACKUP_PATH);
}
fs.copyFileSync(DB_PATH, BACKUP_PATH);
console.log(`Backed up to ${BACKUP_PATH}`);

// Step 3: Open and repair corrupted rows
const db = new Database(DB_PATH);

// Run integrity check first
const integrity = db.prepare("PRAGMA integrity_check").all();
console.log(`\nPre-repair integrity: ${integrity[0].integrity_check}`);
if (integrity[0].integrity_check !== "ok") {
  for (const row of integrity.slice(0, 10)) {
    console.log(`  ${row.integrity_check}`);
  }
}

// Repair known corrupted rows
const repairs = [
  { id: 1041, description: "stage corruption (d5df72)" },
  { id: 1049, description: "stage corruption (null bytes)" },
  { id: 1030, description: "stage corruption (null bytes)" },
];

for (const r of repairs) {
  const row = db.prepare("SELECT id, stage FROM candidates WHERE id = ?").get(r.id);
  if (!row) {
    console.log(`\nID ${r.id}: not found, skipping`);
    continue;
  }

  const stage = row.stage;
  const isCorrupt =
    !["intake", "staged", "removed", "approved", "launch_ready", "published"].includes(stage);

  if (!isCorrupt) {
    console.log(`\nID ${r.id}: stage='${stage}' — already clean`);
    continue;
  }

  console.log(`\nID ${r.id}: stage='${stage}' — CORRUPTED, repairing...`);

  // Get staged_at from event log
  const event = db
    .prepare("SELECT created_at FROM item_events WHERE candidate_id = ? AND event_type = 'intake_approved'")
    .get(r.id);
  const stagedAt = event ? event.created_at : null;

  db.prepare(`UPDATE candidates SET
    stage = 'staged',
    generated_name = NULL,
    generated_description = NULL,
    staged_at = ?,
    processing_started_at = NULL,
    processing_completed_at = NULL,
    updated_at = NULL
  WHERE id = ?`).run(stagedAt, r.id);

  console.log(`  Repaired: stage='staged', staged_at=${stagedAt}`);
}

// Step 4: VACUUM to rebuild page structure
console.log("\nRunning VACUUM to rebuild page structure...");
db.exec("VACUUM");
console.log("VACUUM complete");

// Step 5: Final integrity check
const final = db.prepare("PRAGMA integrity_check").all();
console.log(`\nPost-rebuild integrity: ${final[0].integrity_check}`);

// Step 6: Verify counts
const stages = db.prepare("SELECT stage, COUNT(*) as c FROM candidates GROUP BY stage ORDER BY c DESC").all();
console.log("\nStage distribution:");
for (const s of stages) {
  console.log(`  ${s.stage}: ${s.c}`);
}

const total = db.prepare("SELECT COUNT(*) as c FROM candidates").get();
console.log(`\nTotal candidates: ${total.c}`);

db.close();
console.log("\n=== Rebuild complete ===");
console.log("Restart the server: TURSO_DATABASE_URL= TURSO_AUTH_TOKEN= node server.js");
