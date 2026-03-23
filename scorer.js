// scorer.js — Score candidates against taste_profile.json using Claude vision
// Usage: node scorer.js
//
// Scores all candidates with status='new'. Sets status='ready' (7+) or 'rejected'.

require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const { getDb, initSchema } = require("./db");
const { getProfile, ANALYSIS_PROMPT } = require("./lib/taste");
const { readImageForApi } = require("./lib/image-utils");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

// ---------------------------------------------------------------------------
// Color distance (simple RGB euclidean, good enough for v1)
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function colorDistance(hex1, hex2) {
  try {
    const [r1, g1, b1] = hexToRgb(hex1);
    const [r2, g2, b2] = hexToRgb(hex2);
    return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
  } catch {
    return 999;
  }
}

// Max possible RGB distance is ~441 (black to white)
const COLOR_MATCH_THRESHOLD = 80;

// ---------------------------------------------------------------------------
// Scoring dimensions
// ---------------------------------------------------------------------------

function scoreAesthetic(candidateAesthetic, profile) {
  const dominant = profile.dominant_aesthetic;
  const breakdown = Object.fromEntries(profile.aesthetic_breakdown.map((a) => [a.name, a.count]));
  const ca = (candidateAesthetic || "").toLowerCase();

  if (ca === dominant) return 10;
  if (breakdown[ca]) {
    // Score based on rank in profile
    const rank = profile.aesthetic_breakdown.findIndex((a) => a.name === ca);
    return Math.max(3, 9 - rank * 2);
  }
  return 3;
}

function scoreColors(candidateColors, profile) {
  if (!candidateColors || candidateColors.length === 0) return 5;
  const profileColors = profile.top_colors.slice(0, 10).map((c) => c.name);
  let matches = 0;

  for (const cc of candidateColors) {
    for (const pc of profileColors) {
      if (colorDistance(cc, pc) < COLOR_MATCH_THRESHOLD) {
        matches++;
        break;
      }
    }
  }

  const ratio = matches / candidateColors.length;
  return Math.round(ratio * 10);
}

function scoreSilhouette(candidateSilhouette, profile) {
  const cs = (candidateSilhouette || "").toLowerCase();
  const idx = profile.top_silhouettes.findIndex((s) => s.name === cs);
  if (idx === -1) return 3;
  if (idx === 0) return 10;
  if (idx <= 2) return 8;
  if (idx <= 4) return 6;
  return 4;
}

function scoreMaterial(candidateMaterial, profile) {
  const cm = (candidateMaterial || "").toLowerCase();
  const idx = profile.top_materials.findIndex((m) => m.name === cm);
  if (idx === -1) return 3;
  if (idx === 0) return 10;
  if (idx <= 2) return 8;
  if (idx <= 4) return 6;
  return 4;
}

function scoreStyleTags(candidateTags, profile) {
  if (!candidateTags || candidateTags.length === 0) return 5;
  const profileTags = new Set(profile.top_style_tags.slice(0, 10).map((t) => t.name));
  let matches = 0;

  for (const tag of candidateTags) {
    if (profileTags.has(tag.toLowerCase())) matches++;
  }

  const ratio = matches / candidateTags.length;
  return Math.round(ratio * 10);
}

// Weighted final score
function computeScore(analysis, profile) {
  const aestheticScore = scoreAesthetic(analysis.aesthetic, profile);
  const colorScore = scoreColors(analysis.dominant_colors, profile);
  const silhouetteScore = scoreSilhouette(analysis.silhouette, profile);
  const materialScore = scoreMaterial(analysis.material, profile);
  const styleTagScore = scoreStyleTags(analysis.style_tags, profile);

  const weighted =
    aestheticScore * 0.3 +
    colorScore * 0.2 +
    silhouetteScore * 0.2 +
    materialScore * 0.15 +
    styleTagScore * 0.15;

  const finalScore = Math.round(weighted * 10) / 10;

  return {
    score: finalScore,
    breakdown: {
      aesthetic: { score: aestheticScore, value: analysis.aesthetic, weight: 0.3 },
      color: { score: colorScore, colors: analysis.dominant_colors, weight: 0.2 },
      silhouette: { score: silhouetteScore, value: analysis.silhouette, weight: 0.2 },
      material: { score: materialScore, value: analysis.material, weight: 0.15 },
      style_tags: { score: styleTagScore, tags: analysis.style_tags, weight: 0.15 },
    },
  };
}

// ---------------------------------------------------------------------------
// Analyze a candidate image with Claude vision
// ---------------------------------------------------------------------------

async function analyzeCandidate(client, imagePath) {
  const img = readImageForApi(imagePath);
  if (!img) return null;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } },
          { type: "text", text: ANALYSIS_PROMPT },
        ],
      },
    ],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  return JSON.parse(jsonMatch[0]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== IMMIGRANT Store — Scoring Engine ===\n");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY not set in .env");
    process.exit(1);
  }

  const client = new Anthropic();
  const profile = getProfile();
  const db = getDb();
  initSchema(db);

  // Get unscored candidates
  const candidates = db
    .prepare("SELECT id, title, image_path FROM candidates WHERE status = 'new' AND image_path IS NOT NULL")
    .all();

  if (candidates.length === 0) {
    console.log("No unscored candidates found. Run cj.js, scraper.js suggested, or seed-orders.js first.");
    db.close();
    return;
  }

  console.log(`Found ${candidates.length} candidates to score.\n`);
  console.log(`Taste profile: ${profile.dominant_aesthetic} dominant, ${profile.clothing_items_used} items analyzed.\n`);

  const updateStmt = db.prepare(`
    UPDATE candidates SET score = ?, score_breakdown = ?, status = ? WHERE id = ?
  `);

  let ready = 0;
  let rejected = 0;
  let errors = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const shortTitle = c.title.substring(0, 55);
    console.log(`[${i + 1}/${candidates.length}] ${shortTitle}...`);

    try {
      const analysis = await analyzeCandidate(client, c.image_path);
      if (!analysis) {
        console.log("  -> Could not analyze image, skipping");
        errors++;
        continue;
      }

      const result = computeScore(analysis, profile);
      const status = result.score >= 7 ? "ready" : "rejected";

      updateStmt.run(result.score, JSON.stringify(result.breakdown), status, c.id);

      if (status === "ready") ready++;
      else rejected++;

      const b = result.breakdown;
      console.log(
        `  -> ${result.score}/10 [${status}] ` +
        `aes:${b.aesthetic.score} col:${b.color.score} sil:${b.silhouette.score} ` +
        `mat:${b.material.score} tag:${b.style_tags.score} ` +
        `| ${analysis.aesthetic} / ${analysis.garment_type}`
      );
    } catch (err) {
      console.log(`  -> Error: ${err.message}`);
      errors++;
    }

    // Rate limit
    if (i < candidates.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`\n=== Scoring complete ===`);
  console.log(`Ready (7+): ${ready}`);
  console.log(`Rejected:   ${rejected}`);
  console.log(`Errors:     ${errors}`);
  console.log(`\nSwipe queue: ${db.prepare("SELECT COUNT(*) as c FROM candidates WHERE status = 'ready'").get().c} candidates`);

  db.close();
}

// Dual-mode: standalone CLI + importable
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

module.exports = { computeScore, analyzeCandidate, scoreAesthetic, scoreColors };
