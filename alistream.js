// alistream.js — Continuous AliExpress product stream
// Usage: node alistream.js
//
// Runs forever (Ctrl+C to stop). Launches headless Playwright browser,
// rotates through AliExpress pages each cycle, filters junk with Claude
// vision, and saves real products to the database (local or Turso cloud).
//
// Works locally or deployed on Railway — no local Chrome needed.

require("dotenv").config();
const { chromium } = require("playwright");
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { getDb, initSchema, queryAll, queryOne, run } = require("./db");
const { downloadAliImage, sanitizeFilename, ensureDir, readImageForApi } = require("./lib/image-utils");

const IMAGES_DIR = path.join(__dirname, "images", "candidates");

// Junk filters
const JUNK_URL_KEYWORDS = ["banner", "promo", "sale", "ad", "poster", "coupon", "campaign", "event"];
const JUNK_TITLE_KEYWORDS = [
  "sale", "% off", "discount", "coupon", "deal", "free shipping",
  "wholesale", "lot of", "pack of", "pcs", "pieces", "clearance",
  "flash deal", "limited time", "buy 1 get", "bundle",
];

const VISION_PROMPT = `Is this a product image for a clothing, fashion, or accessory item? This includes: shirts, jackets, pants, shoes, bags, hats, dresses, hoodies, jewelry, sunglasses, watches — shown on a model, mannequin, flat lay, or plain background.
Answer NO only if the image is: a sale/discount banner, a promotional graphic with percentage signs or large text, a collage of many tiny products, a size chart, or not a product at all.
Answer yes or no.`;

const GENDER_PROMPT = `Is this clothing item primarily: mens, womens, or unisex? Consider cut, style, and presentation.
Answer only: mens, womens, or unisex`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isTitleJunk(title) {
  if (!title || title.length < 5) return true;
  const lower = title.toLowerCase();
  return JUNK_TITLE_KEYWORDS.some((kw) => lower.includes(kw));
}

function waitForEnter(prompt) {
  if (process.env.RAILWAY_ENVIRONMENT || process.env.HEADLESS) return Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => { rl.question(prompt, () => { rl.close(); resolve(); }); });
}

function getSearchKeywords() {
  try {
    const { getSearchKeywords: gsk } = require("./lib/taste");
    return gsk(20);
  } catch (_) {
    return ["oversized hoodie", "minimal jacket", "streetwear pants", "cotton t-shirt", "relaxed denim"];
  }
}

async function getPastOrderTitles(db) {
  const rows = await queryAll(db, "SELECT product_title FROM orders WHERE image_url IS NOT NULL ORDER BY RANDOM() LIMIT 10");
  return rows.map((r) => r.product_title);
}

// Red banner heuristic
function looksLikeRedBanner(buf) {
  if (!buf || buf.length < 1000) return false;
  const start = Math.floor(buf.length * 0.3);
  const sampleSize = Math.min(Math.floor(buf.length * 0.4), 10000);
  let red = 0, white = 0, total = 0;
  for (let i = start; i < start + sampleSize - 2; i += 3) {
    total++;
    if (buf[i] > 180 && buf[i + 1] < 80 && buf[i + 2] < 80) red++;
    if (buf[i] > 230 && buf[i + 1] > 230 && buf[i + 2] > 230) white++;
  }
  if (total === 0) return false;
  return (red / total) > 0.15 && (white / total) > 0.15;
}

// ---------------------------------------------------------------------------
// Scrape product cards from current page
// ---------------------------------------------------------------------------

async function scrapeProductCards(page) {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();
    const allLinks = document.querySelectorAll('a[href*="/item/"], a[href*="aliexpress.com/item"]');

    for (const link of allLinks) {
      const href = link.href || "";
      const idMatch = href.match(/\/item\/(\d+)\.html/) || href.match(/\/item\/(\d+)/);
      if (!idMatch) continue;
      const productId = idMatch[1];
      if (seen.has(productId)) continue;
      seen.add(productId);

      const card = link.closest('[class*="card"], [class*="Card"], [class*="feed"], [class*="item"], [class*="product"]')
        || link.parentElement?.parentElement;

      let title = "";
      if (card) {
        const titleEl = card.querySelector('[class*="title"], [class*="Title"], h3, h2, [class*="name"]');
        title = titleEl ? titleEl.textContent.trim() : "";
      }
      if (!title) title = link.textContent.trim();
      if (!title || title.length < 3) continue;

      let imageUrl = null;
      if (card) {
        const imgEl = card.querySelector('img[src*="alicdn"], img[data-src*="alicdn"], img[src*="ae0"], img');
        if (imgEl) imageUrl = imgEl.src || imgEl.getAttribute("data-src") || imgEl.getAttribute("data-lazy-src");
        if (!imageUrl) {
          const bgEl = card.querySelector('[style*="background-image"]');
          if (bgEl) { const m = bgEl.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/); if (m) imageUrl = m[1]; }
        }
      }

      let price = null;
      if (card) {
        const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
        if (priceEl) { const nums = priceEl.textContent.replace(/[^0-9.]/g, ""); if (nums) price = parseFloat(nums); }
      }

      results.push({
        title: title.substring(0, 300), image_url: imageUrl, ali_product_id: productId,
        product_url: `https://www.aliexpress.com/item/${productId}.html`, price,
      });
    }
    return results;
  });
}

// ---------------------------------------------------------------------------
// Scroll and collect
// ---------------------------------------------------------------------------

async function scrollAndCollect(page, rounds = 10) {
  const all = []; const seenIds = new Set();
  for (let i = 0; i < rounds; i++) {
    const products = await scrapeProductCards(page);
    let n = 0;
    for (const p of products) { if (!seenIds.has(p.ali_product_id)) { seenIds.add(p.ali_product_id); all.push(p); n++; } }
    if (n > 0) process.stdout.write(`  scroll ${i + 1}: +${n} `);
    if (i < rounds - 1) { await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5)); await page.waitForTimeout(randInt(1500, 2500)); }
  }
  if (all.length > 0) console.log(`(${all.length} total)`);
  return all;
}

// ---------------------------------------------------------------------------
// Cycle strategies
// ---------------------------------------------------------------------------

async function cycleHomepage(page) {
  console.log("  Strategy: Homepage 'Just For You'");
  await page.goto("https://www.aliexpress.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  return scrollAndCollect(page, 12);
}

async function cycleMensCategory(page) {
  const cats = [
    "https://www.aliexpress.com/category/100003070/men-clothing.html",
    "https://www.aliexpress.com/category/200000532/t-shirts.html",
    "https://www.aliexpress.com/category/200000297/hoodies-sweatshirts.html",
    "https://www.aliexpress.com/category/200000343/jackets.html",
    "https://www.aliexpress.com/category/200000779/jeans.html",
  ];
  console.log("  Strategy: Men's category");
  await page.goto(cats[randInt(0, cats.length - 1)], { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  return scrollAndCollect(page, 10);
}

async function cycleWomensCategory(page) {
  const cats = [
    "https://www.aliexpress.com/category/100003109/women-clothing.html",
    "https://www.aliexpress.com/category/200000784/dresses.html",
    "https://www.aliexpress.com/category/200000349/blouses-shirts.html",
    "https://www.aliexpress.com/category/200000362/women-jackets.html",
  ];
  console.log("  Strategy: Women's category");
  await page.goto(cats[randInt(0, cats.length - 1)], { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  return scrollAndCollect(page, 10);
}

async function cycleUnisex(page) {
  const terms = ["oversized hoodie unisex", "unisex streetwear", "oversized t-shirt", "relaxed fit jacket"];
  const term = terms[randInt(0, terms.length - 1)];
  console.log(`  Strategy: Unisex search — "${term}"`);
  await page.goto(`https://www.aliexpress.com/w/wholesale-${encodeURIComponent(term)}.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  return scrollAndCollect(page, 8);
}

async function cycleSearch(page) {
  const keywords = getSearchKeywords();
  const keyword = keywords[randInt(0, keywords.length - 1)];
  console.log(`  Strategy: Search — "${keyword}"`);
  await page.goto(`https://www.aliexpress.com/w/wholesale-${encodeURIComponent(keyword)}.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  return scrollAndCollect(page, 8);
}

async function cycleAccessories(page) {
  const terms = [
    "men's jewelry minimal", "women's jewelry minimal gold", "unisex chain necklace",
    "men's leather belt minimal", "women's belt minimal", "minimal silver ring",
    "gold chain streetwear", "minimal bracelet unisex", "leather belt luxury",
  ];
  const term = terms[randInt(0, terms.length - 1)];
  console.log(`  Strategy: Accessories — "${term}"`);
  await page.goto(`https://www.aliexpress.com/w/wholesale-${encodeURIComponent(term)}.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  return scrollAndCollect(page, 8);
}

const STRATEGIES = [cycleHomepage, cycleMensCategory, cycleWomensCategory, cycleUnisex, cycleSearch, cycleAccessories];
const STRATEGY_NAMES = ["Homepage", "Men's", "Women's", "Unisex", "Search", "Accessories"];

// ---------------------------------------------------------------------------
// Filter and save — async DB
// ---------------------------------------------------------------------------

async function filterAndSave(products, db, existingIds, client, model) {
  let added = 0, filtered = 0, dupes = 0;

  for (const p of products) {
    if (existingIds.has(p.ali_product_id)) { dupes++; continue; }
    if (isTitleJunk(p.title)) { filtered++; continue; }
    if (p.image_url) {
      const urlLower = p.image_url.toLowerCase();
      if (JUNK_URL_KEYWORDS.some((kw) => urlLower.includes(kw))) { filtered++; continue; }
    }

    // Download image — try multiple URL formats
    const filenameBase = `ali_${sanitizeFilename(p.title)}_${Date.now()}`;
    const imgResult = await downloadAliImage(p.image_url, IMAGES_DIR, filenameBase);
    if (!imgResult) { filtered++; continue; }

    const imagePath = path.relative(__dirname, imgResult.path);
    const fullImagePath = imgResult.path;

    // Red banner check
    const buf = fs.readFileSync(fullImagePath);
    if (looksLikeRedBanner(buf)) {
      try { fs.unlinkSync(fullImagePath); } catch (_) {}
      filtered++;
      continue;
    }

    // Claude vision product check
    if (client) {
      const img = readImageForApi(fullImagePath);
      if (img) {
        try {
          const res = await client.messages.create({
            model, max_tokens: 8,
            messages: [{ role: "user", content: [
              { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } },
              { type: "text", text: VISION_PROMPT },
            ]}],
          });
          if (!res.content[0].text.trim().toLowerCase().startsWith("yes")) {
            try { fs.unlinkSync(fullImagePath); } catch (_) {}
            filtered++;
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
          await new Promise((r) => setTimeout(r, 300));
        } catch (_) {}
      }
    }

    // Gender detection
    let gender = "unisex";
    if (client) {
      const img = readImageForApi(fullImagePath);
      if (img) {
        try {
          const gRes = await client.messages.create({
            model, max_tokens: 8,
            messages: [{ role: "user", content: [
              { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } },
              { type: "text", text: GENDER_PROMPT },
            ]}],
          });
          const gAnswer = gRes.content[0].text.trim().toLowerCase();
          if (gAnswer.includes("mens") || gAnswer.includes("men")) gender = "mens";
          else if (gAnswer.includes("womens") || gAnswer.includes("women")) gender = "womens";
          await new Promise((r) => setTimeout(r, 300));
        } catch (_) {}
      }
    }

    // Save to database (async)
    try {
      await run(db,
        "INSERT INTO candidates (title, image_url, image_path, source, ali_product_id, price, product_url, status, gender) VALUES (?, ?, ?, 'aliexpress', ?, ?, ?, 'new', ?)",
        [p.title, p.image_url, imagePath, p.ali_product_id, p.price, p.product_url, gender]
      );
      added++;
      existingIds.add(p.ali_product_id);
    } catch (_) {}
  }

  return { added, filtered, dupes };
}

// ---------------------------------------------------------------------------
// Launch browser — headless (for cloud) or headed (for local)
// ---------------------------------------------------------------------------

async function launchBrowser() {
  const isCloud = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.HEADLESS;

  if (isCloud) {
    // Headless mode for Railway / cloud deployment
    console.log("Launching headless browser...");
    const browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });
    const page = await context.newPage();
    return { browser, page };
  }

  // Local mode — try CDP first, fall back to headless
  try {
    console.log("Connecting to Chrome via CDP (localhost:9222)...");
    const browser = await chromium.connectOverCDP("http://localhost:9222");
    const context = browser.contexts()[0];
    const page = await context.newPage();
    console.log("Connected to local Chrome!\n");
    return { browser, page };
  } catch (_) {
    console.log("CDP not available. Launching standalone browser...");
    const browser = await chromium.launch({ headless: false, args: ["--disable-blink-features=AutomationControlled"] });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    return { browser, page };
  }
}

// ---------------------------------------------------------------------------
// Main — continuous loop
// ---------------------------------------------------------------------------

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║   IMMIGRANT — AliExpress Stream          ║");
  console.log("║   Continuous product discovery            ║");
  console.log("║   Press Ctrl+C to stop                   ║");
  console.log("╚══════════════════════════════════════════╝\n");

  await waitForEnter("Press Enter when ready... ");

  ensureDir(IMAGES_DIR);
  const db = getDb();
  await initSchema(db);

  // Load existing IDs for dedup
  const existingRows = await queryAll(db, "SELECT ali_product_id FROM candidates WHERE ali_product_id IS NOT NULL");
  const existingIds = new Set(existingRows.map((r) => r.ali_product_id));
  console.log(`${existingIds.size} products already in database.`);

  const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
  if (!client) console.log("Warning: No ANTHROPIC_API_KEY — skipping vision filter.\n");

  const { browser, page } = await launchBrowser();

  let cycleNum = 0, totalAdded = 0, totalFiltered = 0;
  let running = true;
  process.on("SIGINT", () => { console.log("\n\nShutting down..."); running = false; });

  try {
    while (running) {
      cycleNum++;
      const strategyIdx = (cycleNum - 1) % STRATEGIES.length;
      console.log(`\n── Cycle ${cycleNum} (${STRATEGY_NAMES[strategyIdx]}) ──`);

      let products = [];
      try {
        products = await STRATEGIES[strategyIdx](page, db);
      } catch (err) {
        console.log(`  Error: ${err.message}`);
      }

      if (products.length > 0) {
        const result = await filterAndSave(products, db, existingIds, client, model);
        totalAdded += result.added;
        totalFiltered += result.filtered;

        const qc = await queryOne(db, "SELECT COUNT(*) as c FROM candidates WHERE status = 'new'");
        console.log(`  Cycle ${cycleNum} complete — ${result.added} added (${result.filtered} filtered, ${result.dupes} dupes) — ${qc?.c || 0} in queue`);
      } else {
        console.log(`  Cycle ${cycleNum} complete — no products found`);
      }

      if (!running) break;
      const delay = randInt(30, 60);
      console.log(`  Waiting ${delay}s...`);
      for (let i = 0; i < delay && running; i++) await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (err) {
    console.error("Fatal:", err.message);
  } finally {
    const qc = await queryOne(db, "SELECT COUNT(*) as c FROM candidates WHERE status = 'new'");
    console.log(`\n=== Stream stopped — ${totalAdded} added, ${totalFiltered} filtered, ${qc?.c || 0} in queue ===`);
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main();
