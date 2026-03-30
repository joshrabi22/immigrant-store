// namer.js — Generate IMMIGRANT brand names for products using Claude vision
// Usage: node namer.js <candidate_id>
// Also importable: const { nameCandidate } = require('./namer')

require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const { getDb, initSchema } = require("./db");
const { readImageForApi } = require("./lib/image-utils");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

const NAMING_PROMPT = `You are naming products for IMMIGRANT, a minimal luxury streetwear brand.
Look at this product image and generate a JSON response:

{
  "immigrant_name": "2-3 word name, lowercase, poetic and minimal",
  "category": "one of: tops, bottoms, outerwear, footwear, jewelry, belts, accessories",
  "color_names": ["creative color name for each visible colorway"],
  "size_mapping": {
    "XS": "fits chest 32-34",
    "S": "fits chest 34-36",
    "M": "fits chest 36-38",
    "L": "fits chest 38-40",
    "XL": "fits chest 40-42"
  },
  "suggested_tags": ["tag1", "tag2", "tag3"]
}

Category detection:
- rings, necklaces, bracelets, earrings, chains, pendants → "jewelry"
- belts, straps, waistbands, buckles → "belts"
- bags, hats, caps, sunglasses, watches, scarves → "accessories"
- shirts, tees, hoodies, blouses, vests → "tops"
- pants, jeans, shorts, skirts → "bottoms"
- jackets, coats, windbreakers → "outerwear"
- shoes, boots, sneakers, sandals → "footwear"

For jewelry: size_mapping should use ring sizes (US 6-12) or chain lengths (16-24 inch) instead of clothing sizes.
For belts: size_mapping should use waist sizes (28-40 inch).

Rules:
- Names should feel like Acne Studios or COS, not Shein or H&M
- Never use generic words like "basic", "classic", "premium"
- Color names MUST use this palette vocabulary: "bone" (not white/cream), "slate" (not grey), "moss" (not green), "faded black" (not black), "earth" (not brown), "dust" (not beige), "clay" (not tan), "fog" (not light grey), "ink" (not navy), "rust" (not orange/red)
- NEVER use generic color words like "white", "black", "grey", "green", "blue"
- Note if the item appears to run oversized in size_mapping
- Return ONLY valid JSON, no extra text.`;

async function nameCandidate(candidateId, db) {
  const ownDb = !db;
  if (!db) {
    db = getDb();
    initSchema(db);
  }

  const candidate = db.prepare("SELECT * FROM candidates WHERE id = ?").get(candidateId);
  if (!candidate) throw new Error(`Candidate ${candidateId} not found`);
  if (!candidate.image_path) throw new Error(`Candidate ${candidateId} has no image`);

  const client = new Anthropic();
  const img = readImageForApi(candidate.image_path);
  if (!img) throw new Error(`Image file not found: ${candidate.image_path}`);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } },
          { type: "text", text: NAMING_PROMPT },
        ],
      },
    ],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Could not parse naming response");

  const namerData = JSON.parse(jsonMatch[0]);

  db.prepare("UPDATE candidates SET immigrant_name = ?, namer_data = ? WHERE id = ?").run(
    namerData.immigrant_name,
    JSON.stringify(namerData),
    candidateId
  );

  if (ownDb) db.close();
  return namerData;
}

if (require.main === module) {
  const id = parseInt(process.argv[2]);
  if (!id) {
    console.error("Usage: node namer.js <candidate_id>");
    process.exit(1);
  }
  nameCandidate(id)
    .then((r) => {
      console.log("Named:", r.immigrant_name);
      console.log("Colors:", r.color_names.join(", "));
      console.log("Tags:", r.suggested_tags.join(", "));
    })
    .catch((e) => {
      console.error("Error:", e.message);
      process.exit(1);
    });
}

module.exports = { nameCandidate };
