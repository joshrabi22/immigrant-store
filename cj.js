// cj.js — CJ Dropshipping product sourcer
// Usage: node cj.js
//
// Reads taste_profile.json to generate search keywords,
// queries CJ API, and saves candidates to data.db.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { getDb, initSchema } = require("./db");
const { getSearchKeywords } = require("./lib/taste");
const { downloadImage, sanitizeFilename, ensureDir } = require("./lib/image-utils");

const CJ_BASE_URL = "https://developers.cjdropshipping.com";
const TOKEN_PATH = path.join(__dirname, ".cj-token.json");
const IMAGES_DIR = path.join(__dirname, "images", "candidates");

// ---------------------------------------------------------------------------
// CJ API Auth
// ---------------------------------------------------------------------------

async function getAccessToken() {
  // Check cached token
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
      if (cached.accessToken && cached.expiresAt > Date.now()) {
        console.log("Using cached CJ access token");
        return cached.accessToken;
      }
    } catch (_) {}
  }

  const email = process.env.CJ_API_EMAIL;
  const apiKey = process.env.CJ_API_KEY;

  if (!email || !apiKey) {
    console.error("Error: CJ_API_KEY and CJ_API_EMAIL must be set in .env");
    process.exit(1);
  }

  console.log("Requesting CJ access token...");
  const res = await fetch(`${CJ_BASE_URL}/api2.0/v1/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: apiKey }),
  });

  const data = await res.json();

  if (!data.data || !data.data.accessToken) {
    console.error("CJ auth failed:", JSON.stringify(data));
    process.exit(1);
  }

  const token = data.data.accessToken;
  // Cache token (15 day expiry, we'll use 14 days to be safe)
  fs.writeFileSync(
    TOKEN_PATH,
    JSON.stringify({
      accessToken: token,
      expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000,
    })
  );
  console.log("CJ access token obtained and cached.");
  return token;
}

// ---------------------------------------------------------------------------
// CJ Product Search
// ---------------------------------------------------------------------------

async function searchProducts(token, keyword, page = 1, size = 100) {
  const url = new URL(`${CJ_BASE_URL}/api2.0/v1/product/listV2`);
  url.searchParams.set("keyWord", keyword);
  url.searchParams.set("page", page);
  url.searchParams.set("size", size);

  const res = await fetch(url.toString(), {
    headers: { "CJ-Access-Token": token },
  });

  const data = await res.json();

  if (data.code !== 200 || !data.data) {
    console.log(`  Search failed for "${keyword}": ${data.message || "unknown error"}`);
    return [];
  }

  return data.data || [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== IMMIGRANT Store — CJ Dropshipping Sourcer ===\n");

  ensureDir(IMAGES_DIR);

  const db = getDb();
  initSchema(db);

  const token = await getAccessToken();

  // Generate search keywords from taste profile
  const keywords = getSearchKeywords(10);
  console.log(`\nSearch keywords from taste profile:`);
  keywords.forEach((k) => console.log(`  - ${k}`));

  const insert = db.prepare(`
    INSERT INTO candidates (title, image_url, image_path, source, cj_product_id, price, shipping_cost, product_url, status)
    VALUES (@title, @image_url, @image_path, 'cj', @cj_product_id, @price, @shipping_cost, @product_url, 'new')
  `);

  // Check for existing CJ product IDs to avoid duplicates
  const existingIds = new Set(
    db.prepare("SELECT cj_product_id FROM candidates WHERE cj_product_id IS NOT NULL").all()
      .map((r) => r.cj_product_id)
  );

  let totalAdded = 0;
  let totalSkipped = 0;

  for (const keyword of keywords) {
    console.log(`\nSearching: "${keyword}"...`);
    const products = await searchProducts(token, keyword);
    console.log(`  Found ${products.length} products`);

    for (const p of products) {
      const pid = p.pid || p.productId;
      if (!pid) continue;

      if (existingIds.has(pid)) {
        totalSkipped++;
        continue;
      }

      // Download main image
      let imagePath = null;
      const imageUrl = p.productImage || (p.images && p.images[0]);
      if (imageUrl) {
        const filename = `cj_${sanitizeFilename(p.productName || pid)}_${Date.now()}.jpg`;
        const dest = path.join(IMAGES_DIR, filename);
        try {
          await downloadImage(imageUrl, dest);
          imagePath = path.relative(__dirname, dest);
        } catch (err) {
          console.log(`  Failed to download image: ${err.message}`);
        }
      }

      insert.run({
        title: p.productName || p.productNameEn || "Unknown",
        image_url: imageUrl,
        image_path: imagePath,
        cj_product_id: pid,
        price: p.sellPrice || p.nowPrice || null,
        shipping_cost: null, // CJ shipping varies by destination
        product_url: `https://cjdropshipping.com/product/p-${pid}.html`,
      });

      existingIds.add(pid);
      totalAdded++;
    }

    // Rate limit: 1.5s between searches
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(`\n=== Done! Added ${totalAdded} candidates, skipped ${totalSkipped} duplicates ===`);
  console.log(`Total candidates in DB: ${db.prepare("SELECT COUNT(*) as c FROM candidates").get().c}`);

  db.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
