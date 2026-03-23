// server.js — Express API server for IMMIGRANT curation tool
// Usage: node server.js

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { getDb, initSchema, queryAll, queryOne, run } = require("./db");
const { readImageForApi } = require("./lib/image-utils");

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

app.use(cors());
app.use(express.json());
app.use("/images", express.static(path.join(__dirname, "images")));
app.use(express.static(path.join(__dirname, "client", "dist")));

let db;

const DESC_PROMPT = `Write a product description for IMMIGRANT, a minimal luxury streetwear brand.
Rules:
- 1 to 3 sentences maximum
- Describe only what the garment physically is
- Focus on: fabric weight, fit, construction details, how it falls or moves
- No marketing language
- No adjectives that mean nothing (luxury, premium, high quality, perfect)
- No exclamation marks
- Present tense, declarative
- Sounds like Celine, Acne Studios, or A.P.C. product copy
Examples:
'Heavyweight cotton. Dropped shoulders. Washed once.'
'Unstructured. Falls below the knee. Worn open.'
'Raw denim. Mid rise. Slightly tapered from the knee.'
Return only the description, nothing else.`;

// ---------------------------------------------------------------------------
// SWIPE
// ---------------------------------------------------------------------------

const IS_CLOUD = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.TURSO_DATABASE_URL;

app.get("/api/swipe/batch", async (req, res) => {
  try {
    const gf = req.query.gender;
    const gc = gf ? `AND c.gender = '${gf}'` : "";
    // Require either image_path or image_url
    const candidates = await queryAll(db, `
      SELECT c.* FROM candidates c WHERE c.status = 'new'
      AND (c.image_path IS NOT NULL OR c.image_url IS NOT NULL)
      AND c.id NOT IN (SELECT candidate_id FROM swipe_decisions) ${gc}
      ORDER BY c.created_at DESC LIMIT 100
    `);
    // On local: filter out missing/tiny files. On cloud: skip file check (images served from URLs).
    const filtered = IS_CLOUD ? candidates : candidates.filter((c) => {
      if (!c.image_path) return !!c.image_url;
      try { return fs.statSync(path.join(__dirname, c.image_path)).size >= 5000; } catch (_) { return !!c.image_url; }
    });
    const count = await queryOne(db, `SELECT COUNT(*) as c FROM candidates WHERE status = 'new' AND (image_path IS NOT NULL OR image_url IS NOT NULL) AND id NOT IN (SELECT candidate_id FROM swipe_decisions) ${gc}`);
    res.json({ candidates: filtered, total_remaining: count?.c || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/swipe/decide", async (req, res) => {
  try {
    const { candidate_id, decision } = req.body;
    if (!candidate_id || !["approve", "reject"].includes(decision)) return res.status(400).json({ error: "invalid" });
    await run(db, "INSERT INTO swipe_decisions (candidate_id, decision) VALUES (?, ?)", [candidate_id, decision]);
    await run(db, "UPDATE candidates SET status = ? WHERE id = ?", [decision === "approve" ? "approved" : "rejected", candidate_id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/swipe/undo", async (req, res) => {
  try {
    const last = await queryOne(db, "SELECT id, candidate_id FROM swipe_decisions ORDER BY id DESC LIMIT 1");
    if (!last) return res.status(400).json({ error: "Nothing to undo" });
    await run(db, "DELETE FROM swipe_decisions WHERE id = ?", [last.id]);
    await run(db, "UPDATE candidates SET status = 'new' WHERE id = ?", [last.candidate_id]);
    const restored = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [last.candidate_id]);
    res.json({ ok: true, restored });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// PICKS
// ---------------------------------------------------------------------------

app.get("/api/picks", async (req, res) => {
  try {
    const picks = await queryAll(db, "SELECT * FROM candidates WHERE status IN ('approved', 'editing', 'skipped') ORDER BY status ASC, created_at DESC");
    res.json({ picks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/picks/:id", async (req, res) => {
  try {
    await run(db, "UPDATE candidates SET status = 'removed' WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// EDIT SUITE
// ---------------------------------------------------------------------------

app.get("/api/edit/queue", async (req, res) => {
  try {
    const items = await queryAll(db, "SELECT * FROM candidates WHERE status IN ('approved', 'editing') ORDER BY created_at DESC");
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/edit/skipped", async (req, res) => {
  try {
    const items = await queryAll(db, "SELECT * FROM candidates WHERE status = 'skipped' ORDER BY created_at DESC");
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/edit/:id", async (req, res) => {
  try {
    const item = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [req.params.id]);
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/edit/:id/save", async (req, res) => {
  try {
    const { edited_name, edited_description, edited_price, gender, detected_category, edited_colors, edited_sizes } = req.body;
    const sets = [];
    const params = [];
    if (edited_name !== undefined) { sets.push("edited_name = ?"); params.push(edited_name); }
    if (edited_description !== undefined) { sets.push("edited_description = ?"); params.push(edited_description); }
    if (edited_price !== undefined) { sets.push("edited_price = ?"); params.push(edited_price); }
    if (gender !== undefined) { sets.push("gender = ?"); params.push(gender); }
    if (detected_category !== undefined) { sets.push("detected_category = ?"); params.push(detected_category); }
    if (edited_colors !== undefined) { sets.push("edited_colors = ?"); params.push(JSON.stringify(edited_colors)); }
    if (edited_sizes !== undefined) { sets.push("edited_sizes = ?"); params.push(JSON.stringify(edited_sizes)); }
    sets.push("status = 'editing'");
    params.push(req.params.id);
    await run(db, `UPDATE candidates SET ${sets.join(", ")} WHERE id = ?`, params);
    const updated = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [req.params.id]);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/edit/:id/skip", async (req, res) => {
  try {
    await run(db, "UPDATE candidates SET status = 'skipped' WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/edit/:id/unskip", async (req, res) => {
  try {
    await run(db, "UPDATE candidates SET status = 'editing' WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Generate name via Claude vision
app.post("/api/edit/:id/generate-name", async (req, res) => {
  try {
    const { nameCandidate } = require("./namer");
    const result = await nameCandidate(parseInt(req.params.id), db);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Generate description via Claude
app.post("/api/edit/:id/generate-description", async (req, res) => {
  try {
    const item = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [req.params.id]);
    if (!item) return res.status(404).json({ error: "Not found" });

    const name = item.edited_name || item.immigrant_name || item.title;
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL, max_tokens: 256,
      messages: [{ role: "user", content: `Product: ${name}\n\n${DESC_PROMPT}` }],
    });
    const description = response.content[0].text.trim();
    await run(db, "UPDATE candidates SET edited_description = ? WHERE id = ?", [description, req.params.id]);
    res.json({ description });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove background via remove.bg
app.post("/api/edit/:id/remove-bg", async (req, res) => {
  try {
    const item = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [req.params.id]);
    if (!item?.image_path) return res.status(400).json({ error: "No image" });

    const apiKey = process.env.REMOVEBG_API_KEY;
    if (!apiKey) return res.status(400).json({ error: "REMOVEBG_API_KEY not set" });

    const fullPath = path.resolve(__dirname, item.image_path);
    const imageData = fs.readFileSync(fullPath);

    // Backup original
    if (!item.original_image_path) {
      const backupPath = item.image_path.replace(/(\.\w+)$/, "_original$1");
      fs.copyFileSync(fullPath, path.resolve(__dirname, backupPath));
      await run(db, "UPDATE candidates SET original_image_path = ? WHERE id = ?", [backupPath, req.params.id]);
    }

    const formData = new FormData();
    formData.append("image_file", new Blob([imageData]), path.basename(fullPath));
    formData.append("size", "auto");
    formData.append("bg_color", "F5F2ED");

    const bgRes = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST", headers: { "X-Api-Key": apiKey }, body: formData,
    });
    if (!bgRes.ok) return res.status(500).json({ error: `remove.bg: ${bgRes.status}` });

    const processed = Buffer.from(await bgRes.arrayBuffer());
    fs.writeFileSync(fullPath, processed);
    res.json({ ok: true, path: item.image_path });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Enhance image
app.post("/api/edit/:id/enhance", async (req, res) => {
  try {
    const item = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [req.params.id]);
    if (!item?.image_path) return res.status(400).json({ error: "No image" });

    const fullPath = path.resolve(__dirname, item.image_path);

    // Backup original if not already backed up
    if (!item.original_image_path) {
      const backupPath = item.image_path.replace(/(\.\w+)$/, "_original$1");
      fs.copyFileSync(fullPath, path.resolve(__dirname, backupPath));
      await run(db, "UPDATE candidates SET original_image_path = ? WHERE id = ?", [backupPath, req.params.id]);
    }

    // Try sharp, fallback gracefully
    let sharp;
    try { sharp = require("sharp"); } catch (_) {
      return res.status(500).json({ error: "sharp not available on this platform" });
    }

    let img = sharp(fullPath);
    const meta = await img.metadata();

    // Step 2: Warm tone correction + Step 3: Gentle contrast + Step 5: Desaturate
    img = sharp(fullPath)
      .modulate({ brightness: 1.02, saturation: 0.87 }) // slight brighten + desaturate 13%
      .linear(1.08, -10)  // gentle S-curve approximation: contrast boost + shadow lift
      .sharpen({ sigma: 1.2, m1: 0.8, m2: 0.4 }) // Step 4: subtle sharpening
      .tint({ r: 250, g: 245, b: 235 }); // warm shift

    // Step 6: Resize to 800x1000 with brand background padding
    const enhanced = await img
      .resize(800, 1000, { fit: "contain", background: { r: 245, g: 242, b: 237, alpha: 1 } })
      .flatten({ background: { r: 245, g: 242, b: 237 } })
      .jpeg({ quality: 92 })
      .toBuffer();

    // Save enhanced version
    const enhancedPath = item.image_path.replace(/(\.\w+)$/, "_enhanced.jpg");
    const enhancedFull = path.resolve(__dirname, enhancedPath);
    fs.writeFileSync(enhancedFull, enhanced);

    res.json({ ok: true, enhanced_path: enhancedPath, original_path: item.original_image_path || item.image_path });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Apply enhanced image (replace main with enhanced)
app.post("/api/edit/:id/apply-enhanced", async (req, res) => {
  try {
    const { enhanced_path } = req.body;
    await run(db, "UPDATE candidates SET image_path = ? WHERE id = ?", [enhanced_path, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Revert to original image
app.post("/api/edit/:id/revert-image", async (req, res) => {
  try {
    const item = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [req.params.id]);
    if (item?.original_image_path) {
      await run(db, "UPDATE candidates SET image_path = ?, original_image_path = NULL WHERE id = ?", [item.original_image_path, req.params.id]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Publish single product to Shopify
app.post("/api/edit/:id/publish", async (req, res) => {
  try {
    const { publishCandidate } = require("./publisher");
    const result = await publishCandidate(parseInt(req.params.id), db);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Unpublish from Shopify
app.post("/api/edit/:id/unpublish", async (req, res) => {
  try {
    const item = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [req.params.id]);
    if (!item?.shopify_product_id) return res.status(400).json({ error: "Not published" });

    const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL;
    const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
    if (SHOPIFY_STORE && SHOPIFY_TOKEN) {
      await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/products/${item.shopify_product_id}.json`, {
        method: "PUT",
        headers: { "X-Shopify-Access-Token": SHOPIFY_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ product: { id: item.shopify_product_id, status: "draft" } }),
      });
    }
    await run(db, "UPDATE candidates SET status = 'editing', shopify_product_id = NULL, shopify_url = NULL WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// LIVE
// ---------------------------------------------------------------------------

app.get("/api/live", async (req, res) => {
  try {
    const items = await queryAll(db, "SELECT * FROM candidates WHERE status = 'published' ORDER BY created_at DESC");
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// GENDER + CATEGORY
// ---------------------------------------------------------------------------

app.patch("/api/candidates/:id/gender", async (req, res) => {
  try {
    const { gender } = req.body;
    if (!["mens", "womens", "unisex"].includes(gender)) return res.status(400).json({ error: "invalid" });
    await run(db, "UPDATE candidates SET gender = ? WHERE id = ?", [gender, req.params.id]);
    res.json({ ok: true, gender });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/candidates/:id/category", async (req, res) => {
  try {
    const { category } = req.body;
    const valid = ["tops", "bottoms", "outerwear", "footwear", "jewelry", "belts", "accessories"];
    if (!valid.includes(category)) return res.status(400).json({ error: "invalid" });
    await run(db, "UPDATE candidates SET detected_category = ? WHERE id = ?", [category, req.params.id]);
    res.json({ ok: true, category });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// STATS
// ---------------------------------------------------------------------------

app.get("/api/stats", async (req, res) => {
  try {
    const total = await queryOne(db, "SELECT COUNT(*) as c FROM candidates");
    const unswiped = await queryOne(db, "SELECT COUNT(*) as c FROM candidates WHERE status = 'new' AND id NOT IN (SELECT candidate_id FROM swipe_decisions)");
    const approved = await queryOne(db, "SELECT COUNT(*) as c FROM candidates WHERE status IN ('approved', 'editing')");
    const skipped = await queryOne(db, "SELECT COUNT(*) as c FROM candidates WHERE status = 'skipped'");
    const published = await queryOne(db, "SELECT COUNT(*) as c FROM candidates WHERE status = 'published'");
    res.json({
      total: total?.c || 0, unswiped: unswiped?.c || 0,
      approved: approved?.c || 0, skipped: skipped?.c || 0, published: published?.c || 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// SPA fallback
// ---------------------------------------------------------------------------

app.get("/{*path}", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "dist", "index.html"));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async () => {
  db = getDb();
  await initSchema(db);
  const s = await queryOne(db, "SELECT COUNT(*) as c FROM candidates");
  app.listen(PORT, () => {
    console.log(`\n=== IMMIGRANT Curation Tool ===`);
    console.log(`http://localhost:${PORT}\n`);
    console.log(`${s?.c || 0} candidates in database\n`);
  });
})();
