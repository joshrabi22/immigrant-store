// scraper.js — AliExpress order history scraper via Chrome DevTools Protocol
// Usage:
//   1. Run: ./start-chrome.sh
//   2. Log in to AliExpress in the Chrome window
//   3. Run: node scraper.js
//
// Connects to your real Chrome session — no bot detection issues.

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const readline = require("readline");
const { getDb, initSchema } = require("./db");

const CDP_ENDPOINT = "http://localhost:9222";
const IMAGES_DIR = path.join(__dirname, "images", "orders");
const CANDIDATES_IMAGES_DIR = path.join(__dirname, "images", "candidates");
const ORDER_LIST_URL = "https://www.aliexpress.com/p/order/index.html";
const HOMEPAGE_URL = "https://www.aliexpress.com/";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    if (!url) return resolve(null);
    // Ensure URL has protocol
    if (url.startsWith("//")) url = "https:" + url;
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    client
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          downloadImage(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve(dest);
        });
      })
      .on("error", (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9_-]/gi, "_").substring(0, 80);
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Scraping — selectors matched to actual AliExpress DOM (March 2026)
// ---------------------------------------------------------------------------

async function scrapeCurrentOrders(page) {
  return page.evaluate(() => {
    const results = [];

    // Each order is a div.order-item
    const containers = document.querySelectorAll("div.order-item");

    for (const container of containers) {
      // Title: .order-item-content-info-name a span (title attr has full text)
      const titleEl = container.querySelector(".order-item-content-info-name a span");
      const title = titleEl
        ? titleEl.getAttribute("title") || titleEl.textContent.trim()
        : "";

      if (!title) continue;

      // Image: div.order-item-content-img has background-image style, NOT an <img> tag
      const imgDiv = container.querySelector(".order-item-content-img");
      let imageUrl = null;
      if (imgDiv) {
        const style = imgDiv.getAttribute("style") || "";
        const match = style.match(/url\(["']?(.*?)["']?\)/);
        if (match) imageUrl = match[1];
      }

      // Price: .order-item-content-opt-price-total contains chars split across spans
      // Just grab the full textContent and extract the number
      const priceEl = container.querySelector(".order-item-content-opt-price-total");
      let price = null;
      if (priceEl) {
        const priceText = priceEl.textContent.replace(/[^0-9.]/g, "");
        if (priceText) price = parseFloat(priceText);
      }

      // Order date: .order-item-header-right-info first child div
      const dateInfoEl = container.querySelector(".order-item-header-right-info");
      let orderDate = null;
      if (dateInfoEl && dateInfoEl.children[0]) {
        orderDate = dateInfoEl.children[0].textContent.replace("Order date:", "").trim();
      }

      // Seller: .order-item-store-name a — store ID from href, name from span text
      const sellerLink = container.querySelector(".order-item-store-name a");
      let sellerId = null;
      if (sellerLink) {
        const storeMatch = sellerLink.href.match(/store\/(\d+)/);
        sellerId = storeMatch ? storeMatch[1] : sellerLink.textContent.trim();
      }

      results.push({
        product_title: title,
        image_url: imageUrl,
        price,
        seller_id: sellerId,
        order_date: orderDate,
        category: null,
      });
    }

    return results;
  });
}

// ---------------------------------------------------------------------------
// Load more — AliExpress uses a "View orders" button, not page numbers
// ---------------------------------------------------------------------------

async function clickLoadMore(page) {
  const btn = await page.$(".order-more button");
  if (!btn) return false;

  // Check if button is visible/enabled
  const isVisible = await btn.isVisible().catch(() => false);
  if (!isVisible) return false;

  await btn.click();
  await page.waitForTimeout(3000); // Wait for new orders to load
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== IMMIGRANT Store — AliExpress Order Scraper ===\n");
  console.log("This script connects to your real Chrome browser via DevTools Protocol.\n");
  console.log("Before continuing, make sure you have:");
  console.log("  1. Run ./start-chrome.sh (or launched Chrome with --remote-debugging-port=9222)");
  console.log("  2. Logged in to AliExpress in that Chrome window\n");

  await waitForEnter("Press Enter when ready... ");

  ensureDir(IMAGES_DIR);

  const db = getDb();
  initSchema(db);

  // Clear previous scrape data
  db.prepare("DELETE FROM orders").run();
  console.log("\nCleared previous order data from database.");

  const insert = db.prepare(`
    INSERT INTO orders (product_title, image_url, image_path, category, price, seller_id, order_date)
    VALUES (@product_title, @image_url, @image_path, @category, @price, @seller_id, @order_date)
  `);

  // Connect to Chrome via CDP
  let browser;
  try {
    console.log(`Connecting to Chrome at ${CDP_ENDPOINT}...`);
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    console.log("Connected!\n");
  } catch (err) {
    console.error("Failed to connect to Chrome. Make sure:");
    console.error("  - Chrome is running with --remote-debugging-port=9222");
    console.error("  - Run ./start-chrome.sh first");
    console.error(`\nError: ${err.message}`);
    db.close();
    process.exit(1);
  }

  const context = browser.contexts()[0];
  if (!context) {
    console.error("No browser context found. Is Chrome open with at least one window?");
    await browser.close();
    db.close();
    process.exit(1);
  }

  const page = await context.newPage();

  try {
    // Navigate to orders page
    console.log("Navigating to AliExpress orders page...");
    await page.goto(ORDER_LIST_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Check for login redirect
    const url = page.url();
    if (url.includes("login") || url.includes("passport")) {
      console.log("\nNot logged in! Please log in to AliExpress first, then run again.");
      await page.close();
      await browser.close();
      db.close();
      process.exit(1);
    }

    // Wait for order items to appear
    console.log("Waiting for orders to load...");
    await page.waitForSelector("div.order-item", { timeout: 15000 }).catch(() => {
      console.log("Warning: div.order-item not found within 15s, will try anyway...");
    });
    await page.waitForTimeout(2000);

    // Save debug HTML on every run
    const debugHtml = await page.content();
    fs.writeFileSync(path.join(__dirname, "debug-page.html"), debugHtml);
    console.log("Saved debug-page.html for selector inspection.\n");

    // Click "View orders" / load-more until all orders are visible
    let loadMoreRound = 0;
    while (true) {
      const moreLoaded = await clickLoadMore(page);
      if (!moreLoaded) break;
      loadMoreRound++;
      const currentCount = await page.$$eval("div.order-item", (els) => els.length);
      console.log(`  Loaded more orders (round ${loadMoreRound}) — ${currentCount} orders visible`);
    }

    // Now scrape everything on the fully-loaded page
    console.log("\nScraping all orders...");
    const orders = await scrapeCurrentOrders(page);
    console.log(`Found ${orders.length} orders total.\n`);

    if (orders.length === 0) {
      console.log("No orders found. The page structure may have changed.");
      console.log("Check debug-page.html and update the selectors in scraper.js.");
    }

    // Download images and save to database
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      const shortTitle = order.product_title.substring(0, 55);
      let imagePath = null;

      if (order.image_url) {
        const filename = `${sanitizeFilename(order.product_title)}_${Date.now()}.jpg`;
        const dest = path.join(IMAGES_DIR, filename);
        try {
          await downloadImage(order.image_url, dest);
          imagePath = path.relative(__dirname, dest);
        } catch (err) {
          console.log(`  [${i + 1}] Failed to download image: ${err.message}`);
        }
      }

      insert.run({
        product_title: order.product_title,
        image_url: order.image_url,
        image_path: imagePath,
        category: order.category,
        price: order.price,
        seller_id: order.seller_id,
        order_date: order.order_date,
      });

      const priceStr = order.price ? `$${order.price}` : "no price";
      const imgStr = imagePath ? "img OK" : "no img";
      console.log(`  [${i + 1}/${orders.length}] ${shortTitle}... — ${priceStr}, ${imgStr}`);
    }

    console.log(`\n=== Done! Scraped ${orders.length} orders ===`);
    console.log(`Images saved to: ${IMAGES_DIR}`);
    console.log(`Database: ${path.join(__dirname, "data.db")}`);
  } catch (err) {
    console.error("Error during scraping:", err.message);
    try {
      const html = await page.content();
      fs.writeFileSync(path.join(__dirname, "debug-page.html"), html);
      console.log("Saved debug-page.html for inspection.");
    } catch (_) {}
  } finally {
    await page.close();
    await browser.close(); // Disconnects CDP only, does NOT close Chrome
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Suggested mode — scrape AliExpress homepage recommendations
// ---------------------------------------------------------------------------

async function scrapeSuggestedProducts(page) {
  return page.evaluate(() => {
    const results = [];
    // AliExpress homepage product cards — try multiple selector strategies
    const cards = document.querySelectorAll(
      '[class*="product-card"], [class*="ProductCard"], [class*="feed-item"], ' +
      '[class*="card-item"], a[href*="/item/"][class*="card"]'
    );

    for (const card of cards) {
      const linkEl = card.querySelector('a[href*="/item/"]') || (card.matches('a[href*="/item/"]') ? card : null);
      if (!linkEl) continue;

      const href = linkEl.href || "";
      const productIdMatch = href.match(/\/item\/(\d+)\.html/);
      const productId = productIdMatch ? productIdMatch[1] : null;

      // Title
      const titleEl = card.querySelector('[class*="title"], [class*="Title"], h3, h2');
      const title = titleEl ? titleEl.textContent.trim() : "";
      if (!title || title.length < 5) continue;

      // Image — could be img tag or background-image
      const imgEl = card.querySelector("img[src*='alicdn'], img[data-src*='alicdn'], img");
      let imageUrl = null;
      if (imgEl) {
        imageUrl = imgEl.src || imgEl.getAttribute("data-src");
      }

      // Price
      const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
      let price = null;
      if (priceEl) {
        const priceText = priceEl.textContent.replace(/[^0-9.]/g, "");
        if (priceText) price = parseFloat(priceText);
      }

      results.push({
        title,
        image_url: imageUrl,
        price,
        ali_product_id: productId,
        product_url: href,
      });
    }

    return results;
  });
}

async function mainSuggested() {
  console.log("=== IMMIGRANT Store — AliExpress Suggested Products Scraper ===\n");
  console.log("This scrapes recommended products from the AliExpress homepage.\n");
  console.log("Make sure Chrome is running with ./start-chrome.sh and you're logged in.\n");

  await waitForEnter("Press Enter when ready... ");

  ensureDir(CANDIDATES_IMAGES_DIR);

  const db = getDb();
  initSchema(db);

  const insert = db.prepare(`
    INSERT INTO candidates (title, image_url, image_path, source, ali_product_id, price, product_url, status)
    VALUES (@title, @image_url, @image_path, 'suggested', @ali_product_id, @price, @product_url, 'new')
  `);

  // Get existing AliExpress product IDs to deduplicate
  const existingIds = new Set(
    db.prepare("SELECT ali_product_id FROM candidates WHERE ali_product_id IS NOT NULL").all()
      .map((r) => r.ali_product_id)
  );

  let browser;
  try {
    console.log(`Connecting to Chrome at ${CDP_ENDPOINT}...`);
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    console.log("Connected!\n");
  } catch (err) {
    console.error("Failed to connect to Chrome. Run ./start-chrome.sh first.");
    console.error(`Error: ${err.message}`);
    db.close();
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const page = await context.newPage();

  try {
    console.log("Navigating to AliExpress homepage...");
    await page.goto(HOMEPAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Scroll down several times to load more recommendations
    console.log("Scrolling to load recommendations...");
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(1500);
    }

    // Save debug HTML
    const debugHtml = await page.content();
    fs.writeFileSync(path.join(__dirname, "debug-suggested.html"), debugHtml);
    console.log("Saved debug-suggested.html for selector inspection.\n");

    const products = await scrapeSuggestedProducts(page);
    console.log(`Found ${products.length} suggested products.\n`);

    let added = 0;
    let skipped = 0;

    for (let i = 0; i < products.length; i++) {
      const p = products[i];

      if (p.ali_product_id && existingIds.has(p.ali_product_id)) {
        skipped++;
        continue;
      }

      let imagePath = null;
      if (p.image_url) {
        const filename = `suggested_${sanitizeFilename(p.title)}_${Date.now()}.jpg`;
        const dest = path.join(CANDIDATES_IMAGES_DIR, filename);
        try {
          await downloadImage(p.image_url, dest);
          imagePath = path.relative(__dirname, dest);
        } catch (err) {
          // Silent fail for image downloads
        }
      }

      insert.run({
        title: p.title,
        image_url: p.image_url,
        image_path: imagePath,
        ali_product_id: p.ali_product_id,
        price: p.price,
        product_url: p.product_url,
      });

      if (p.ali_product_id) existingIds.add(p.ali_product_id);
      added++;

      const shortTitle = p.title.substring(0, 55);
      const priceStr = p.price ? `$${p.price}` : "no price";
      console.log(`  [${i + 1}/${products.length}] ${shortTitle}... — ${priceStr}`);
    }

    console.log(`\n=== Done! Added ${added} candidates, skipped ${skipped} duplicates ===`);
    console.log(`Total candidates: ${db.prepare("SELECT COUNT(*) as c FROM candidates").get().c}`);
  } catch (err) {
    console.error("Error during scraping:", err.message);
    try {
      const html = await page.content();
      fs.writeFileSync(path.join(__dirname, "debug-suggested.html"), html);
    } catch (_) {}
  } finally {
    await page.close();
    await browser.close();
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point — dispatch based on CLI argument
// ---------------------------------------------------------------------------

const mode = process.argv[2];
if (mode === "suggested") {
  mainSuggested();
} else {
  main();
}
