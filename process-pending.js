#!/usr/bin/env node
// process-pending.js — Process all stuck pending items directly
//
// Usage: TURSO_DATABASE_URL= TURSO_AUTH_TOKEN= node process-pending.js
//
// This script finds all items with processing_status='pending' and
// processing_started_at IS NOT NULL (real pending jobs, not legacy defaults)
// and runs the Ghost Logic pipeline on each one sequentially.
//
// Safe to run alongside the server — uses short-lived DB queries like --direct mode.

require("dotenv").config();
const { getDb, initSchema, queryAll, closeDb } = require("./db");
const { processCandidate } = require("./server/workers/ghostLogicWorker");

async function main() {
  console.log("=== Process Pending Items ===\n");
  const db = getDb();
  await initSchema(db);

  const pending = await queryAll(db,
    `SELECT id, title FROM candidates
     WHERE stage = 'staged'
       AND processing_status = 'pending'
       AND processing_started_at IS NOT NULL
     ORDER BY processing_started_at ASC`
  );

  if (pending.length === 0) {
    console.log("No pending items found.");
    closeDb();
    return;
  }

  console.log(`Found ${pending.length} pending item(s):\n`);
  for (const item of pending) {
    console.log(`  ID ${item.id}: ${(item.title || "").substring(0, 60)}`);
  }
  console.log();

  let succeeded = 0;
  let failed = 0;

  for (const item of pending) {
    console.log(`\n--- Processing ID ${item.id} ---`);
    try {
      const result = await processCandidate(item.id, db);
      console.log(`✓ ID ${item.id} complete — baseline: ${result.baseline}, name: "${result.name}"`);
      succeeded++;
    } catch (err) {
      console.error(`✗ ID ${item.id} failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n=== Done: ${succeeded} succeeded, ${failed} failed ===`);
  closeDb();
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
