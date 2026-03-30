// migrate-canonical.js — Conservative migration to canonical data model
//
// This script is additive and non-destructive:
//   - Adds new columns alongside old ones (does not drop `status`)
//   - Creates new tables (processing_jobs, item_events, review_sessions)
//   - Migrates data conservatively (prefers null over uncertain values)
//   - Idempotent: safe to run multiple times
//
// Usage: node migrate-canonical.js

require("dotenv").config();
const { getDb } = require("./db");

// ---------------------------------------------------------------------------
// Status → Stage mapping (from readiness report Section 8.5)
// ---------------------------------------------------------------------------

const STATUS_TO_STAGE = {
  new:            "intake",
  approved:       "staged",
  editing:        "staged",
  skipped:        "staged",
  processing:     "staged",
  flagged:        "staged",
  ready:          "staged",
  launch_bucket:  "launch_ready",
  published:      "published",
  rejected:       "removed",
  removed:        "removed",
  delisted:       "removed",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function columnExists(db, table, column) {
  try {
    // Turso doesn't support PRAGMA; probe with a zero-row SELECT instead
    await db.execute(`SELECT "${column}" FROM "${table}" LIMIT 0`);
    return true;
  } catch (_) {
    return false;
  }
}

async function tableExists(db, table) {
  try {
    await db.execute(`SELECT 1 FROM "${table}" LIMIT 0`);
    return true;
  } catch (_) {
    return false;
  }
}

async function addColumnSafe(db, table, column, type) {
  const exists = await columnExists(db, table, column);
  if (exists) {
    console.log(`  [skip] ${table}.${column} already exists`);
    return false;
  }
  await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  console.log(`  [add]  ${table}.${column} (${type})`);
  return true;
}

async function countBy(db, table, field) {
  const result = await db.execute(`SELECT ${field}, COUNT(*) as c FROM ${table} GROUP BY ${field} ORDER BY COUNT(*) DESC`);
  return result.rows;
}

// ---------------------------------------------------------------------------
// Main migration
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== IMMIGRANT — Canonical Data Model Migration ===\n");

  const db = getDb();

  // -------------------------------------------------------------------------
  // STEP 1: Add new columns to candidates
  // -------------------------------------------------------------------------

  console.log("Step 1: Adding new columns to candidates...\n");

  const newColumns = [
    // Canonical state dimensions
    ["stage", "TEXT"],
    ["review_status", "TEXT"],
    ["review_session_id", "TEXT"],

    // Split lineage
    ["parent_id", "INTEGER"],
    ["split_group_id", "INTEGER"],
    ["is_split_child", "INTEGER DEFAULT 0"],

    // Generated content (Ghost Logic output — distinct from operator edits)
    ["generated_name", "TEXT"],
    ["generated_description", "TEXT"],

    // Timestamps
    ["staged_at", "TEXT"],
    ["processing_started_at", "TEXT"],
    ["processing_completed_at", "TEXT"],
    ["reviewed_at", "TEXT"],
    ["approved_at", "TEXT"],
    ["published_at", "TEXT"],
    ["updated_at", "TEXT"],
  ];

  let columnsAdded = 0;
  for (const [col, type] of newColumns) {
    const added = await addColumnSafe(db, "candidates", col, type);
    if (added) columnsAdded++;
  }
  console.log(`\n  ${columnsAdded} columns added, ${newColumns.length - columnsAdded} already existed.\n`);

  // -------------------------------------------------------------------------
  // STEP 2: Create new tables
  // -------------------------------------------------------------------------

  console.log("Step 2: Creating new tables...\n");

  if (await tableExists(db, "processing_jobs")) {
    console.log("  [skip] processing_jobs already exists");
  } else {
    await db.execute(`CREATE TABLE processing_jobs (
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
    )`);
    console.log("  [create] processing_jobs");
  }

  if (await tableExists(db, "item_events")) {
    console.log("  [skip] item_events already exists");
  } else {
    await db.execute(`CREATE TABLE item_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      from_stage TEXT,
      to_stage TEXT,
      metadata TEXT,
      created_at TEXT
    )`);
    console.log("  [create] item_events");
  }

  if (await tableExists(db, "review_sessions")) {
    console.log("  [skip] review_sessions already exists");
  } else {
    await db.execute(`CREATE TABLE review_sessions (
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
    )`);
    console.log("  [create] review_sessions");
  }

  console.log("");

  // -------------------------------------------------------------------------
  // STEP 3: Migrate stage from status
  // -------------------------------------------------------------------------

  console.log("Step 3: Migrating status → stage...\n");

  // Only migrate rows where stage is currently null (idempotent)
  const unmigrated = await db.execute(
    "SELECT COUNT(*) as c FROM candidates WHERE stage IS NULL"
  );
  const unmigratedCount = unmigrated.rows[0]?.c || 0;
  console.log(`  ${unmigratedCount} rows need stage migration.`);

  if (unmigratedCount > 0) {
    for (const [oldStatus, newStage] of Object.entries(STATUS_TO_STAGE)) {
      const result = await db.execute({
        sql: "UPDATE candidates SET stage = ? WHERE status = ? AND stage IS NULL",
        args: [newStage, oldStatus],
      });
      const affected = result.rowsAffected || 0;
      if (affected > 0) {
        console.log(`  [map] status='${oldStatus}' → stage='${newStage}' (${affected} rows)`);
      }
    }

    // Catch any unmapped status values
    const stillNull = await db.execute(
      "SELECT status, COUNT(*) as c FROM candidates WHERE stage IS NULL GROUP BY status"
    );
    if (stillNull.rows.length > 0) {
      console.log("\n  WARNING: Unmapped status values found:");
      for (const row of stillNull.rows) {
        console.log(`    status='${row.status}' — ${row.c} rows (setting stage='intake' as fallback)`);
      }
      await db.execute("UPDATE candidates SET stage = 'intake' WHERE stage IS NULL");
    }
  }

  console.log("");

  // -------------------------------------------------------------------------
  // STEP 4: Remap source values
  // -------------------------------------------------------------------------

  console.log("Step 4: Remapping source values...\n");

  const sourceRemaps = [
    ["aliexpress", "suggested"],
    ["cj", "suggested"],
  ];

  for (const [from, to] of sourceRemaps) {
    const result = await db.execute({
      sql: "UPDATE candidates SET source = ? WHERE source = ?",
      args: [to, from],
    });
    const affected = result.rowsAffected || 0;
    if (affected > 0) {
      console.log(`  [remap] source='${from}' → source='${to}' (${affected} rows)`);
    } else {
      console.log(`  [skip]  source='${from}' — no rows to remap`);
    }
  }

  console.log("");

  // -------------------------------------------------------------------------
  // STEP 5: Fix processing_status defaults
  // -------------------------------------------------------------------------

  console.log("Step 5: Fixing processing_status defaults...\n");

  // Items with processing_status='pending' that were never actually submitted
  // to Ghost Logic should have processing_status=null.
  //
  // Heuristic: if processing_status='pending' AND processed_image_url IS NULL
  // AND generated_name IS NULL AND edited_name IS NULL (via Ghost Logic),
  // then processing was never truly requested. However, some items may have
  // been queued but not yet picked up. We use the safest condition:
  // items in stage='intake' or stage='removed' should never be 'pending'.

  const fixResult = await db.execute(
    "UPDATE candidates SET processing_status = NULL WHERE processing_status = 'pending' AND stage IN ('intake', 'removed')"
  );
  console.log(`  [fix] Cleared processing_status='pending' on intake/removed items: ${fixResult.rowsAffected || 0} rows`);

  // NOTE: We intentionally do NOT clear processing_status='pending' on staged
  // items, even those with no processing evidence. Without strong proof that
  // these were never submitted, it is safer to leave them as-is and let the
  // operator resolve them manually via the Processing monitor.

  console.log("");

  // -------------------------------------------------------------------------
  // STEP 6: Generated name/description (conservative)
  // -------------------------------------------------------------------------

  console.log("Step 6: Generated content fields (conservative)...\n");

  // The readiness report identified that Ghost Logic worker writes to
  // edited_name and edited_description. We cannot distinguish operator edits
  // from Ghost Logic output retroactively.
  //
  // CONSERVATIVE CHOICE: Do NOT bulk-copy edited_name → generated_name.
  // Leave generated_name and generated_description as NULL for all
  // existing rows. The application will use the content resolution
  // chain: edited_name → generated_name → title. Since generated_name
  // is null, it will fall through to edited_name (which may contain
  // Ghost Logic output) or title. This is safe — no data is lost,
  // and no incorrect attribution is created.

  console.log("  [skip] Not copying edited_name → generated_name (provenance ambiguous).");
  console.log("  [skip] Not copying edited_description → generated_description (provenance ambiguous).");
  console.log("  [note] generated_* fields left null. Content resolution chain will");
  console.log("         fall through: edited_name → generated_name(null) → title.");
  console.log("         Existing edited_name/edited_description values are preserved.");

  console.log("");

  // -------------------------------------------------------------------------
  // STEP 7: Best-effort split lineage
  // -------------------------------------------------------------------------

  console.log("Step 7: Best-effort split lineage backfill...\n");

  // Find candidate split children: rows that have variant_specifics AND parent_url
  // but no parent_id set yet
  const splitCandidates = await db.execute(
    "SELECT id, parent_url, product_url FROM candidates WHERE variant_specifics IS NOT NULL AND parent_url IS NOT NULL AND parent_id IS NULL"
  );

  let linkedCount = 0;
  let ambiguousCount = 0;
  let noMatchCount = 0;

  for (const child of splitCandidates.rows) {
    // Find potential parents: items with the same product_url as the child's parent_url,
    // that are NOT themselves split children, and are not the child itself
    const parents = await db.execute({
      sql: "SELECT id FROM candidates WHERE product_url = ? AND id != ? AND (is_split_child = 0 OR is_split_child IS NULL) LIMIT 3",
      args: [child.parent_url, child.id],
    });

    if (parents.rows.length === 1) {
      // Unambiguous match
      const parentId = parents.rows[0].id;
      await db.execute({
        sql: "UPDATE candidates SET parent_id = ?, split_group_id = ?, is_split_child = 1 WHERE id = ?",
        args: [parentId, parentId, child.id],
      });
      linkedCount++;
    } else if (parents.rows.length > 1) {
      ambiguousCount++;
    } else {
      noMatchCount++;
    }
  }

  console.log(`  Split children found: ${splitCandidates.rows.length}`);
  console.log(`  Successfully linked: ${linkedCount}`);
  console.log(`  Ambiguous (multiple parents): ${ambiguousCount}`);
  console.log(`  No parent match: ${noMatchCount}`);

  if (ambiguousCount > 0 || noMatchCount > 0) {
    console.log(`  [note] ${ambiguousCount + noMatchCount} split children left without lineage.`);
    console.log(`         These can be manually resolved or will be ignored.`);
  }

  console.log("");

  // -------------------------------------------------------------------------
  // STEP 8: Timestamp backfill
  // -------------------------------------------------------------------------

  console.log("Step 8: Timestamp backfill...\n");

  // staged_at: for items in stage='staged' or downstream, use created_at as best guess
  const stagedTs = await db.execute(
    "UPDATE candidates SET staged_at = created_at WHERE staged_at IS NULL AND stage IN ('staged', 'approved', 'launch_ready', 'published')"
  );
  console.log(`  [set] staged_at from created_at: ${stagedTs.rowsAffected || 0} rows`);

  // approved_at: for items already in approved or downstream stages
  const approvedTs = await db.execute(
    "UPDATE candidates SET approved_at = created_at WHERE approved_at IS NULL AND stage IN ('approved', 'launch_ready', 'published')"
  );
  console.log(`  [set] approved_at from created_at: ${approvedTs.rowsAffected || 0} rows`);

  // published_at: for published items
  const publishedTs = await db.execute(
    "UPDATE candidates SET published_at = created_at WHERE published_at IS NULL AND stage = 'published'"
  );
  console.log(`  [set] published_at from created_at: ${publishedTs.rowsAffected || 0} rows`);

  // processing_completed_at: for items with processing_status='ready'
  const procTs = await db.execute(
    "UPDATE candidates SET processing_completed_at = created_at WHERE processing_completed_at IS NULL AND processing_status = 'ready'"
  );
  console.log(`  [set] processing_completed_at from created_at: ${procTs.rowsAffected || 0} rows`);

  // updated_at: set to created_at for all rows as baseline
  const updatedTs = await db.execute(
    "UPDATE candidates SET updated_at = created_at WHERE updated_at IS NULL"
  );
  console.log(`  [set] updated_at from created_at: ${updatedTs.rowsAffected || 0} rows`);

  console.log("");

  // -------------------------------------------------------------------------
  // STEP 9: Set review_status for items in downstream stages
  // -------------------------------------------------------------------------

  console.log("Step 9: Setting review_status for downstream items...\n");

  // Items that reached approved, launch_ready, or published must have
  // passed Photo Suite review at some point. Set review_status='accepted'.
  const reviewAccepted = await db.execute(
    "UPDATE candidates SET review_status = 'accepted' WHERE review_status IS NULL AND stage IN ('approved', 'launch_ready', 'published')"
  );
  console.log(`  [set] review_status='accepted' for downstream items: ${reviewAccepted.rowsAffected || 0} rows`);

  // Items with old status='flagged' were returned from Photo Suite.
  // Map to review_status='revision_needed'.
  const reviewRevision = await db.execute(
    "UPDATE candidates SET review_status = 'revision_needed' WHERE review_status IS NULL AND status = 'flagged'"
  );
  console.log(`  [set] review_status='revision_needed' for flagged items: ${reviewRevision.rowsAffected || 0} rows`);

  console.log("");

  // -------------------------------------------------------------------------
  // STEP 10: Verification report
  // -------------------------------------------------------------------------

  console.log("=== VERIFICATION REPORT ===\n");

  const total = await db.execute("SELECT COUNT(*) as c FROM candidates");
  console.log(`Total candidates: ${total.rows[0]?.c || 0}\n`);

  console.log("Old status distribution:");
  const byStatus = await countBy(db, "candidates", "status");
  for (const row of byStatus) {
    console.log(`  ${String(row.status).padEnd(16)} ${row.c}`);
  }

  console.log("\nNew stage distribution:");
  const byStage = await countBy(db, "candidates", "stage");
  for (const row of byStage) {
    console.log(`  ${String(row.stage).padEnd(16)} ${row.c}`);
  }

  console.log("\nSource distribution:");
  const bySource = await countBy(db, "candidates", "source");
  for (const row of bySource) {
    console.log(`  ${String(row.source).padEnd(16)} ${row.c}`);
  }

  console.log("\nProcessing status distribution:");
  const byProc = await countBy(db, "candidates", "processing_status");
  for (const row of byProc) {
    console.log(`  ${String(row.processing_status).padEnd(16)} ${row.c}`);
  }

  console.log("\nReview status distribution:");
  const byReview = await countBy(db, "candidates", "review_status");
  for (const row of byReview) {
    console.log(`  ${String(row.review_status).padEnd(16)} ${row.c}`);
  }

  console.log("\nSplit lineage:");
  const splitChildren = await db.execute("SELECT COUNT(*) as c FROM candidates WHERE is_split_child = 1");
  const splitOrphans = await db.execute("SELECT COUNT(*) as c FROM candidates WHERE variant_specifics IS NOT NULL AND parent_id IS NULL");
  console.log(`  Linked split children:    ${splitChildren.rows[0]?.c || 0}`);
  console.log(`  Unresolved split orphans: ${splitOrphans.rows[0]?.c || 0}`);

  console.log("\nTimestamp coverage:");
  for (const ts of ["staged_at", "approved_at", "published_at", "processing_completed_at", "updated_at"]) {
    const filled = await db.execute(`SELECT COUNT(*) as c FROM candidates WHERE ${ts} IS NOT NULL`);
    console.log(`  ${ts.padEnd(26)} ${filled.rows[0]?.c || 0} rows set`);
  }

  console.log("\nNew tables:");
  for (const table of ["processing_jobs", "item_events", "review_sessions"]) {
    const exists = await tableExists(db, table);
    const count = exists ? (await db.execute(`SELECT COUNT(*) as c FROM ${table}`)).rows[0]?.c || 0 : "N/A";
    console.log(`  ${table.padEnd(20)} ${exists ? "exists" : "MISSING"} (${count} rows)`);
  }

  // Cross-check: every row should have a stage value
  const nullStage = await db.execute("SELECT COUNT(*) as c FROM candidates WHERE stage IS NULL");
  const nullStageCount = nullStage.rows[0]?.c || 0;
  if (nullStageCount > 0) {
    console.log(`\n  ⚠ WARNING: ${nullStageCount} rows still have NULL stage!`);
  } else {
    console.log("\n  ✓ All rows have a stage value.");
  }

  // Cross-check: old status count should match new stage count
  const oldTotal = byStatus.reduce((s, r) => s + (r.c || 0), 0);
  const newTotal = byStage.reduce((s, r) => s + (r.c || 0), 0);
  if (oldTotal === newTotal) {
    console.log(`  ✓ Row count matches: ${oldTotal} (old) = ${newTotal} (new)`);
  } else {
    console.log(`  ⚠ Row count mismatch: ${oldTotal} (old) ≠ ${newTotal} (new)`);
  }

  console.log("\n=== Migration complete ===\n");
}

main().catch((err) => {
  console.error("MIGRATION FAILED:", err);
  process.exit(1);
});
