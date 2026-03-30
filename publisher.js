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
    await initSchema(db);
  }

  const { queryOne, run } = require("./db");

  const candidate = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [candidateId]);
  if (!candidate) throw new Error(`Candidate ${candidateId} not found`);

  // Use edited name, or immigrant_name, or title
  const productTitle = candidate.edited_name || candidate.immigrant_name || candidate.title;
  if (!productTitle) throw new Error(`Candidate ${candidateId} has no name`);

  // Use edited price, or retail_price, or raw price
  const productPrice = candidate.edited_price || candidate.retail_price || candidate.price;

  // Generate description if not already edited
  let description = candidate.edited_description || candidate.immigrant_description;
  if (!description) {
    let aesthetic = "minimal";
    try { aesthetic = JSON.parse(candidate.score_breakdown || "{}").aesthetic?.value || "minimal"; } catch (_) {}
    description = await generateDescription(productTitle, aesthetic);
  }

  // Build variants
  let sizes = ["XS", "S", "M", "L", "XL"];
  try { const parsed = JSON.parse(candidate.edited_sizes || "[]"); if (parsed.length > 0) sizes = parsed; } catch (_) {}

  const variants = sizes.map((size) => ({
    option1: size,
    price: String(productPrice || 0),
    requires_shipping: true,
  }));

  // Build images — CRITICAL: use processed_image_url (Ghost Logic) as primary
  const images = [];

  // Priority 1: Ghost Logic processed image URL
  if (candidate.processed_image_url) {
    images.push({ src: candidate.processed_image_url });
  }
  // Priority 2: AliExpress CDN image URL
  else if (candidate.image_url) {
    let url = candidate.image_url;
    if (url.startsWith("//")) url = "https:" + url;
    // Strip avif to get renderable image
    const jpgMatch = url.match(/^(.*?\.(?:jpg|jpeg|png))/i);
    images.push({ src: jpgMatch ? jpgMatch[1] : url.replace(/_?\.avif$/i, "") });
  }
  // Priority 3: Local file (only works on local dev)
  else if (candidate.image_path) {
    const fullPath = path.resolve(__dirname, candidate.image_path);
    if (fs.existsSync(fullPath)) {
      images.push({ attachment: fs.readFileSync(fullPath).toString("base64") });
    }
  }

  // Determine category for collections
  const category = candidate.detected_category || "tops";

  // Create Shopify product
  const productData = {
    product: {
      title: productTitle,
      body_html: `<p>${description}</p>`,
      vendor: "IMMIGRANT",
      product_type: category,
      options: [{ name: "Size", values: sizes }],
      variants,
      images,
    },
  };

  const result = await shopifyRequest("/products.json", "POST", productData);
  const shopifyProductId = result.product.id;
  const shopifyHandle = result.product.handle;
  const shopifyUrl = `https://${SHOPIFY_STORE}/products/${shopifyHandle}`;

  // Assign to collections based on gender + category
  const collectionNames = getCollectionNames(candidate.gender, category);
  await addToCollections(shopifyProductId, collectionNames);

  // Update database via async Turso API
  await run(db, "UPDATE candidates SET shopify_product_id = ?, shopify_url = ?, immigrant_description = ?, status = 'published' WHERE id = ?",
    [String(shopifyProductId), shopifyUrl, description, candidateId]
  );

  // Rate limit: Shopify allows ~2 req/sec
  await new Promise((r) => setTimeout(r, 600));

  if (ownDb) db.close();
  return { shopify_product_id: shopifyProductId, description };
}

// Publish all ready candidates
async function publishAll() {
  const db = getDb();
  await initSchema(db);

  const { queryAll } = require("./db");
  const candidates = await queryAll(db, `
    SELECT id, edited_name, immigrant_name FROM candidates
    WHERE status IN ('approved', 'launch_bucket')
    AND (edited_name IS NOT NULL OR immigrant_name IS NOT NULL)
    AND shopify_product_id IS NULL
  `);

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
