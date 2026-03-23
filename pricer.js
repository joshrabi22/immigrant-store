// pricer.js — Category-aware pricing engine with Claude luxury scoring
// Usage: node pricer.js <candidate_id>
// Also importable: const { priceCandidate } = require('./pricer')

require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const { getDb, initSchema } = require("./db");
const { readImageForApi } = require("./lib/image-utils");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

// Category pricing bands (retail price ceilings)
const PRICING_BANDS = {
  "t-shirt":    { min: 28, max: 48 },
  "hoodie":     { min: 48, max: 88 },
  "jacket":     { min: 95, max: 138 },
  "outerwear":  { min: 95, max: 138 },
  "puffer jacket": { min: 95, max: 138 },
  "pants":      { min: 55, max: 78 },
  "jeans":      { min: 65, max: 95 },
  "trouser":    { min: 55, max: 78 },
  "dress":      { min: 55, max: 98 },
  "skirt":      { min: 38, max: 68 },
  "sneakers":   { min: 68, max: 108 },
  "bag":        { min: 28, max: 68 },
  "accessory":  { min: 18, max: 35 },
  "default":    { min: 28, max: 68 },
};

const LUXURY_PROMPT = `Score this product image for perceived luxury on a scale of 1-10.
Consider: material quality, construction details, design sophistication, brand positioning potential.
1 = fast fashion / disposable, 10 = high-end designer quality.

Return ONLY a JSON object:
{"luxury_score": 7, "reasoning": "one sentence explanation"}`;

// Round to nearest number ending in 8 or 0
function roundTo80(n) {
  const r8 = Math.round(n / 8) * 8;
  const r10 = Math.round(n / 10) * 10;
  return Math.abs(n - r8) <= Math.abs(n - r10) ? r8 : r10;
}

function getBand(garmentType) {
  const gt = (garmentType || "").toLowerCase();
  return PRICING_BANDS[gt] || PRICING_BANDS.default;
}

async function priceCandidate(candidateId, db) {
  const ownDb = !db;
  if (!db) {
    db = getDb();
    initSchema(db);
  }

  const candidate = db.prepare("SELECT * FROM candidates WHERE id = ?").get(candidateId);
  if (!candidate) throw new Error(`Candidate ${candidateId} not found`);

  // Get garment type from score breakdown
  let garmentType = "default";
  if (candidate.score_breakdown) {
    try {
      const bd = JSON.parse(candidate.score_breakdown);
      garmentType = bd.aesthetic?.value || "default"; // fallback
      // Actually get garment type from the analysis — it's stored in score_breakdown too
      // We need the silhouette/material data, but garment type isn't directly there
      // Use namer_data if available
    } catch (_) {}
  }
  if (candidate.namer_data) {
    try {
      const nd = JSON.parse(candidate.namer_data);
      if (nd.suggested_tags) {
        // Try to match a tag to a pricing band
        for (const tag of nd.suggested_tags) {
          if (PRICING_BANDS[tag.toLowerCase()]) {
            garmentType = tag.toLowerCase();
            break;
          }
        }
      }
    } catch (_) {}
  }

  const cost = candidate.price || 0;
  const shipping = candidate.shipping_cost || 0;
  const floor = 2.5 * (cost + shipping);
  const band = getBand(garmentType);

  // Get luxury score from Claude vision
  let luxuryScore = 5;
  let luxuryReasoning = "default score";

  if (candidate.image_path) {
    const img = readImageForApi(candidate.image_path);
    if (img) {
      try {
        const client = new Anthropic();
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 256,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } },
                { type: "text", text: LUXURY_PROMPT },
              ],
            },
          ],
        });

        const text = response.content[0].text.trim();
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          luxuryScore = parsed.luxury_score || 5;
          luxuryReasoning = parsed.reasoning || "";
        }
      } catch (err) {
        luxuryReasoning = `Vision error: ${err.message}`;
      }
    }
  }

  // Calculate price: interpolate within band based on luxury score
  // luxury 1 = band.min, luxury 10 = band.max
  const luxuryFactor = (luxuryScore - 1) / 9;
  let rawPrice = band.min + luxuryFactor * (band.max - band.min);

  // Enforce floor (2.5x cost + shipping, bake in free shipping)
  rawPrice = Math.max(rawPrice, floor);

  // Enforce band ceiling
  rawPrice = Math.min(rawPrice, band.max);

  // Round to nearest 8 or 0
  const retailPrice = roundTo80(rawPrice);

  const reasoning = {
    cost,
    shipping,
    floor: Math.round(floor * 100) / 100,
    garment_type: garmentType,
    band,
    luxury_score: luxuryScore,
    luxury_reasoning: luxuryReasoning,
    raw_price: Math.round(rawPrice * 100) / 100,
    final_price: retailPrice,
  };

  db.prepare("UPDATE candidates SET retail_price = ?, price_reasoning = ? WHERE id = ?").run(
    retailPrice,
    JSON.stringify(reasoning),
    candidateId
  );

  if (ownDb) db.close();
  return reasoning;
}

if (require.main === module) {
  const id = parseInt(process.argv[2]);
  if (!id) {
    console.error("Usage: node pricer.js <candidate_id>");
    process.exit(1);
  }
  priceCandidate(id)
    .then((r) => {
      console.log(`Price: $${r.final_price}`);
      console.log(`Cost: $${r.cost} + $${r.shipping} shipping`);
      console.log(`Floor (2.5x): $${r.floor}`);
      console.log(`Band: ${r.garment_type} ($${r.band.min}-$${r.band.max})`);
      console.log(`Luxury: ${r.luxury_score}/10 — ${r.luxury_reasoning}`);
    })
    .catch((e) => {
      console.error("Error:", e.message);
      process.exit(1);
    });
}

module.exports = { priceCandidate, PRICING_BANDS, roundTo80 };
