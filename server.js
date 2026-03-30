// server.js — IMMIGRANT canonical API server
// Usage: node server.js
//
// Implements the canonical state model:
//   stage:             intake → staged → approved → launch_ready → published | removed
//   processing_status: null → pending → processing → ready | failed
//   review_status:     null → accepted | revision_needed | discarded
//
// Every mutation validates current state via WHERE clause, updates atomically,
// and logs to item_events only after confirmed state change.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { getDb, queryAll, queryOne, run } = require("./db");
const { enqueueProcessingJob } = require("./server/lib/processingQueue");
const { processCandidate } = require("./server/workers/ghostLogicWorker");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use("/images", express.static(path.join(__dirname, "images")));
app.use(express.static(path.join(__dirname, "client", "dist")));

let db = null;
let dbReady = false;
let dbError = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now() {
  return new Date().toISOString();
}

// Append an audit event. Called only after a confirmed state change.
async function logEvent(candidateId, eventType, fromStage, toStage, metadata) {
  await run(db,
    "INSERT INTO item_events (candidate_id, event_type, from_stage, to_stage, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [candidateId, eventType, fromStage || null, toStage || null, metadata ? JSON.stringify(metadata) : null, now()]
  );
}

// After a guarded UPDATE returns 0 rows affected, determine why.
// Returns a response-ready object: { status: 404|409, body: {...} }
async function diagnoseMutationFailure(id, expectedStage) {
  const item = await queryOne(db, "SELECT id, stage FROM candidates WHERE id = ?", [id]);
  if (!item) {
    return { status: 404, body: { error: "Item not found" } };
  }
  return {
    status: 409,
    body: {
      error: `Expected stage '${expectedStage}', found '${item.stage}'`,
      current_stage: item.stage,
    },
  };
}

// Middleware: require DB to be connected
function requireDb(req, res, next) {
  if (dbReady && db) return next();
  if (dbError) return res.status(503).json({ error: `Database unavailable: ${dbError}` });
  return res.status(503).json({ error: "Database initializing" });
}

// ---------------------------------------------------------------------------
// HEALTH — always responds, no DB required
// ---------------------------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({ ok: true, dbReady, dbError: dbError || null, timestamp: now() });
});

// ---------------------------------------------------------------------------
// IMAGE PROXY — serve AliExpress CDN images through backend to avoid hotlink blocks
// ---------------------------------------------------------------------------
//
// On Railway, local image files don't exist (ephemeral filesystem) and AliExpress
// CDN hotlink-protects images (403/blank when loaded from non-AliExpress origins).
// This proxy fetches images server-side (no hotlink issue) and caches via headers.
// Only allows AliExpress CDN domains to prevent open-proxy abuse.

app.get("/api/image-proxy", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url param" });

  // Allowlist: only proxy AliExpress CDN images
  if (!url.includes("alicdn.com") && !url.includes("aliexpress-media.com")) {
    return res.status(403).json({ error: "Only AliExpress CDN URLs allowed" });
  }

  try {
    const response = await fetch(url, {
      headers: {
        "Referer": "https://www.aliexpress.com/",
        "User-Agent": "Mozilla/5.0 (compatible; ImmigrantStore/1.0)"
      }
    });
    if (!response.ok) return res.status(response.status).end();

    const buffer = Buffer.from(await response.arrayBuffer());
    res.set("Content-Type", response.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=604800"); // 7-day browser cache
    res.send(buffer);
  } catch (err) {
    console.error("[image-proxy] Fetch failed:", url, err.message);
    res.status(502).end();
  }
});

// ---------------------------------------------------------------------------
// COUNTS — single endpoint for all sidebar badges
// ---------------------------------------------------------------------------
//
// Canonical visibility rules:
//
//   suggested:          source='suggested' AND stage='intake'
//   watched:            source='watched' AND stage='intake'
//   previously_ordered: source='past_order' AND stage='intake'
//   staging:            stage='staged'
//                       AND NOT (COALESCE(processing_status,'none') IN ('pending','processing') AND processing_started_at IS NOT NULL)
//                       AND NOT (COALESCE(processing_status,'none')='ready' AND review_status IS NULL)
//   processing:         stage='staged' AND processing_status IN ('pending','processing','failed')
//   photo_suite:        stage='staged' AND processing_status='ready' AND review_status IS NULL
//   approved:           stage='approved'
//   launch:             stage='launch_ready'
//   live:               stage='published'

app.get("/api/counts", requireDb, async (req, res) => {
  try {
    const counts = {};

    // Intake feeds — one grouped query
    const intakeCounts = await queryAll(db,
      "SELECT source, COUNT(*) as c FROM candidates WHERE stage = 'intake' GROUP BY source"
    );
    const intakeMap = {};
    for (const row of intakeCounts) intakeMap[row.source] = row.c;
    counts.suggested = intakeMap["suggested"] || 0;
    counts.watched = intakeMap["watched"] || 0;
    counts.previously_ordered = intakeMap["past_order"] || 0;
    counts.reverse_image = intakeMap["reverse_image"] || 0;
    counts.wishlist = intakeMap["wishlist"] || 0;

    // Staging: staged items excluding those in processing queue or awaiting first review.
    // review_status is canonically nullable (NULL = not yet reviewed).
    // We check IS NULL only; empty string should not occur in canonical data,
    // but the migration may have left some rows with empty string if the column
    // was added with a default. This is acceptable — those items would appear
    // in Staging (safe side) rather than Photo Suite.
    // Staging count: excludes items actively in processing (have processing_started_at)
    // and items awaiting Photo Suite review. Stale-pending items (no processing_started_at)
    // count as Staging since they were never actually submitted for processing.
    const stagingResult = await queryOne(db, `
      SELECT COUNT(*) as c FROM candidates
      WHERE stage = 'staged'
      AND NOT (COALESCE(processing_status, 'none') IN ('pending', 'processing') AND processing_started_at IS NOT NULL)
      AND NOT (COALESCE(processing_status, 'none') = 'ready' AND review_status IS NULL)
    `);
    counts.staging = stagingResult?.c || 0;

    // Processing (stale-pending guard: require processing_started_at for pending/processing)
    const processingResult = await queryOne(db,
      `SELECT COUNT(*) as c FROM candidates WHERE stage = 'staged' AND (
        (processing_status IN ('pending', 'processing') AND processing_started_at IS NOT NULL)
        OR processing_status = 'failed'
      )`
    );
    counts.processing = processingResult?.c || 0;

    // Photo Suite: only ready items that have NOT been reviewed
    const photoSuiteResult = await queryOne(db,
      "SELECT COUNT(*) as c FROM candidates WHERE stage = 'staged' AND processing_status = 'ready' AND review_status IS NULL"
    );
    counts.photo_suite = photoSuiteResult?.c || 0;

    // Approved
    const approvedResult = await queryOne(db,
      "SELECT COUNT(*) as c FROM candidates WHERE stage = 'approved'"
    );
    counts.approved = approvedResult?.c || 0;

    // Launch
    const launchResult = await queryOne(db,
      "SELECT COUNT(*) as c FROM candidates WHERE stage = 'launch_ready'"
    );
    counts.launch = launchResult?.c || 0;

    // Live
    const liveResult = await queryOne(db,
      "SELECT COUNT(*) as c FROM candidates WHERE stage = 'published'"
    );
    counts.live = liveResult?.c || 0;

    res.json(counts);
  } catch (err) {
    console.error("[api/counts]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// INTAKE — source feeds
// ---------------------------------------------------------------------------

// GET /api/intake/:source
app.get("/api/intake/:source", requireDb, async (req, res) => {
  try {
    const validSources = ["suggested", "watched", "past_order", "reverse_image", "wishlist"];
    const source = req.params.source;

    if (!validSources.includes(source)) {
      return res.status(400).json({ error: `Invalid source. Expected one of: ${validSources.join(", ")}` });
    }

    const items = await queryAll(db,
      "SELECT * FROM candidates WHERE source = ? AND stage = 'intake' ORDER BY created_at DESC",
      [source]
    );

    res.json({ items, count: items.length });
  } catch (err) {
    console.error("[api/intake]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/intake/:id/approve — transition T1: intake → staged
//
// The UPDATE itself is the guard: WHERE id = ? AND stage = 'intake'.
// If rowsAffected = 0, we diagnose whether the item is missing or in the wrong stage.
// item_events is appended only after a confirmed transition.
app.post("/api/intake/:id/approve", requireDb, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const timestamp = now();

    const result = await run(db,
      "UPDATE candidates SET stage = 'staged', processing_status = NULL, staged_at = ?, updated_at = ? WHERE id = ? AND stage = 'intake'",
      [timestamp, timestamp, id]
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      const diag = await diagnoseMutationFailure(id, "intake");
      return res.status(diag.status).json(diag.body);
    }

    await logEvent(id, "intake_approved", "intake", "staged", null);

    const updated = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[api/intake/approve]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/intake/:id/reject — transition T2: intake → removed
app.post("/api/intake/:id/reject", requireDb, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });

    const timestamp = now();

    const result = await run(db,
      "UPDATE candidates SET stage = 'removed', updated_at = ? WHERE id = ? AND stage = 'intake'",
      [timestamp, id]
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      const diag = await diagnoseMutationFailure(id, "intake");
      return res.status(diag.status).json(diag.body);
    }

    await logEvent(id, "intake_rejected", "intake", "removed", null);

    res.json({ ok: true });
  } catch (err) {
    console.error("[api/intake/reject]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// STAGING
// ---------------------------------------------------------------------------

// Canonical Staging visibility rule as a SQL fragment.
// Staging shows staged items EXCEPT those actively in the processing queue
// AND EXCEPT those awaiting first Photo Suite review.
// Stale-pending guard: only exclude pending/processing items that were actually
// submitted (have processing_started_at). Legacy items with the column default
// of 'pending' but no started_at appear in Staging, not Processing.
const STAGING_VISIBILITY = `
  stage = 'staged'
  AND NOT (COALESCE(processing_status, 'none') IN ('pending', 'processing') AND processing_started_at IS NOT NULL)
`;

const VALID_GENDERS = ["mens", "womens", "unisex"];
const VALID_CATEGORIES = ["tops", "bottoms", "outerwear", "footwear", "jewelry", "belts", "accessories"];

// Helper: validate id param. Returns parsed int or sends 400 and returns null.
function parseId(req, res) {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return null;
  }
  return id;
}

// Helper: fetch item and verify it is visible in Staging.
// Returns the item, or sends an error response and returns null.
async function requireStagingItem(res, id) {
  const item = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
  if (!item) {
    res.status(404).json({ error: "Item not found" });
    return null;
  }
  // Check canonical Staging visibility
  if (item.stage !== "staged") {
    res.status(409).json({
      error: `Item is not in Staging (stage='${item.stage}')`,
      current_stage: item.stage,
    });
    return null;
  }
  const inProcessingQueue = item.processing_status === "pending" || item.processing_status === "processing";
  if (inProcessingQueue) {
    res.status(409).json({
      error: `Item is staged but currently in the processing queue (processing_status='${item.processing_status}')`,
      current_stage: item.stage,
      processing_status: item.processing_status,
      review_status: item.review_status,
    });
    return null;
  }
  return item;
}

// GET /api/staging — items visible in the Staging workbench
app.get("/api/staging", requireDb, async (req, res) => {
  try {
    const items = await queryAll(db, `
      SELECT * FROM candidates
      WHERE ${STAGING_VISIBILITY}
      ORDER BY
        CASE WHEN review_status = 'revision_needed' THEN 0 ELSE 1 END,
        COALESCE(staged_at, created_at) DESC
    `);
    res.json({ items, count: items.length });
  } catch (err) {
    console.error("[api/staging]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/staging/:id — single Staging item for Deep Edit
app.get("/api/staging/:id", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const item = await requireStagingItem(res, id);
    if (!item) return;

    res.json(item);
  } catch (err) {
    console.error("[api/staging/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/staging/:id/gallery — update curated image gallery
//
// Mutation-guarded: UPDATE includes STAGING_VISIBILITY in WHERE clause.
// Pre-read is used only to capture before-count for the event log.
app.put("/api/staging/:id/gallery", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const { images } = req.body;
    if (!Array.isArray(images)) {
      return res.status(400).json({ error: "images must be an array" });
    }

    // Pre-read for event metadata (before-count). Not a guard.
    const before = await queryOne(db, "SELECT all_images FROM candidates WHERE id = ?", [id]);
    let beforeCount = 0;
    if (before) { try { beforeCount = JSON.parse(before.all_images || "[]").length; } catch (_) {} }

    const timestamp = now();
    const primaryImage = images.length > 0 ? images[0] : null;

    // Guarded mutation: only updates if item is visible in Staging
    const result = await run(db,
      `UPDATE candidates SET all_images = ?, image_url = ?, updated_at = ?
       WHERE id = ? AND ${STAGING_VISIBILITY}`,
      [JSON.stringify(images), primaryImage, timestamp, id]
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      const item = await queryOne(db, "SELECT id, stage, processing_status, review_status FROM candidates WHERE id = ?", [id]);
      if (!item) return res.status(404).json({ error: "Item not found" });
      return res.status(409).json({
        error: "Item is not editable in Staging in its current state",
        current_stage: item.stage, processing_status: item.processing_status, review_status: item.review_status,
      });
    }

    await logEvent(id, "gallery_edited", null, null, {
      image_count_before: beforeCount,
      image_count_after: images.length,
    });

    const updated = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[api/staging/:id/gallery]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/staging/:id/metadata — update gender, category, price
//
// Mutation-guarded: UPDATE includes STAGING_VISIBILITY in WHERE clause.
app.put("/api/staging/:id/metadata", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const { gender, detected_category, edited_price, edited_name, edited_description } = req.body;

    // Validate provided fields before touching the database
    if (gender !== undefined && !VALID_GENDERS.includes(gender)) {
      return res.status(400).json({ error: `Invalid gender. Expected: ${VALID_GENDERS.join(", ")}` });
    }
    if (detected_category !== undefined && !VALID_CATEGORIES.includes(detected_category)) {
      return res.status(400).json({ error: `Invalid category. Expected: ${VALID_CATEGORIES.join(", ")}` });
    }
    if (edited_price !== undefined && (typeof edited_price !== "number" || isNaN(edited_price))) {
      return res.status(400).json({ error: "edited_price must be a number" });
    }
    if (edited_name !== undefined && typeof edited_name !== "string") {
      return res.status(400).json({ error: "edited_name must be a string" });
    }
    if (edited_description !== undefined && typeof edited_description !== "string") {
      return res.status(400).json({ error: "edited_description must be a string" });
    }

    // Build dynamic SET clause
    const sets = [];
    const params = [];
    const changedFields = [];

    if (edited_name !== undefined) { sets.push("edited_name = ?"); params.push(edited_name); changedFields.push("edited_name"); }
    if (edited_description !== undefined) { sets.push("edited_description = ?"); params.push(edited_description); changedFields.push("edited_description"); }
    if (gender !== undefined) { sets.push("gender = ?"); params.push(gender); changedFields.push("gender"); }
    if (detected_category !== undefined) { sets.push("detected_category = ?"); params.push(detected_category); changedFields.push("detected_category"); }
    if (edited_price !== undefined) { sets.push("edited_price = ?"); params.push(edited_price); changedFields.push("edited_price"); }

    if (sets.length === 0) {
      return res.status(400).json({ error: "No valid fields provided" });
    }

    const timestamp = now();
    sets.push("updated_at = ?");
    params.push(timestamp);
    params.push(id);

    // Guarded mutation: only updates if item is visible in Staging
    const result = await run(db,
      `UPDATE candidates SET ${sets.join(", ")} WHERE id = ? AND ${STAGING_VISIBILITY}`,
      params
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      const item = await queryOne(db, "SELECT id, stage, processing_status, review_status FROM candidates WHERE id = ?", [id]);
      if (!item) return res.status(404).json({ error: "Item not found" });
      return res.status(409).json({
        error: "Item is not editable in Staging in its current state",
        current_stage: item.stage, processing_status: item.processing_status, review_status: item.review_status,
      });
    }

    await logEvent(id, "edited", null, null, { fields_changed: changedFields });

    const updated = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[api/staging/:id/metadata]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/staging/:id/remove — transition: staged → removed (T5)
//
// Guarded UPDATE: only removes items currently visible in Staging.
// Uses the full Staging visibility condition in the WHERE clause
// so items in processing queue or awaiting review cannot be removed
// through this endpoint.
app.post("/api/staging/:id/remove", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const timestamp = now();

    const result = await run(db,
      `UPDATE candidates SET stage = 'removed', updated_at = ?
       WHERE id = ? AND ${STAGING_VISIBILITY}`,
      [timestamp, id]
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      // Diagnose: does the item exist? Is it in the wrong state?
      const item = await queryOne(db, "SELECT id, stage, processing_status, review_status FROM candidates WHERE id = ?", [id]);
      if (!item) {
        return res.status(404).json({ error: "Item not found" });
      }
      return res.status(409).json({
        error: "Item cannot be removed from Staging in its current state",
        current_stage: item.stage,
        processing_status: item.processing_status,
        review_status: item.review_status,
      });
    }

    await logEvent(id, "removed", "staged", "removed", null);

    res.json({ ok: true });
  } catch (err) {
    console.error("[api/staging/:id/remove]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// STAGING — Split (T3/T3a)
// ---------------------------------------------------------------------------

// POST /api/staging/:id/split — create a split child from a staged parent
//
// Uses db.transaction('write') for true rollback semantics.
// The guarded parent UPDATE, child INSERT, and event INSERTs all execute
// inside one transaction. If the parent guard fails (0 rows affected),
// the transaction is rolled back — no child row, no events, no side effects.
app.post("/api/staging/:id/split", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const { image_url, variant_id, variant_name, available_sizes } = req.body;

    if (!image_url || typeof image_url !== "string") {
      return res.status(400).json({ error: "image_url is required" });
    }
    if (available_sizes !== undefined && !Array.isArray(available_sizes)) {
      return res.status(400).json({ error: "available_sizes must be an array" });
    }

    // Pre-read parent for data needed to build child and compute gallery diff.
    // Not a guard — the guarded UPDATE inside the transaction protects the mutation.
    const parent = await requireStagingItem(res, id);
    if (!parent) return;

    const timestamp = now();
    const splitGroupId = parent.split_group_id || parent.id;

    const variantSpecifics = JSON.stringify({
      color_property: variant_id || null,
      color_name: variant_name || null,
      available_sizes: available_sizes || null,
      parent_id: parent.id,
    });

    // Compute updated parent gallery
    let parentGallery = [];
    try { parentGallery = JSON.parse(parent.all_images || "[]"); } catch (_) {}
    const cleanUrl = (u) => { const m = (u || "").match(/^(.*?\.(?:jpg|jpeg|png))/i); return m ? m[1] : u; };
    const splitCleaned = cleanUrl(image_url);
    const updatedGallery = parentGallery.filter((u) => cleanUrl(u) !== splitCleaned && u !== image_url);
    const newHero = updatedGallery.length > 0 ? updatedGallery[0] : null;

    // Open a write transaction — all changes commit or rollback together
    const tx = await db.transaction("write");
    let childId = 0;

    try {
      // [1] Guarded parent gallery update
      const parentResult = await tx.execute({
        sql: `UPDATE candidates SET all_images = ?, image_url = ?, updated_at = ?
              WHERE id = ? AND ${STAGING_VISIBILITY}`,
        args: [JSON.stringify(updatedGallery), newHero, timestamp, id],
      });

      if ((parentResult?.rowsAffected ?? 0) === 0) {
        // Parent guard failed — rollback everything and diagnose
        await tx.rollback();
        const current = await queryOne(db, "SELECT id, stage, processing_status, review_status FROM candidates WHERE id = ?", [id]);
        if (!current) return res.status(404).json({ error: "Item not found" });
        return res.status(409).json({
          error: "Parent item is not editable in Staging in its current state",
          current_stage: current.stage,
          processing_status: current.processing_status,
          review_status: current.review_status,
        });
      }

      // [2] Child insert
      const childResult = await tx.execute({
        sql: `INSERT INTO candidates (
                title, image_url, all_images, source, ali_product_id, product_url,
                price, shipping_cost, gender, detected_category,
                stage, processing_status, review_status,
                parent_id, split_group_id, is_split_child, variant_specifics,
                staged_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', NULL, NULL, ?, ?, 1, ?, ?, ?, ?)`,
        args: [
          parent.title, image_url, JSON.stringify([image_url]),
          parent.source, parent.ali_product_id, parent.product_url,
          parent.price, parent.shipping_cost, parent.gender, parent.detected_category,
          parent.id, splitGroupId, variantSpecifics,
          timestamp, timestamp, timestamp,
        ],
      });

      childId = Number(childResult?.lastInsertRowid ?? 0);

      // [3] Event: parent split
      await tx.execute({
        sql: "INSERT INTO item_events (candidate_id, event_type, from_stage, to_stage, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, "split_created", null, null, JSON.stringify({
          parent_id: parent.id, child_id: childId,
          variant_image_url: image_url,
          variant_id: variant_id || null, variant_name: variant_name || null,
        }), timestamp],
      });

      // [4] Event: child created by split
      await tx.execute({
        sql: "INSERT INTO item_events (candidate_id, event_type, from_stage, to_stage, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [childId, "split_created", null, "staged", JSON.stringify({
          parent_id: parent.id, child_id: childId,
          variant_image_url: image_url, created_by: "split",
        }), timestamp],
      });

      // All succeeded — commit
      await tx.commit();
    } catch (txErr) {
      // Any error inside the transaction — rollback and re-throw
      try { await tx.rollback(); } catch (_) {}
      throw txErr;
    }

    // Read the committed child row for the response
    const child = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [childId]);
    res.json({
      child,
      parent_id: parent.id,
      updated_parent_gallery: updatedGallery,
    });
  } catch (err) {
    console.error("[api/staging/:id/split]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// STAGING — Process (P1)
// ---------------------------------------------------------------------------

// POST /api/staging/:id/process — send a Staging item into Ghost Logic processing
//
// Guarded mutation: sets processing_status='pending' only on items
// currently visible in Staging. Stage remains 'staged'.
// Creates a processing_jobs row for tracking.
app.post("/api/staging/:id/process", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    // Check for usable image before attempting mutation.
    // We need to read the item to verify image availability.
    const item = await queryOne(db, "SELECT all_images, image_url FROM candidates WHERE id = ?", [id]);
    if (!item) return res.status(404).json({ error: "Item not found" });

    let hasImage = false;
    try {
      const gallery = JSON.parse(item.all_images || "[]");
      if (gallery.length > 0) hasImage = true;
    } catch (_) {}
    if (!hasImage && item.image_url) hasImage = true;

    if (!hasImage) {
      return res.status(400).json({ error: "Cannot process: no usable image. Fetch gallery or set image_url first." });
    }

    const timestamp = now();

    // Single atomic guarded mutation: sets processing_status='pending',
    // clears review_status if revision_needed (R4), updates timestamps.
    // CASE expression handles the conditional review_status clear in one UPDATE.
    const result = await run(db,
      `UPDATE candidates SET
        processing_status = 'pending',
        review_status = CASE WHEN review_status = 'revision_needed' THEN NULL ELSE review_status END,
        processing_started_at = ?,
        updated_at = ?
       WHERE id = ? AND ${STAGING_VISIBILITY}`,
      [timestamp, timestamp, id]
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      const current = await queryOne(db, "SELECT id, stage, processing_status, review_status FROM candidates WHERE id = ?", [id]);
      if (!current) return res.status(404).json({ error: "Item not found" });
      return res.status(409).json({
        error: "Item cannot be sent to processing in its current state",
        current_stage: current.stage,
        processing_status: current.processing_status,
        review_status: current.review_status,
      });
    }

    // Create processing_jobs row
    const jobResult = await run(db,
      "INSERT INTO processing_jobs (candidate_id, status, created_at) VALUES (?, 'pending', ?)",
      [id, timestamp]
    );

    const jobId = Number(jobResult?.lastInsertRowid ?? 0);

    await logEvent(id, "processing_submitted", null, null, { processing_job_id: jobId });

    // --- Execution path: local direct vs production queue ---
    //
    // Local mode (no REDIS_URL): await processCandidate directly in the request.
    // No queue, no fire-and-forget, no pending limbo. The response includes the
    // FINAL state (ready/failed). Pipeline takes 30-60s — acceptable for local dev.
    //
    // Production mode (REDIS_URL set): enqueue to BullMQ, return immediately at
    // 'pending'. Worker picks up the job asynchronously.
    const isLocalMode = !process.env.REDIS_URL;

    if (isLocalMode) {
      console.log(`[api/staging/${id}/process] Local mode — running Ghost Logic directly for candidate ${id}`);
      try {
        const result = await processCandidate(id, db);
        console.log(`[ghost-direct][${id}] Pipeline complete ✓ baseline: ${result.baseline}`);
      } catch (err) {
        // processCandidate's outer catch guarantees processing_status='failed' in DB
        console.error(`[ghost-direct][${id}] Pipeline failed: ${err.message}`);
      }
    } else {
      const enqueued = await enqueueProcessingJob(jobId, id);
      if (!enqueued) {
        console.error(`[api/staging/${id}/process] Production mode but queue unavailable — candidate ${id} stuck at pending. Check REDIS_URL.`);
      }
    }

    const updated = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[api/staging/:id/process]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PROCESSING MONITOR
// ---------------------------------------------------------------------------

// Stale-pending guard: legacy pre-canonical rows have processing_status='pending' from the
// column DEFAULT but were never actually submitted for processing (no processing_started_at,
// no processing_jobs row). Require processing_started_at to be set for pending/processing items.
// Failed items always show (they were processed and failed — they have started_at).
const PROCESSING_VISIBILITY = `stage = 'staged' AND (
  (processing_status IN ('pending', 'processing') AND processing_started_at IS NOT NULL)
  OR processing_status = 'failed'
)`;

// Helper: diagnose processing mutation failure (item missing vs wrong state)
async function diagnoseProcessingFailure(id) {
  const item = await queryOne(db, "SELECT id, stage, processing_status, review_status FROM candidates WHERE id = ?", [id]);
  if (!item) {
    return { status: 404, body: { error: "Item not found" } };
  }
  return {
    status: 409,
    body: {
      error: "Item is not in the expected processing state",
      current_stage: item.stage,
      processing_status: item.processing_status,
      review_status: item.review_status,
    },
  };
}

// GET /api/processing — items visible in the Processing monitor
//
// Sorted: failed first, then processing, then pending.
// Within each group, newest first by processing_started_at.
app.get("/api/processing", requireDb, async (req, res) => {
  try {
    const items = await queryAll(db, `
      SELECT c.*,
        (SELECT pj.id FROM processing_jobs pj
         WHERE pj.candidate_id = c.id ORDER BY pj.id DESC LIMIT 1) as latest_job_id,
        (SELECT pj.status FROM processing_jobs pj
         WHERE pj.candidate_id = c.id ORDER BY pj.id DESC LIMIT 1) as latest_job_status,
        (SELECT pj.error_message FROM processing_jobs pj
         WHERE pj.candidate_id = c.id ORDER BY pj.id DESC LIMIT 1) as latest_job_error,
        (SELECT pj.started_at FROM processing_jobs pj
         WHERE pj.candidate_id = c.id ORDER BY pj.id DESC LIMIT 1) as latest_job_started_at
      FROM candidates c
      WHERE ${PROCESSING_VISIBILITY}
      ORDER BY
        CASE c.processing_status
          WHEN 'failed' THEN 0
          WHEN 'processing' THEN 1
          WHEN 'pending' THEN 2
        END,
        COALESCE(c.processing_started_at, c.created_at) DESC
    `);
    res.json({ items, count: items.length });
  } catch (err) {
    console.error("[api/processing]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/processing/:id — single processing item with job history
app.get("/api/processing/:id", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const item = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
    if (!item) return res.status(404).json({ error: "Item not found" });

    // Verify item belongs to Processing monitor
    const inProcessing =
      item.stage === "staged" &&
      ["pending", "processing", "failed"].includes(item.processing_status);

    if (!inProcessing) {
      return res.status(409).json({
        error: `Item is not visible in Processing (stage='${item.stage}', processing_status='${item.processing_status}')`,
        current_stage: item.stage,
        processing_status: item.processing_status,
        review_status: item.review_status,
      });
    }

    // Include processing job history, newest first
    const jobs = await queryAll(db,
      "SELECT * FROM processing_jobs WHERE candidate_id = ? ORDER BY id DESC",
      [id]
    );

    res.json({ ...item, processing_jobs: jobs });
  } catch (err) {
    console.error("[api/processing/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/processing/:id/retry — retry a failed/stuck processing item (P5)
//
// Guarded: only retries items where stage='staged' AND processing_status IN ('failed','pending').
// Accepts both failed items and stuck-pending items (worker crashed without updating status).
// Creates a new processing_jobs row. Does not change stage.
app.post("/api/processing/:id/retry", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const timestamp = now();

    const result = await run(db,
      `UPDATE candidates SET processing_status = 'pending', processing_started_at = ?, updated_at = ?
       WHERE id = ? AND stage = 'staged' AND processing_status IN ('failed', 'pending')`,
      [timestamp, timestamp, id]
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      const diag = await diagnoseProcessingFailure(id);
      return res.status(diag.status).json(diag.body);
    }

    // Create new processing_jobs row for this retry attempt
    const jobResult = await run(db,
      "INSERT INTO processing_jobs (candidate_id, status, created_at) VALUES (?, 'pending', ?)",
      [id, timestamp]
    );
    const jobId = Number(jobResult?.lastInsertRowid ?? 0);

    await logEvent(id, "processing_retried", null, null, { processing_job_id: jobId });

    // Local mode: await directly. Production: enqueue to BullMQ.
    const isLocalMode = !process.env.REDIS_URL;

    if (isLocalMode) {
      console.log(`[api/processing/${id}/retry] Local mode — running Ghost Logic directly for candidate ${id}`);
      try {
        const result = await processCandidate(id, db);
        console.log(`[ghost-direct][${id}] Retry complete ✓ baseline: ${result.baseline}`);
      } catch (err) {
        console.error(`[ghost-direct][${id}] Retry failed: ${err.message}`);
      }
    } else {
      const enqueued = await enqueueProcessingJob(jobId, id);
      if (!enqueued) {
        console.error(`[api/processing/${id}/retry] Production mode but queue unavailable — candidate ${id} stuck at pending. Check REDIS_URL.`);
      }
    }

    const updated = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[api/processing/:id/retry]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/processing/:id/return — return a failed/stuck item to Staging (P6)
//
// Guarded: only returns items where stage='staged' AND processing_status IN ('failed','pending').
// Accepts both failed items and stuck-pending items (worker crashed without updating status).
// Clears processing_status to NULL. Does not change stage.
app.post("/api/processing/:id/return", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const timestamp = now();

    const result = await run(db,
      `UPDATE candidates SET processing_status = NULL, updated_at = ?
       WHERE id = ? AND stage = 'staged' AND processing_status IN ('failed', 'pending')`,
      [timestamp, id]
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      const diag = await diagnoseProcessingFailure(id);
      return res.status(diag.status).json(diag.body);
    }

    await logEvent(id, "processing_returned", null, null, null);

    res.json({ ok: true });
  } catch (err) {
    console.error("[api/processing/:id/return]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PHOTO SUITE
// ---------------------------------------------------------------------------

// Canonical Photo Suite pool: items ready for review
const PHOTO_SUITE_POOL = `stage = 'staged' AND processing_status = 'ready' AND review_status IS NULL`;

// Helper: generate a unique session id
function sessionId() {
  return `rs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Helper: find the current active review session (session-mode first, then flow)
async function getActiveSession() {
  // Session-mode takes priority
  const session = await queryOne(db,
    "SELECT * FROM review_sessions WHERE status = 'active' AND mode = 'session' ORDER BY started_at DESC LIMIT 1"
  );
  if (session) return session;
  return await queryOne(db,
    "SELECT * FROM review_sessions WHERE status = 'active' AND mode = 'flow' ORDER BY started_at DESC LIMIT 1"
  );
}

// Helper: validate that an item is reviewable under the current session's ownership rules.
// Returns { item, session } or sends an error response and returns null.
async function requireReviewableItem(res, id) {
  const item = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
  if (!item) {
    res.status(404).json({ error: "Item not found" });
    return null;
  }

  // Must be in the Photo Suite pool regardless of session mode
  const inPool = item.stage === "staged"
    && item.processing_status === "ready"
    && !item.review_status;

  if (!inPool) {
    res.status(409).json({
      error: `Item is not reviewable (stage='${item.stage}', processing_status='${item.processing_status}', review_status='${item.review_status || "null"}')`,
      current_stage: item.stage,
      processing_status: item.processing_status,
      review_status: item.review_status,
    });
    return null;
  }

  const session = await getActiveSession();
  if (!session) {
    res.status(404).json({ error: "No active Photo Suite session. Start one first." });
    return null;
  }

  // Enforce session ownership
  if (session.mode === "session") {
    // Session mode: item must be locked to THIS session
    if (item.review_session_id !== session.id) {
      res.status(409).json({
        error: "Item is not locked to the current session",
        item_session_id: item.review_session_id || null,
        active_session_id: session.id,
      });
      return null;
    }
  } else {
    // Flow mode: item must not be locked to an active session-mode session
    if (item.review_session_id) {
      const lockOwner = await queryOne(db,
        "SELECT id FROM review_sessions WHERE id = ? AND status = 'active' AND mode = 'session'",
        [item.review_session_id]
      );
      if (lockOwner) {
        res.status(409).json({
          error: "Item is locked to an active session-mode session",
          locked_to_session: item.review_session_id,
        });
        return null;
      }
    }
  }

  return { item, session };
}

// Helper: increment a session counter after a review action
async function incrementSessionCounter(sessionId, field) {
  if (!sessionId) return;
  await run(db,
    `UPDATE review_sessions SET items_reviewed = items_reviewed + 1, ${field} = ${field} + 1 WHERE id = ?`,
    [sessionId]
  );
}

// GET /api/photo-suite — base route returns pool status
//
// Gives callers a summary of the Photo Suite state (pool count, active session).
// The Photo Suite workflow uses sub-routes: /ready-count, /next, /start-flow, etc.
app.get("/api/photo-suite", requireDb, async (req, res) => {
  try {
    const pool = await queryOne(db, `SELECT COUNT(*) as c FROM candidates WHERE ${PHOTO_SUITE_POOL}`);
    const session = await getActiveSession();
    res.json({
      pool_count: pool?.c || 0,
      active_session: session ? { id: session.id, mode: session.mode, status: session.status } : null,
      endpoints: ["/api/photo-suite/ready-count", "/api/photo-suite/start-flow", "/api/photo-suite/next"],
    });
  } catch (err) {
    console.error("[api/photo-suite]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/photo-suite/ready-count
//
// Count of reviewable items: ready, unreviewed, not locked to an active session.
app.get("/api/photo-suite/ready-count", requireDb, async (req, res) => {
  try {
    const result = await queryOne(db, `
      SELECT COUNT(*) as c FROM candidates
      WHERE ${PHOTO_SUITE_POOL}
      AND (review_session_id IS NULL
           OR review_session_id NOT IN (
             SELECT id FROM review_sessions WHERE status = 'active' AND mode = 'session'
           ))
    `);
    res.json({ count: result?.c || 0 });
  } catch (err) {
    console.error("[api/photo-suite/ready-count]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/photo-suite/start-flow
//
// Start Flow Mode: create a session row, don't lock any items.
// If an active session-mode session exists, reject (abandon it first).
// If an active flow session already exists, return it (no duplicates).
app.post("/api/photo-suite/start-flow", requireDb, async (req, res) => {
  try {
    // Block if a session-mode session is active
    const activeSessionMode = await queryOne(db,
      "SELECT * FROM review_sessions WHERE status = 'active' AND mode = 'session' LIMIT 1"
    );
    if (activeSessionMode) {
      return res.status(409).json({
        error: "An active session-mode session exists. Abandon it before starting flow.",
        active_session: activeSessionMode,
      });
    }

    // Return existing active flow session if one exists
    const existingFlow = await queryOne(db,
      "SELECT * FROM review_sessions WHERE status = 'active' AND mode = 'flow' ORDER BY started_at DESC LIMIT 1"
    );
    if (existingFlow) {
      return res.json(existingFlow);
    }

    const id = sessionId();
    const timestamp = now();

    await run(db,
      "INSERT INTO review_sessions (id, mode, status, started_at) VALUES (?, 'flow', 'active', ?)",
      [id, timestamp]
    );

    const session = await queryOne(db, "SELECT * FROM review_sessions WHERE id = ?", [id]);
    res.json(session);
  } catch (err) {
    console.error("[api/photo-suite/start-flow]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/photo-suite/start-session
//
// Start Session Mode: create a session row, lock up to batch_size items.
// Rejects if any active session (session or flow) already exists.
app.post("/api/photo-suite/start-session", requireDb, async (req, res) => {
  try {
    const { batch_size } = req.body;

    if (!batch_size || !Number.isInteger(batch_size) || batch_size < 1) {
      return res.status(400).json({ error: "batch_size must be a positive integer" });
    }

    // Block if any active session exists
    const existing = await queryOne(db,
      "SELECT * FROM review_sessions WHERE status = 'active' ORDER BY started_at DESC LIMIT 1"
    );
    if (existing) {
      return res.status(409).json({
        error: `An active ${existing.mode}-mode session already exists. Abandon it first.`,
        active_session: existing,
      });
    }

    const id = sessionId();
    const timestamp = now();

    // Create session row
    await run(db,
      "INSERT INTO review_sessions (id, mode, batch_size, status, started_at) VALUES (?, 'session', ?, 'active', ?)",
      [id, batch_size, timestamp]
    );

    // Select items from the pool, excluding those locked to another active session
    const items = await queryAll(db, `
      SELECT id FROM candidates
      WHERE ${PHOTO_SUITE_POOL}
      AND (review_session_id IS NULL
           OR review_session_id NOT IN (
             SELECT rs.id FROM review_sessions rs WHERE rs.status = 'active' AND rs.mode = 'session'
           ))
      ORDER BY COALESCE(processing_completed_at, created_at) DESC
      LIMIT ?
    `, [batch_size]);

    // Lock selected items
    let lockedCount = 0;
    for (const item of items) {
      const result = await run(db,
        `UPDATE candidates SET review_session_id = ?, updated_at = ?
         WHERE id = ? AND ${PHOTO_SUITE_POOL}`,
        [id, timestamp, item.id]
      );
      const affected = result?.rowsAffected ?? result?.changes ?? 0;
      if (affected > 0) lockedCount++;
    }

    const session = await queryOne(db, "SELECT * FROM review_sessions WHERE id = ?", [id]);
    res.json({ session, locked_count: lockedCount });
  } catch (err) {
    console.error("[api/photo-suite/start-session]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/photo-suite/next
//
// Return the next item for the current active Photo Suite session.
// Session-mode sessions take priority over flow-mode.
app.get("/api/photo-suite/next", requireDb, async (req, res) => {
  try {
    const session = await getActiveSession();

    if (!session) {
      return res.status(404).json({ error: "No active Photo Suite session. Start one with /api/photo-suite/start-flow or /api/photo-suite/start-session." });
    }

    let item = null;

    if (session.mode === "session") {
      // Session Mode: return next item locked to this session
      item = await queryOne(db, `
        SELECT * FROM candidates
        WHERE ${PHOTO_SUITE_POOL}
        AND review_session_id = ?
        ORDER BY COALESCE(processing_completed_at, created_at) DESC
        LIMIT 1
      `, [session.id]);
    } else {
      // Flow Mode: return next unlocked item from the pool
      item = await queryOne(db, `
        SELECT * FROM candidates
        WHERE ${PHOTO_SUITE_POOL}
        AND (review_session_id IS NULL
             OR review_session_id NOT IN (
               SELECT rs.id FROM review_sessions rs WHERE rs.status = 'active' AND rs.mode = 'session'
             ))
        ORDER BY COALESCE(processing_completed_at, created_at) DESC
        LIMIT 1
      `);
    }

    if (!item) {
      return res.json({ done: true, session });
    }

    res.json(item);
  } catch (err) {
    console.error("[api/photo-suite/next]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/photo-suite/:id/accept
//
// Transition: review_status null → accepted, stage staged → approved
// Guarded mutation enforces session ownership in SQL.
app.post("/api/photo-suite/:id/accept", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const check = await requireReviewableItem(res, id);
    if (!check) return;
    const { session } = check;

    const timestamp = now();

    // Session-aware guarded UPDATE:
    // - session mode: item must be locked to this session
    // - flow mode: item must not be locked to an active session-mode session
    const sessionGuard = session.mode === "session"
      ? "AND review_session_id = ?"
      : "AND (review_session_id IS NULL OR review_session_id NOT IN (SELECT rs.id FROM review_sessions rs WHERE rs.status = 'active' AND rs.mode = 'session'))";
    const params = session.mode === "session"
      ? [timestamp, timestamp, timestamp, id, session.id]
      : [timestamp, timestamp, timestamp, id];

    const result = await run(db,
      `UPDATE candidates SET
        review_status = 'accepted',
        stage = 'approved',
        reviewed_at = ?,
        approved_at = ?,
        updated_at = ?,
        review_session_id = NULL
       WHERE id = ? AND ${PHOTO_SUITE_POOL} ${sessionGuard}`,
      params
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      return res.status(409).json({ error: "Item state changed during review — refresh and try again" });
    }

    await incrementSessionCounter(session.id, "items_accepted");
    await logEvent(id, "review_accepted", "staged", "approved", {
      session_id: session.id,
    });

    const updated = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[api/photo-suite/:id/accept]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/photo-suite/:id/reject
//
// Transition: review_status null → revision_needed, processing_status ready → null.
// Stage remains staged. Clears generated content so Ghost Logic re-processes.
// Guarded mutation enforces session ownership in SQL.
app.post("/api/photo-suite/:id/reject", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const check = await requireReviewableItem(res, id);
    if (!check) return;
    const { session } = check;

    const timestamp = now();

    const sessionGuard = session.mode === "session"
      ? "AND review_session_id = ?"
      : "AND (review_session_id IS NULL OR review_session_id NOT IN (SELECT rs.id FROM review_sessions rs WHERE rs.status = 'active' AND rs.mode = 'session'))";
    const params = session.mode === "session"
      ? [timestamp, timestamp, id, session.id]
      : [timestamp, timestamp, id];

    const result = await run(db,
      `UPDATE candidates SET
        review_status = 'revision_needed',
        processing_status = NULL,
        processed_image_url = NULL,
        generated_name = NULL,
        generated_description = NULL,
        reviewed_at = ?,
        updated_at = ?,
        review_session_id = NULL
       WHERE id = ? AND ${PHOTO_SUITE_POOL} ${sessionGuard}`,
      params
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      return res.status(409).json({ error: "Item state changed during review — refresh and try again" });
    }

    await incrementSessionCounter(session.id, "items_rejected");
    await logEvent(id, "review_rejected", null, null, {
      session_id: session.id,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[api/photo-suite/:id/reject]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/photo-suite/:id/discard
//
// Transition: review_status null → discarded, stage staged → removed.
// Guarded mutation enforces session ownership in SQL.
app.post("/api/photo-suite/:id/discard", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const check = await requireReviewableItem(res, id);
    if (!check) return;
    const { session } = check;

    const timestamp = now();

    const sessionGuard = session.mode === "session"
      ? "AND review_session_id = ?"
      : "AND (review_session_id IS NULL OR review_session_id NOT IN (SELECT rs.id FROM review_sessions rs WHERE rs.status = 'active' AND rs.mode = 'session'))";
    const params = session.mode === "session"
      ? [timestamp, timestamp, id, session.id]
      : [timestamp, timestamp, id];

    const result = await run(db,
      `UPDATE candidates SET
        review_status = 'discarded',
        stage = 'removed',
        reviewed_at = ?,
        updated_at = ?,
        review_session_id = NULL
       WHERE id = ? AND ${PHOTO_SUITE_POOL} ${sessionGuard}`,
      params
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      return res.status(409).json({ error: "Item state changed during review — refresh and try again" });
    }

    await incrementSessionCounter(session.id, "items_discarded");
    await logEvent(id, "review_discarded", "staged", "removed", {
      session_id: session.id,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[api/photo-suite/:id/discard]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/photo-suite/abandon
//
// Abandon the current active session. For session-mode: unlock all locked items.
// For flow-mode: mark as abandoned.
app.post("/api/photo-suite/abandon", requireDb, async (req, res) => {
  try {
    const session = await getActiveSession();

    if (!session) {
      return res.status(404).json({ error: "No active Photo Suite session to abandon" });
    }

    const timestamp = now();

    if (session.mode === "session") {
      // Unlock all items still locked to this session
      await run(db,
        "UPDATE candidates SET review_session_id = NULL, updated_at = ? WHERE review_session_id = ?",
        [timestamp, session.id]
      );
    }

    // Mark session as abandoned
    await run(db,
      "UPDATE review_sessions SET status = 'abandoned', completed_at = ? WHERE id = ?",
      [timestamp, session.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[api/photo-suite/abandon]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// APPROVED
// ---------------------------------------------------------------------------

// GET /api/approved — all approved items, newest first
app.get("/api/approved", requireDb, async (req, res) => {
  try {
    const items = await queryAll(db, `
      SELECT * FROM candidates
      WHERE stage = 'approved'
      ORDER BY COALESCE(approved_at, created_at) DESC
    `);
    res.json({ items, count: items.length });
  } catch (err) {
    console.error("[api/approved]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/approved/:id — light editing in Approved
//
// Allowed fields: edited_name, edited_description, edited_price,
// detected_category, gender. Guarded: WHERE stage = 'approved'.
app.put("/api/approved/:id", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const { edited_name, edited_description, edited_price, detected_category, gender } = req.body;

    // Validate provided fields
    if (gender !== undefined && !VALID_GENDERS.includes(gender)) {
      return res.status(400).json({ error: `Invalid gender. Expected: ${VALID_GENDERS.join(", ")}` });
    }
    if (detected_category !== undefined && !VALID_CATEGORIES.includes(detected_category)) {
      return res.status(400).json({ error: `Invalid category. Expected: ${VALID_CATEGORIES.join(", ")}` });
    }
    if (edited_price !== undefined && (typeof edited_price !== "number" || isNaN(edited_price))) {
      return res.status(400).json({ error: "edited_price must be a number" });
    }

    // Build dynamic SET clause from provided fields only
    const sets = [];
    const params = [];
    const changedFields = [];

    if (edited_name !== undefined) { sets.push("edited_name = ?"); params.push(edited_name); changedFields.push("edited_name"); }
    if (edited_description !== undefined) { sets.push("edited_description = ?"); params.push(edited_description); changedFields.push("edited_description"); }
    if (edited_price !== undefined) { sets.push("edited_price = ?"); params.push(edited_price); changedFields.push("edited_price"); }
    if (detected_category !== undefined) { sets.push("detected_category = ?"); params.push(detected_category); changedFields.push("detected_category"); }
    if (gender !== undefined) { sets.push("gender = ?"); params.push(gender); changedFields.push("gender"); }

    if (sets.length === 0) {
      return res.status(400).json({ error: "No valid fields provided" });
    }

    const timestamp = now();
    sets.push("updated_at = ?");
    params.push(timestamp);
    params.push(id);

    const result = await run(db,
      `UPDATE candidates SET ${sets.join(", ")} WHERE id = ? AND stage = 'approved'`,
      params
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      const diag = await diagnoseMutationFailure(id, "approved");
      return res.status(diag.status).json(diag.body);
    }

    await logEvent(id, "edited", null, null, { fields_changed: changedFields });

    const updated = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[api/approved/:id]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/approved/:id/to-launch — transition: approved → launch_ready
app.post("/api/approved/:id/to-launch", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const timestamp = now();

    const result = await run(db,
      "UPDATE candidates SET stage = 'launch_ready', updated_at = ? WHERE id = ? AND stage = 'approved'",
      [timestamp, id]
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      const diag = await diagnoseMutationFailure(id, "approved");
      return res.status(diag.status).json(diag.body);
    }

    await logEvent(id, "moved_to_launch", "approved", "launch_ready", null);

    const updated = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[api/approved/:id/to-launch]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/approved/:id/remove — transition: approved → removed
app.post("/api/approved/:id/remove", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const timestamp = now();

    const result = await run(db,
      "UPDATE candidates SET stage = 'removed', updated_at = ? WHERE id = ? AND stage = 'approved'",
      [timestamp, id]
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      const diag = await diagnoseMutationFailure(id, "approved");
      return res.status(diag.status).json(diag.body);
    }

    await logEvent(id, "removed", "approved", "removed", null);

    res.json({ ok: true });
  } catch (err) {
    console.error("[api/approved/:id/remove]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// LAUNCH
// ---------------------------------------------------------------------------

// GET /api/launch — all launch-ready items
app.get("/api/launch", requireDb, async (req, res) => {
  try {
    const items = await queryAll(db, `
      SELECT * FROM candidates
      WHERE stage = 'launch_ready'
      ORDER BY COALESCE(updated_at, created_at) DESC
    `);
    res.json({ items, count: items.length });
  } catch (err) {
    console.error("[api/launch]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/launch/:id/return — transition: launch_ready → approved
app.post("/api/launch/:id/return", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const timestamp = now();

    const result = await run(db,
      "UPDATE candidates SET stage = 'approved', updated_at = ? WHERE id = ? AND stage = 'launch_ready'",
      [timestamp, id]
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      const diag = await diagnoseMutationFailure(id, "launch_ready");
      return res.status(diag.status).json(diag.body);
    }

    await logEvent(id, "returned_to_approved", "launch_ready", "approved", null);

    const updated = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[api/launch/:id/return]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/launch/:id/publish — transition: launch_ready → published
//
// Performs the canonical DB transition. Shopify publisher integration is
// available in publisher.js but uses legacy fields — wiring deferred.
// TODO: Wire publishCandidate() from publisher.js once it uses canonical
//       stage field instead of legacy status. When wired, set
//       shopify_product_id and shopify_url from the publisher response.
app.post("/api/launch/:id/publish", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const timestamp = now();

    const result = await run(db,
      `UPDATE candidates SET
        stage = 'published',
        published_at = ?,
        updated_at = ?
       WHERE id = ? AND stage = 'launch_ready'`,
      [timestamp, timestamp, id]
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      const diag = await diagnoseMutationFailure(id, "launch_ready");
      return res.status(diag.status).json(diag.body);
    }

    await logEvent(id, "published", "launch_ready", "published", null);

    const updated = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[api/launch/:id/publish]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// LIVE
// ---------------------------------------------------------------------------

// GET /api/live — all published items
app.get("/api/live", requireDb, async (req, res) => {
  try {
    const items = await queryAll(db, `
      SELECT * FROM candidates
      WHERE stage = 'published'
      ORDER BY COALESCE(published_at, updated_at) DESC
    `);
    res.json({ items, count: items.length });
  } catch (err) {
    console.error("[api/live]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/live/:id/unpublish — transition: published → approved
//
// Moves the item back to Approved. Preserves shopify_product_id and
// shopify_url so they can be referenced if the item is re-published.
// TODO: Wire Shopify product deactivation when publisher is canonical.
app.post("/api/live/:id/unpublish", requireDb, async (req, res) => {
  try {
    const id = parseId(req, res);
    if (id === null) return;

    const timestamp = now();

    const result = await run(db,
      "UPDATE candidates SET stage = 'approved', updated_at = ? WHERE id = ? AND stage = 'published'",
      [timestamp, id]
    );

    const affected = result?.rowsAffected ?? result?.changes ?? 0;
    if (affected === 0) {
      const diag = await diagnoseMutationFailure(id, "published");
      return res.status(diag.status).json(diag.body);
    }

    await logEvent(id, "unpublished", "published", "approved", null);

    const updated = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [id]);
    res.json(updated);
  } catch (err) {
    console.error("[api/live/:id/unpublish]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// SPA fallback (must be AFTER all /api routes)
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(__dirname, "client", "dist", "index.html"));
});

// ---------------------------------------------------------------------------
// Start server immediately, connect DB with retry in background
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[startup] Server listening on port ${PORT}`);
  console.log(`[startup] TURSO_DATABASE_URL set: ${!!process.env.TURSO_DATABASE_URL}`);
});

async function connectDb(attempt = 1) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 3000;

  try {
    console.log(`[startup] DB connection attempt ${attempt}/${MAX_RETRIES}`);
    db = getDb();

    const ping = await db.execute("SELECT 1 as test");
    console.log(`[startup] DB connected: ${JSON.stringify(ping.rows[0])}`);

    const total = await db.execute("SELECT COUNT(*) as c FROM candidates");
    console.log(`[startup] Candidates: ${total.rows[0]?.c || 0}`);

    try {
      const stages = await db.execute(
        "SELECT stage, COUNT(*) as c FROM candidates WHERE stage IS NOT NULL GROUP BY stage ORDER BY COUNT(*) DESC"
      );
      console.log(`[startup] Stages: ${JSON.stringify(stages.rows)}`);
    } catch (_) {
      console.log("[startup] WARNING: 'stage' column not found. Run migrate-canonical.js first.");
    }

    dbReady = true;
    dbError = null;
    console.log("[startup] DB ready");
  } catch (err) {
    console.error(`[startup] DB attempt ${attempt} failed: ${err.message}`);

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * attempt;
      console.log(`[startup] Retrying in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
      return connectDb(attempt + 1);
    }

    dbError = err.message;
    console.error(`[startup] All ${MAX_RETRIES} attempts failed. DB not available.`);
  }
}

connectDb();
