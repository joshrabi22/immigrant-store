// lib/taste.js — Shared taste profile loader
// Used by scorer.js, namer.js, pricer.js, cj.js

const fs = require("fs");
const path = require("path");

const PROFILE_PATH = path.join(__dirname, "..", "taste_profile.json");

let _cached = null;

function loadTasteProfile() {
  if (_cached) return _cached;
  if (!fs.existsSync(PROFILE_PATH)) {
    throw new Error("taste_profile.json not found. Run taste-builder.js first.");
  }
  _cached = JSON.parse(fs.readFileSync(PROFILE_PATH, "utf-8"));
  return _cached;
}

// Get just the aggregated profile (top colors, garment types, etc.)
function getProfile() {
  return loadTasteProfile().profile;
}

// Get search keywords by combining top style tags with top garment types
function getSearchKeywords(limit = 10) {
  const profile = getProfile();
  const tags = profile.top_style_tags.slice(0, 5).map((t) => t.name);
  const garments = profile.top_garment_types.slice(0, 5).map((t) => t.name);
  const materials = profile.top_silhouettes.slice(0, 3).map((t) => t.name);

  const keywords = [];
  for (const tag of tags) {
    for (const garment of garments) {
      keywords.push(`${tag} ${garment}`);
      if (keywords.length >= limit) return keywords;
    }
  }
  // Add material-based keywords
  for (const mat of materials) {
    for (const garment of garments.slice(0, 2)) {
      keywords.push(`${mat} ${garment}`);
      if (keywords.length >= limit) return keywords;
    }
  }
  return keywords;
}

// The analysis prompt used by taste-builder and scorer
const ANALYSIS_PROMPT = `Analyze this clothing product image and extract the following as JSON:

{
  "dominant_colors": ["#hex1", "#hex2", "#hex3"],
  "garment_type": "e.g. hoodie, t-shirt, jacket, pants, sneakers, bag, accessory",
  "silhouette": "e.g. oversized, slim, relaxed, cropped, boxy",
  "material": "e.g. cotton, polyester, leather, nylon, denim, knit",
  "style_tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "aesthetic": "streetwear | minimal | tailored | utility | other"
}

Be specific with hex colors. Limit style_tags to max 5. Return ONLY valid JSON, no extra text.`;

module.exports = { loadTasteProfile, getProfile, getSearchKeywords, ANALYSIS_PROMPT };
