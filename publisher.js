// publisher.js — Publish approved products to Shopify
// Usage: node publisher.js [candidate_id]
// Also importable: const { publishCandidate } = require('./publisher')

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { getDb, initSchema } = require("./db");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

const DESCRIPTION_PROMPT = `Write a product description for IMMIGRANT, a minimal luxury streetwear brand.
Product name: {name}
Style: {aesthetic}

Rules:
- 1-3 sentences maximum
- Sparse and minimal, no exclamation marks
- Describe the garment only — fit, material, feel
- No marketing language, no "elevate your wardrobe", no "must-have"
- No emojis
- Lowercase preferred

Return ONLY the description text, nothing else.`;

async function generateDescription(name, aesthetic) {
  const client = new Anthropic();
  const prompt = DESCRIPTION_PROMPT.replace("{name}", name).replace("{aesthetic}", aesthetic || "minimal");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content[0].text.trim();
}

async function shopifyRequest(endpoint, method = "GET", body = null) {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    throw new Error("SHOPIFY_STORE_URL and SHOPIFY_ACCESS_TOKEN must be set in .env");
  }

  const url = `https://${SHOPIFY_STORE}/admin/api/2024-01${endpoint}`;
  const opts = {
    method,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Shopify ${res.status}: ${errText}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Shopify Collections — create once, cache IDs
// ---------------------------------------------------------------------------

const COLLECTIONS = [
  "New In", "Men-Tops", "Men-Bottoms", "Men-Outerwear", "Men-Footwear",
  "Women-Tops", "Women-Bottoms", "Women-Outerwear", "Women-Footwear",
  "Unisex", "Accessories",
  "Mens-Jewelry", "Womens-Jewelry", "Unisex-Jewelry",
  "Mens-Belts", "Womens-Belts", "Unisex-Belts",
  "Archive",
];

// Map garment types to sub-category
const TOPS = ["t-shirt", "shirt", "blouse", "hoodie", "sweatshirt", "long sleeve t-shirt", "vest", "top"];
const BOTTOMS = ["pants", "jeans", "trouser", "shorts", "skirt"];
const OUTERWEAR = ["jacket", "coat", "puffer jacket", "outerwear", "windbreaker"];
const FOOTWEAR = ["sneakers", "shoes", "boots", "loafers", "sandals", "slippers", "clogs"];
const JEWELRY_TYPES = ["ring", "necklace", "bracelet", "earring", "chain", "pendant", "jewelry"];
const BELT_TYPES = ["belt", "strap", "waistband", "buckle"];
const OTHER_ACCESSORIES = ["bag", "hat", "cap", "sunglasses", "watch", "accessory", "scarf"];

function getCollectionNames(gender, garmentType) {
  const collections = ["New In"];
  const gt = (garmentType || "").toLowerCase();
  const g = (gender || "unisex").toLowerCase();

  const genderPrefix = g === "mens" ? "Mens" : g === "womens" ? "Womens" : "Unisex";
  const clothingPrefix = g === "mens" ? "Men" : g === "womens" ? "Women" : null;

  // Jewelry — gender-specific collections
  if (JEWELRY_TYPES.some((j) => gt.includes(j))) {
    collections.push(`${genderPrefix}-Jewelry`);
    collections.push("Accessories");
    return collections;
  }

  // Belts — gender-specific collections
  if (BELT_TYPES.some((b) => gt.includes(b))) {
    collections.push(`${genderPrefix}-Belts`);
    collections.push("Accessories");
    return collections;
  }

  // Other accessories
  if (OTHER_ACCESSORIES.some((a) => gt.includes(a))) {
    collections.push("Accessories");
    return collections;
  }

  // Clothing — gender + category
  if (clothingPrefix) {
    if (TOPS.some((t) => gt.includes(t))) collections.push(`${clothingPrefix}-Tops`);
    else if (BOTTOMS.some((b) => gt.includes(b))) collections.push(`${clothingPrefix}-Bottoms`);
    else if (OUTERWEAR.some((o) => gt.includes(o))) collections.push(`${clothingPrefix}-Outerwear`);
    else if (FOOTWEAR.some((f) => gt.includes(f))) collections.push(`${clothingPrefix}-Footwear`);
    else collections.push(`${clothingPrefix}-Tops`);
  } else {
    collections.push("Unisex");
  }

  return collections;
}

// Cache of collection title -> shopify ID
let _collectionCache = null;

async function ensureCollections() {
  if (_collectionCache) return _collectionCache;
  _collectionCache = {};

  // Fetch existing custom collections
  try {
    const existing = await shopifyRequest("/custom_collections.json?limit=250");
    for (const c of existing.custom_collections || []) {
      _collectionCache[c.title] = c.id;
    }
  } catch (_) {}

  // Create any missing collections
  for (const title of COLLECTIONS) {
    if (!_collectionCache[title]) {
      try {
        const result = await shopifyRequest("/custom_collections.json", "POST", {
          custom_collection: { title, published: true },
        });
        _collectionCache[title] = result.custom_collection.id;
        console.log(`  Created collection: ${title}`);
        await new Promise((r) => setTimeout(r, 600));
      } catch (err) {
        console.log(`  Failed to create collection ${title}: ${err.message}`);
      }
    }
  }

  return _collectionCache;
}

async function addToCollections(shopifyProductId, collectionNames) {
  const cache = await ensureCollections();
  for (const name of collectionNames) {
    const collectionId = cache[name];
    if (!collectionId) continue;
    try {
      await shopifyRequest("/collects.json", "POST", {
        collect: { product_id: shopifyProductId, collection_id: collectionId },
      });
      await new Promise((r) => setTimeout(r, 300));
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Publish a single candidate
// ---------------------------------------------------------------------------

async function publishCandidate(candidateId, db) {
  const ownDb = !db;
  if (!db) {
    db = getDb();
    initSchema(db);
  }

  const candidate = db.prepare("SELECT * FROM candidates WHERE id = ?").get(candidateId);
  if (!candidate) throw new Error(`Candidate ${candidateId} not found`);
  if (!candidate.immigrant_name) throw new Error(`Candidate ${candidateId} not named yet`);
  if (!candidate.retail_price) throw new Error(`Candidate ${candidateId} not priced yet`);

  // Generate description
  let aesthetic = "minimal";
  try {
    const bd = JSON.parse(candidate.score_breakdown || "{}");
    aesthetic = bd.aesthetic?.value || "minimal";
  } catch (_) {}

  const description = await generateDescription(candidate.immigrant_name, aesthetic);

  // Build variants from namer data
  const variants = [];
  let namerData = {};
  try { namerData = JSON.parse(candidate.namer_data || "{}"); } catch (_) {}

  const sizes = ["XS", "S", "M", "L", "XL"];
  for (const size of sizes) {
    variants.push({
      option1: size,
      price: String(candidate.retail_price),
      requires_shipping: true,
    });
  }

  // Build images array
  const images = [];
  const processedImages = db
    .prepare("SELECT * FROM image_processing WHERE candidate_id = ? AND hidden = 0 ORDER BY sort_order")
    .all(candidateId);

  for (const img of processedImages) {
    if (img.processed_path) {
      const fullPath = path.resolve(__dirname, img.processed_path);
      if (fs.existsSync(fullPath)) {
        const data = fs.readFileSync(fullPath);
        images.push({ attachment: data.toString("base64") });
      }
    }
  }

  // If no processed images, use original
  if (images.length === 0 && candidate.image_path) {
    const fullPath = path.resolve(__dirname, candidate.image_path);
    if (fs.existsSync(fullPath)) {
      const data = fs.readFileSync(fullPath);
      images.push({ attachment: data.toString("base64") });
    }
  }

  // Create Shopify product
  const productData = {
    product: {
      title: candidate.immigrant_name,
      body_html: `<p>${description}</p>`,
      vendor: "IMMIGRANT",
      product_type: aesthetic,
      tags: (namerData.suggested_tags || []).join(", "),
      options: [{ name: "Size", values: sizes }],
      variants,
      images,
    },
  };

  const result = await shopifyRequest("/products.json", "POST", productData);
  const shopifyProductId = result.product.id;

  // Assign to collections based on gender + garment type
  const garmentType = aesthetic; // from score_breakdown
  const collectionNames = getCollectionNames(candidate.gender, garmentType);
  await addToCollections(shopifyProductId, collectionNames);

  // Update database
  db.prepare("UPDATE candidates SET shopify_product_id = ?, immigrant_description = ?, status = 'published' WHERE id = ?").run(
    String(shopifyProductId),
    description,
    candidateId
  );

  // Rate limit: Shopify allows ~2 req/sec
  await new Promise((r) => setTimeout(r, 600));

  if (ownDb) db.close();
  return { shopify_product_id: shopifyProductId, description };
}

// Publish all ready candidates
async function publishAll() {
  const db = getDb();
  initSchema(db);

  const candidates = db.prepare(`
    SELECT id, immigrant_name FROM candidates
    WHERE status = 'approved'
    AND immigrant_name IS NOT NULL
    AND retail_price IS NOT NULL
    AND shopify_product_id IS NULL
  `).all();

  console.log(`=== Publishing ${candidates.length} products to Shopify ===\n`);

  let published = 0;
  let failed = 0;

  for (const c of candidates) {
    try {
      const result = await publishCandidate(c.id, db);
      published++;
      console.log(`  [${published + failed}/${candidates.length}] ${c.immigrant_name} — published (${result.shopify_product_id})`);
    } catch (err) {
      failed++;
      console.log(`  [${published + failed}/${candidates.length}] ${c.immigrant_name} — FAILED: ${err.message}`);
    }
  }

  console.log(`\n=== Done: ${published} published, ${failed} failed ===`);
  db.close();
}

if (require.main === module) {
  const id = parseInt(process.argv[2]);
  if (id) {
    publishCandidate(id).then((r) => {
      console.log(`Published: Shopify ID ${r.shopify_product_id}`);
      console.log(`Description: ${r.description}`);
    }).catch((e) => { console.error("Error:", e.message); process.exit(1); });
  } else {
    publishAll().catch((e) => { console.error("Fatal:", e); process.exit(1); });
  }
}

module.exports = { publishCandidate, publishAll };
