// monitor.js — Dead listing monitor: check product availability and auto-unpublish
// Usage: node monitor.js
// Designed to run daily via cron.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { getDb, initSchema } = require("./db");

const CJ_BASE_URL = "https://developers.cjdropshipping.com";
const TOKEN_PATH = path.join(__dirname, ".cj-token.json");
const SHOPIFY_STORE = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ---------------------------------------------------------------------------
// CJ API helpers
// ---------------------------------------------------------------------------

async function getCjToken() {
  if (fs.existsSync(TOKEN_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
      if (cached.accessToken && cached.expiresAt > Date.now()) return cached.accessToken;
    } catch (_) {}
  }

  const res = await fetch(`${CJ_BASE_URL}/api2.0/v1/authentication/getAccessToken`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.CJ_API_EMAIL,
      password: process.env.CJ_API_KEY,
    }),
  });
  const data = await res.json();
  if (!data.data?.accessToken) throw new Error("CJ auth failed");

  fs.writeFileSync(TOKEN_PATH, JSON.stringify({
    accessToken: data.data.accessToken,
    expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000,
  }));
  return data.data.accessToken;
}

async function checkCjProduct(token, pid) {
  const res = await fetch(`${CJ_BASE_URL}/api2.0/v1/product/query?pid=${pid}`, {
    headers: { "CJ-Access-Token": token },
  });
  const data = await res.json();

  if (data.code !== 200 || !data.data) return { available: false, reason: "not found" };

  const product = data.data;
  if (product.isOff || product.status === "OFF") return { available: false, reason: "delisted by seller" };
  if ((product.warehouseInventoryNum || 0) === 0) return { available: false, reason: "out of stock" };

  return { available: true };
}

// ---------------------------------------------------------------------------
// Shopify helpers
// ---------------------------------------------------------------------------

async function unpublishShopify(shopifyProductId) {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) return;

  const url = `https://${SHOPIFY_STORE}/admin/api/2024-01/products/${shopifyProductId}.json`;
  await fetch(url, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ product: { id: shopifyProductId, status: "draft" } }),
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== IMMIGRANT Store — Dead Listing Monitor ===\n");

  const db = getDb();
  initSchema(db);

  // Get all published CJ-sourced products
  const cjProducts = db.prepare(`
    SELECT id, title, cj_product_id, shopify_product_id
    FROM candidates
    WHERE status = 'published'
    AND cj_product_id IS NOT NULL
    AND shopify_product_id IS NOT NULL
  `).all();

  console.log(`Checking ${cjProducts.length} CJ-sourced published products...\n`);

  if (cjProducts.length === 0) {
    console.log("No published CJ products to check.");
    db.close();
    return;
  }

  let token;
  try {
    token = await getCjToken();
  } catch (err) {
    console.error("Could not authenticate with CJ API:", err.message);
    db.close();
    return;
  }

  let dead = 0;
  let alive = 0;

  for (const p of cjProducts) {
    const result = await checkCjProduct(token, p.cj_product_id);

    if (!result.available) {
      console.log(`  DEAD: ${p.title} — ${result.reason}`);

      // Unpublish from Shopify
      try {
        await unpublishShopify(p.shopify_product_id);
        console.log(`    -> Unpublished from Shopify`);
      } catch (err) {
        console.log(`    -> Failed to unpublish: ${err.message}`);
      }

      db.prepare("UPDATE candidates SET status = 'delisted' WHERE id = ?").run(p.id);
      dead++;
    } else {
      alive++;
    }

    // Rate limit
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Check AliExpress-sourced products older than 30 days (flag only)
  const aliOld = db.prepare(`
    SELECT COUNT(*) as c FROM candidates
    WHERE status = 'published'
    AND source IN ('suggested', 'past_order')
    AND created_at < datetime('now', '-30 days')
  `).get().c;

  if (aliOld > 0) {
    console.log(`\nNote: ${aliOld} AliExpress-sourced products are >30 days old. Consider manual review.`);
  }

  console.log(`\n=== Done: ${alive} alive, ${dead} delisted ===`);
  db.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
