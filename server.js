// server.js — Express API server for IMMIGRANT curation tool
// Usage: node server.js

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { getDb, initSchema, queryAll, queryOne, run } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use("/images", express.static(path.join(__dirname, "images")));
app.use(express.static(path.join(__dirname, "client", "dist")));

let db;

// ---------------------------------------------------------------------------
// SWIPE
// ---------------------------------------------------------------------------

app.get("/api/swipe/batch", async (req, res) => {
  try {
    const genderFilter = req.query.gender;
    const genderClause = genderFilter ? `AND c.gender = '${genderFilter}'` : "";

    const candidates = await queryAll(db, `
      SELECT c.* FROM candidates c
      WHERE c.status = 'new'
      AND c.image_path IS NOT NULL
      AND c.id NOT IN (SELECT candidate_id FROM swipe_decisions)
      ${genderClause}
      ORDER BY c.created_at DESC
      LIMIT 100
    `);

    // Filter out missing/tiny images server-side
    const filtered = candidates.filter((c) => {
      if (!c.image_path) return false;
      try {
        const stat = fs.statSync(path.join(__dirname, c.image_path));
        return stat.size >= 5000;
      } catch (_) { return false; }
    });

    const countResult = await queryOne(db, `
      SELECT COUNT(*) as c FROM candidates
      WHERE status = 'new' AND image_path IS NOT NULL
      AND id NOT IN (SELECT candidate_id FROM swipe_decisions)
      ${genderClause}
    `);

    res.json({ candidates: filtered, total_remaining: countResult?.c || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/swipe/decide", async (req, res) => {
  try {
    const { candidate_id, decision } = req.body;
    if (!candidate_id || !["approve", "reject"].includes(decision)) {
      return res.status(400).json({ error: "candidate_id and decision required" });
    }

    await run(db, "INSERT INTO swipe_decisions (candidate_id, decision) VALUES (?, ?)", [candidate_id, decision]);
    const newStatus = decision === "approve" ? "approved" : "rejected";
    await run(db, "UPDATE candidates SET status = ? WHERE id = ?", [newStatus, candidate_id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/swipe/undo", async (req, res) => {
  try {
    const last = await queryOne(db, "SELECT id, candidate_id FROM swipe_decisions ORDER BY id DESC LIMIT 1");
    if (!last) return res.status(400).json({ error: "Nothing to undo" });

    await run(db, "DELETE FROM swipe_decisions WHERE id = ?", [last.id]);
    await run(db, "UPDATE candidates SET status = 'new' WHERE id = ?", [last.candidate_id]);

    const restored = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [last.candidate_id]);
    res.json({ ok: true, restored });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// PICKS
// ---------------------------------------------------------------------------

app.get("/api/picks", async (req, res) => {
  try {
    const picks = await queryAll(db, "SELECT * FROM candidates WHERE status = 'approved' ORDER BY created_at DESC");
    res.json({ picks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/picks/:id", async (req, res) => {
  try {
    await run(db, "UPDATE candidates SET status = 'removed' WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GENDER + CATEGORY
// ---------------------------------------------------------------------------

app.patch("/api/candidates/:id/gender", async (req, res) => {
  try {
    const { gender } = req.body;
    if (!["mens", "womens", "unisex"].includes(gender)) {
      return res.status(400).json({ error: "gender must be mens, womens, or unisex" });
    }
    await run(db, "UPDATE candidates SET gender = ? WHERE id = ?", [gender, req.params.id]);
    res.json({ ok: true, gender });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/candidates/:id/category", async (req, res) => {
  try {
    const { category } = req.body;
    const valid = ["tops", "bottoms", "outerwear", "footwear", "jewelry", "belts", "accessories"];
    if (!valid.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${valid.join(", ")}` });
    }
    await run(db, "UPDATE candidates SET detected_category = ? WHERE id = ?", [category, req.params.id]);
    res.json({ ok: true, category });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// STATS
// ---------------------------------------------------------------------------

app.get("/api/stats", async (req, res) => {
  try {
    const total = await queryOne(db, "SELECT COUNT(*) as c FROM candidates");
    const unswiped = await queryOne(db, "SELECT COUNT(*) as c FROM candidates WHERE status = 'new' AND id NOT IN (SELECT candidate_id FROM swipe_decisions)");
    const approved = await queryOne(db, "SELECT COUNT(*) as c FROM candidates WHERE status = 'approved'");
    const rejected = await queryOne(db, "SELECT COUNT(*) as c FROM candidates WHERE status = 'rejected'");
    res.json({
      total: total?.c || 0,
      unswiped: unswiped?.c || 0,
      approved: approved?.c || 0,
      rejected: rejected?.c || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

  const stats = await queryOne(db, "SELECT COUNT(*) as c FROM candidates");
  const unswiped = await queryOne(db, "SELECT COUNT(*) as c FROM candidates WHERE status = 'new'");
  const approved = await queryOne(db, "SELECT COUNT(*) as c FROM candidates WHERE status = 'approved'");

  app.listen(PORT, () => {
    console.log(`\n=== IMMIGRANT Curation Tool ===`);
    console.log(`http://localhost:${PORT}\n`);
    console.log(`${stats?.c || 0} candidates | ${unswiped?.c || 0} to swipe | ${approved?.c || 0} approved\n`);
  });
})();
