#!/usr/bin/env node
// repair-stale-pending.js — One-time repair: clear processing_status on legacy
// items that were never actually submitted for processing.
//
// These items have processing_status='pending' from the column DEFAULT but
// no processing_started_at, no processing_jobs rows, and no item_events.
// They contaminate the Processing page with stale entries.
//
// Safe to run multiple times (idempotent).
//
// Usage:
//   TURSO_DATABASE_URL= node repair-stale-pending.js          # local SQLite
//   node repair-stale-pending.js                               # uses .env (Turso if configured)

require("dotenv").config();
const { getDb, initSchema, queryAll, run, closeDb } = require("./db");

(async () => {
  const db = getDb();
  await initSchema(db);

  // Find stale-pending candidates: processing_status='pending' but never started
  const stale = await queryAll(db, `
    SELECT id, title, source, stage, processing_status, processing_started_at, created_at
    FROM candidates
    WHERE processing_status = 'pending'
      AND processing_started_at IS NULL
  `);

  console.log(`[repair] Found ${stale.length} stale-pending item(s)`);

  if (stale.length === 0) {
    console.log("[repair] Nothing to repair.");
    closeDb();
    return;
  }

  // Log what we're about to fix
  for (const row of stale) {
    console.log(`  id=${row.id} stage=${row.stage} source=${row.source} created=${row.created_at} title="${(row.title || "").substring(0, 50)}"`);
  }

  // Clear processing_status to NULL on all stale-pending items
  const result = await run(db, `
    UPDATE candidates
    SET processing_status = NULL, updated_at = ?
    WHERE processing_status = 'pending'
      AND processing_started_at IS NULL
  `, [new Date().toISOString()]);

  const affected = result?.changes ?? result?.rowsAffected ?? 0;
  console.log(`[repair] Cleared processing_status on ${affected} item(s)`);

  // Verify
  const remaining = await queryAll(db, `
    SELECT COUNT(*) as c FROM candidates
    WHERE processing_status = 'pending' AND processing_started_at IS NULL
  `);
  console.log(`[repair] Remaining stale-pending: ${remaining[0]?.c || 0}`);

  closeDb();
  console.log("[repair] Done.");
})();
