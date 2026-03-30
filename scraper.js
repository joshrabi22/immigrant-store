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
const { getDb, initSchema, run, queryAll } = require("./db");

const CDP_ENDPOINT = "http://localhost:9222";
const IMAGES_DIR = path.join(__dirname, "images", "orders");
const CANDIDATES_IMAGES_DIR = path.join(__dirname, "images", "candidates");
const ORDER_LIST_URL = "https://www.aliexpress.com/p/order/index.html";
const HOMEPAGE_URL = "https://www.aliexpress.com/";
const WISHLIST_URL = "https://www.aliexpress.com/p/wish-manage/index.html";

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
    const seen = new Set();

    // AliExpress homepage product cards.
    // Primary: .card-out-wrapper (stable class used in 2024/2025 homepage layout).
    // Fallbacks for older/alternate layouts.
    const cards = document.querySelectorAll(
      '.card-out-wrapper, [class*="product-card"], [class*="ProductCard"], ' +
      '[class*="feed-item"], [class*="card-item"]'
    );

    for (const card of cards) {
      const linkEl = card.querySelector('a[href*="/item/"]') ||
        (card.matches('a[href*="/item/"]') ? card : null);
      if (!linkEl) continue;

      // linkEl.href resolves protocol-relative //host/item/... to full URL
      const href = linkEl.href || "";
      const productIdMatch = href.match(/\/item\/(\d+)\.html/);
      const productId = productIdMatch ? productIdMatch[1] : null;
      if (!productId || seen.has(productId)) continue;
      seen.add(productId);

      // Canonical URL — strip locale (he., fr., etc.) back to www.aliexpress.com
      const productUrl = `https://www.aliexpress.com/item/${productId}.html`;

      // Title: prefer h3 inside card, then heading role, then img alt
      const h3El = card.querySelector("h3");
      const headingEl = card.querySelector('[role="heading"]');
      const imgAltEl = card.querySelector("img.product-img");
      const title = (h3El?.textContent.trim()) ||
        (headingEl?.getAttribute("title") || headingEl?.textContent.trim()) ||
        (imgAltEl?.alt) || "";
      if (!title || title.length < 5) continue;

      // Image: prefer img.product-img (stable class), then aliexpress-media, then any img
      const imgEl = card.querySelector("img.product-img") ||
        card.querySelector("img[src*='ae-pic'], img[src*='alicdn'], img[data-src*='alicdn']") ||
        card.querySelector("img");
      let imageUrl = null;
      if (imgEl) {
        // .src resolves protocol-relative URLs; fall back to attribute
        imageUrl = imgEl.src || imgEl.getAttribute("data-src") || imgEl.getAttribute("src");
        // Ensure absolute URL for protocol-relative srcs
        if (imageUrl && imageUrl.startsWith("//")) imageUrl = "https:" + imageUrl;
      }

      // Price: prefer class-based price container, then aria-label fallback.
      // [aria-label*="."] is too broad — it matches star ratings, shipping labels, etc.
      const priceEl = card.querySelector('[class*="price"], [class*="Price"]') ||
        card.querySelector('[aria-label*="."]');
      let price = null;
      if (priceEl) {
        const raw = priceEl.getAttribute("aria-label") || priceEl.textContent;
        const priceText = raw.replace(/[^0-9.]/g, "");
        if (priceText) {
          const parsed = parseFloat(priceText);
          if (isFinite(parsed)) price = parsed;
        }
      }

      results.push({
        title,
        image_url: imageUrl,
        price,
        ali_product_id: productId,
        product_url: productUrl,
      });
    }

    return results;
  });
}

// Scrape full product gallery from individual product page.
// Same logic as alistream.js — kept in sync manually.
async function scrapeProductGallery(page, productUrl, productId) {
  try {
    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {
      const images = new Set();
      const variantMap = {};

      document.querySelectorAll(
        'img[src*="alicdn"], img[data-src*="alicdn"], img[src*="ae-pic"], img[data-src*="ae-pic"]'
      ).forEach((img) => {
        const src = img.src || img.getAttribute("data-src") || img.getAttribute("data-lazy-src");
        if (src && (src.includes("alicdn") || src.includes("ae-pic"))) images.add(src);
      });

      document.querySelectorAll(
        '[class*="sku"] img, [class*="variant"] img, [class*="color"] img, [class*="Sku"] img'
      ).forEach((img) => {
        const src = img.src || img.getAttribute("data-src");
        if (src) images.add(src);
      });

      const scripts = document.querySelectorAll("script");
      for (const script of scripts) {
        const text = script.textContent || "";
        const imgListMatch = text.match(/"imagePathList"\s*:\s*\[(.*?)\]/);
        if (imgListMatch) {
          const urls = imgListMatch[1].match(/"(https?:\/\/[^"]+)"/g);
          if (urls) urls.forEach((u) => images.add(u.replace(/"/g, "")));
        }
        const skuBlocks = text.matchAll(/"skuPropertyId"\s*:\s*"([^"]+)"[^}]*?"skuPropertyName"\s*:\s*"([^"]*)"[^}]*?"skuPropertyImagePath"\s*:\s*"(https?:\/\/[^"]+)"/g);
        for (const m of skuBlocks) {
          const [_, propId, propName, imgUrl] = m;
          images.add(imgUrl);
          variantMap[imgUrl] = { propertyId: propId, propertyName: propName, sizes: [] };
        }
      }

      // Known AliExpress page-chrome file hashes (service badges, trust icons,
      // shipping graphics). These appear across 5-145 different products — never
      // product images. Derived from cross-product frequency analysis.
      const PAGE_CHROME = new Set([
        "Sa976459fb7724bf1bca6e153a425a8ebg","S9e723ca0d10848499e4e3fb33be2224do",
        "S64c04957a1244dffbab7086d6e1a7cad7","Sb100bd23552d499c9fa8e1499f3c46dbw",
        "S5c3261cf46fb47aa8c7f3abbdd792574S","Saf2ebe3af38947179531973d0d08ef74Y",
        "Sd8c759485ca2404d87d8f5d5ed0d98e0K","S16183c3f12904fbbaf3f8aef523f0b73T",
        "S9bad0c7ed77b4899ae22645df613a766r","Sa42ea28366094829a2e882420e1e269aJ",
        "S3f91b770226a464c8baf581b22e148f7Y","S5fde9fa3ffdb45cf908380fcc49bf6771",
        "Sa3e67595f2374efa9ce9f91574dc4650T",
      ]);
      const extractHash = (u) => { const m = u.match(/\/kf\/([A-Za-z0-9_]+)/); return m ? m[1] : null; };

      // Multi-layer filter: fingerprints + structural patterns + keywords
      const filtered = [...images].filter((url) => {
        if (!url || typeof url !== "string") return false;
        if (url.length < 30 || url.startsWith("data:")) return false;
        // Non-CDN (broken/truncated URLs)
        if (!url.includes("alicdn.com") && !url.includes("aliexpress-media.com")) return false;
        // Known page chrome
        const h = extractHash(url);
        if (h && PAGE_CHROME.has(h)) return false;
        // Structural: tiny pixel images, thumbnails, quality-suffixed variants
        if (/\/\d{1,3}x\d{1,3}\.(?:png|jpg|gif)/i.test(url)) return false;
        if (/_\d{1,3}x\d{1,3}[._]/.test(url)) return false;
        if (/_\d{2,4}x\d{2,4}q\d+\.jpg/i.test(url)) return false;
        if (/\/ae-us\/.*?(category|nav|menu|header|footer)/i.test(url)) return false;
        // Keywords
        if (/icon|sprite|logo|star|rating|arrow|button|banner|placeholder|avatar/i.test(url)) return false;
        return true;
      });

      // Deduplicate by base URL (strip size suffixes + .avif wrappers)
      const baseUrl = (u) => {
        const m = u.match(/^(.*?\.(?:jpg|jpeg|png|webp))/i);
        return (m ? m[1] : u).replace(/^\/\//, "https://").toLowerCase();
      };
      const seen = new Set();
      const deduped = filtered.filter((url) => {
        const key = baseUrl(url);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      return { images: deduped, variantMap };
    });

    return result;
  } catch (err) {
    console.log(`  Gallery scrape failed for ${productId}: ${err.message}`);
    return { images: [], variantMap: {} };
  }
}

async function mainSuggested() {
  console.log("=== IMMIGRANT Store — AliExpress Suggested Products Scraper ===\n");
  console.log("This scrapes recommended products from the AliExpress homepage.\n");
  console.log("Make sure Chrome is running with ./start-chrome.sh and you're logged in.\n");

  await waitForEnter("Press Enter when ready... ");

  ensureDir(CANDIDATES_IMAGES_DIR);

  const db = getDb();
  await initSchema(db);

  // Get existing AliExpress product IDs to deduplicate
  const existingRows = await queryAll(db, "SELECT ali_product_id FROM candidates WHERE ali_product_id IS NOT NULL");
  const existingIds = new Set(existingRows.map((r) => r.ali_product_id));

  let browser;
  try {
    console.log(`Connecting to Chrome at ${CDP_ENDPOINT}...`);
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    console.log("Connected!\n");
  } catch (err) {
    console.error("Failed to connect to Chrome. Run ./start-chrome.sh first.");
    console.error(`Error: ${err.message}`);
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

    // Diagnostic: count card-out-wrapper elements before scraping
    const cardCount = await page.$$eval('.card-out-wrapper', (els) => els.length);
    console.log(`Selector diagnostic: .card-out-wrapper = ${cardCount} elements on page`);

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

      // Scrape full gallery from product page
      let allImages = null;
      let variantSpecifics = null;
      if (p.product_url) {
        const gallery = await scrapeProductGallery(page, p.product_url, p.ali_product_id);
        if (gallery.images.length > 0) allImages = JSON.stringify(gallery.images);
        if (Object.keys(gallery.variantMap).length > 0) variantSpecifics = JSON.stringify(gallery.variantMap);
      }

      const safePrice = (p.price != null && isFinite(p.price)) ? p.price : null;
      await run(db,
        "INSERT INTO candidates (title, image_url, image_path, source, ali_product_id, price, product_url, status, all_images, variant_specifics) VALUES (?, ?, ?, 'suggested', ?, ?, ?, 'new', ?, ?)",
        [p.title, p.image_url, imagePath, p.ali_product_id, safePrice, p.product_url, allImages, variantSpecifics]
      );

      if (p.ali_product_id) existingIds.add(p.ali_product_id);
      added++;

      const galleryCount = allImages ? JSON.parse(allImages).length : 0;
      const shortTitle = p.title.substring(0, 55);
      const priceStr = p.price ? `$${p.price}` : "no price";
      console.log(`  [${i + 1}/${products.length}] ${shortTitle}... — ${priceStr} (${galleryCount} gallery imgs)`);
    }

    const countRow = await queryAll(db, "SELECT COUNT(*) as c FROM candidates");
    console.log(`\n=== Done! Added ${added} candidates, skipped ${skipped} duplicates ===`);
    console.log(`Total candidates: ${countRow[0].c}`);
  } catch (err) {
    console.error("Error during scraping:", err.message);
    try {
      const html = await page.content();
      fs.writeFileSync(path.join(__dirname, "debug-suggested.html"), html);
    } catch (_) {}
  } finally {
    await page.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Wishlist — scrape AliExpress saved/favorites items
// ---------------------------------------------------------------------------

// Extracts product cards from the AliExpress wishlist page (/p/wish-manage/).
//
// This page does NOT use <a href="/item/..."> links — navigation is JS-driven.
// Product data is encoded in the DOM as follows:
//   - Product ID:  data-id="operator_PRODUCTID" on the action-overlay div
//   - Title:       <span class*="sideTitleText"> inside the card
//   - Image:       CSS background-image on <div class*="pictureUrl">
//   - Price:       textContent of <div class*="price--price"> (individual char spans)
async function scrapeWishlistProducts(page) {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();

    // Each product card has an action overlay with data-id="operator_PRODUCTID".
    // The operator div and the productCard are siblings inside the editItemWrap container.
    document.querySelectorAll('[data-id^="operator_"]').forEach((operatorEl) => {
      const dataId = operatorEl.getAttribute("data-id") || "";
      const productId = dataId.replace("operator_", "");
      if (!productId || !/^\d+$/.test(productId) || seen.has(productId)) return;
      seen.add(productId);

      const productUrl = `https://www.aliexpress.com/item/${productId}.html`;

      // Climb to the shared editItemWrap container that holds both card and operator
      const card = operatorEl.closest('[class*="editItemWrap"]') || operatorEl.parentElement;

      // Title: span with class containing "sideTitleText"
      const titleEl = card ? card.querySelector('[class*="sideTitleText"]') : null;
      const title = titleEl ? titleEl.textContent.trim() : "";
      if (!title || title.length < 5) return;

      // Image: div with class containing "pictureUrl" uses CSS background-image
      const picEl = card ? card.querySelector('[class*="pictureUrl"]') : null;
      let imageUrl = null;
      if (picEl) {
        const style = picEl.getAttribute("style") || "";
        const match = style.match(/url\(["']?(.*?)["']?\)/);
        if (match) {
          imageUrl = match[1];
          if (imageUrl && imageUrl.startsWith("//")) imageUrl = "https:" + imageUrl;
        }
      }

      // Price: AliExpress renders price as individual char spans — grab textContent from wrapper
      const priceEl = card ? card.querySelector('[class*="price--price"]') : null;
      let price = null;
      if (priceEl) {
        const raw = priceEl.textContent.replace(/[^0-9.]/g, "");
        if (raw) {
          const parsed = parseFloat(raw);
          if (isFinite(parsed)) price = parsed;
        }
      }

      results.push({ title, image_url: imageUrl, price, ali_product_id: productId, product_url: productUrl });
    });

    return results;
  });
}

async function mainWishlist() {
  console.log("=== IMMIGRANT Store — AliExpress Wishlist Scraper ===\n");
  console.log("This scrapes your saved/favorites items from the AliExpress wishlist page.\n");
  console.log("Make sure Chrome is running with ./start-chrome.sh and you're logged in.\n");

  await waitForEnter("Press Enter when ready... ");

  ensureDir(CANDIDATES_IMAGES_DIR);

  const db = getDb();
  await initSchema(db);

  // Dedup against all existing candidates
  const existingRows = await queryAll(db, "SELECT ali_product_id FROM candidates WHERE ali_product_id IS NOT NULL");
  const existingIds = new Set(existingRows.map((r) => r.ali_product_id));

  let browser;
  try {
    console.log(`Connecting to Chrome at ${CDP_ENDPOINT}...`);
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    console.log("Connected!\n");
  } catch (err) {
    console.error("Failed to connect to Chrome. Run ./start-chrome.sh first.");
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const page = await context.newPage();

  try {
    console.log(`Navigating to ${WISHLIST_URL}...`);
    // Use networkidle: /p/wish-manage/ is a React SPA — domcontentloaded fires
    // before product cards render. networkidle waits for JS to settle.
    await page.goto(WISHLIST_URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(4000);

    // Login/redirect check
    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => "(no title)");
    console.log("Page loaded.");
    console.log("  Final URL:  ", currentUrl);
    console.log("  Page title: ", pageTitle);

    if (currentUrl.includes("login") || currentUrl.includes("passport") || currentUrl.includes("sign")) {
      console.log("\nRedirected to login — not logged in or session expired.");
      console.log("Log in to AliExpress in Chrome then run again.");
      await page.close();
      await browser.close();
      process.exit(1);
    }

    // --- Pre-scroll diagnostic: sample anchor hrefs and find scroll container ---
    const preDiag = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const sampleHrefs = anchors.slice(0, 20).map(a => a.href);

      // Find scrollable containers (overflowY auto/scroll, scrollHeight > clientHeight)
      const scrollable = [];
      document.querySelectorAll("div, section, ul, main").forEach(el => {
        const oy = window.getComputedStyle(el).overflowY;
        if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 50) {
          scrollable.push({
            tag: el.tagName,
            id: el.id || null,
            cls: (el.className || "").substring(0, 100),
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          });
        }
      });

      return { sampleHrefs, scrollable: scrollable.slice(0, 10) };
    });
    console.log("Sample hrefs (pre-scroll):", JSON.stringify(preDiag.sampleHrefs, null, 2));
    console.log("Scrollable containers:", JSON.stringify(preDiag.scrollable, null, 2));

    // --- Scroll inner container to trigger virtual list rendering ---
    // AliExpress /p/wish-manage/ uses an inner scrollable div, not window scroll.
    // Find it by overflow style; fall back to window if nothing found.
    console.log("Scrolling wishlist container...");
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        // Try known wish/manage/list selectors first
        const selectors = [
          '[class*="wish-list"]', '[class*="wishList"]', '[class*="wish_list"]',
          '[class*="manage-list"]', '[class*="manageList"]',
          '[class*="item-list"]', '[class*="itemList"]',
          '[class*="product-list"]', '[class*="productList"]',
          '[class*="scroll"]', '[class*="list-wrap"]',
        ];
        let container = null;
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.scrollHeight > el.clientHeight + 100) { container = el; break; }
        }
        // Fallback: tallest overflow-scroll div on the page
        if (!container) {
          let bestH = 0;
          document.querySelectorAll("div, section, ul").forEach(el => {
            const oy = window.getComputedStyle(el).overflowY;
            if ((oy === "auto" || oy === "scroll") && el.scrollHeight > bestH) {
              bestH = el.scrollHeight;
              container = el;
            }
          });
        }
        if (container) {
          container.scrollTop += container.clientHeight;
        } else {
          window.scrollBy(0, window.innerHeight);
        }
      });
      await page.waitForTimeout(1500);
    }
    // Scroll back to top so we capture items from the beginning
    await page.evaluate(() => {
      const selectors = [
        '[class*="wish-list"]', '[class*="wishList"]', '[class*="wish_list"]',
        '[class*="manage-list"]', '[class*="manageList"]',
        '[class*="item-list"]', '[class*="itemList"]',
        '[class*="scroll"]',
      ];
      let container = null;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight + 100) { container = el; break; }
      }
      if (!container) {
        let bestH = 0;
        document.querySelectorAll("div, section, ul").forEach(el => {
          const oy = window.getComputedStyle(el).overflowY;
          if ((oy === "auto" || oy === "scroll") && el.scrollHeight > bestH) {
            bestH = el.scrollHeight; container = el;
          }
        });
      }
      if (container) container.scrollTop = 0;
      else window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1500);

    // Scroll back down slowly so virtual list renders all items top-to-bottom
    console.log("Re-scrolling top-to-bottom to render all virtual list items...");
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => {
        let container = null;
        let bestH = 0;
        document.querySelectorAll("div, section, ul").forEach(el => {
          const oy = window.getComputedStyle(el).overflowY;
          if ((oy === "auto" || oy === "scroll") && el.scrollHeight > bestH) {
            bestH = el.scrollHeight; container = el;
          }
        });
        if (container) container.scrollTop += container.clientHeight * 0.8;
        else window.scrollBy(0, window.innerHeight * 0.8);
      });
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(1000);

    // Save debug HTML for selector inspection
    const debugHtml = await page.content();
    fs.writeFileSync(path.join(__dirname, "debug-wishlist.html"), debugHtml);
    console.log("Saved debug-wishlist.html for selector inspection.\n");

    // Diagnostics
    const diag = await page.evaluate(() => {
      const operatorEls = Array.from(document.querySelectorAll('[data-id^="operator_"]'));
      return {
        // Primary signal — wishlist uses data-id="operator_PRODUCTID", not <a href>
        operatorCards:   operatorEls.length,
        sampleProductIds: operatorEls.slice(0, 5).map(el => el.getAttribute("data-id").replace("operator_", "")),
        // Secondary signals
        infiniteScroll:  document.querySelectorAll('[class*="infinite-scroll"]').length,
        editItemWraps:   document.querySelectorAll('[class*="editItemWrap"]').length,
        allImgs:         document.querySelectorAll("img").length,
        allAnchors:      document.querySelectorAll("a[href]").length,
        // Legacy — expected to be 0 on wish-manage page
        itemLinks:       document.querySelectorAll('a[href*="/item/"]').length,
      };
    });
    console.log("Selector diagnostics:", JSON.stringify(diag, null, 2));

    if (diag.operatorCards === 0) {
      console.log("\nNo operator_ product cards found on page.");
      console.log("  Wishlist may be empty, or AliExpress changed the DOM structure.");
      console.log("  Check debug-wishlist.html and look for '[data-id^=operator_]' elements.");
      await page.close();
      await browser.close();
      return;
    }

    const products = await scrapeWishlistProducts(page);
    console.log(`Found ${products.length} wishlist products.\n`);

    if (products.length === 0) {
      console.log("Product extraction returned 0 items despite item links present.");
      console.log("Check debug-wishlist.html — title or card detection may need adjustment.");
      await page.close();
      await browser.close();
      return;
    }

    let added = 0;
    let skipped = 0;

    for (let i = 0; i < products.length; i++) {
      const p = products[i];

      if (p.ali_product_id && existingIds.has(p.ali_product_id)) {
        skipped++;
        console.log(`  [${i + 1}/${products.length}] SKIP (already in DB): ${p.title.substring(0, 55)}...`);
        continue;
      }

      let imagePath = null;
      if (p.image_url) {
        const filename = `wishlist_${sanitizeFilename(p.title)}_${Date.now()}.jpg`;
        const dest = path.join(CANDIDATES_IMAGES_DIR, filename);
        try {
          await downloadImage(p.image_url, dest);
          imagePath = path.relative(__dirname, dest);
        } catch (_) {}
      }

      // Gallery scrape — same path as suggested
      let allImages = null;
      let variantSpecifics = null;
      if (p.product_url) {
        const gallery = await scrapeProductGallery(page, p.product_url, p.ali_product_id);
        if (gallery.images.length > 0) allImages = JSON.stringify(gallery.images);
        if (Object.keys(gallery.variantMap).length > 0) variantSpecifics = JSON.stringify(gallery.variantMap);
      }

      const safePrice = (p.price != null && isFinite(p.price)) ? p.price : null;
      await run(db,
        "INSERT INTO candidates (title, image_url, image_path, source, ali_product_id, price, product_url, status, stage, all_images, variant_specifics) VALUES (?, ?, ?, 'wishlist', ?, ?, ?, 'new', 'intake', ?, ?)",
        [p.title, p.image_url, imagePath, p.ali_product_id, safePrice, p.product_url, allImages, variantSpecifics]
      );

      if (p.ali_product_id) existingIds.add(p.ali_product_id);
      added++;

      const galleryCount = allImages ? JSON.parse(allImages).length : 0;
      const shortTitle = p.title.substring(0, 55);
      const priceStr = p.price ? `$${p.price}` : "no price";
      console.log(`  [${i + 1}/${products.length}] ${shortTitle}... — ${priceStr} (${galleryCount} gallery imgs)`);
    }

    const countRow = await queryAll(db, "SELECT COUNT(*) as c FROM candidates");
    console.log(`\n=== Done! Added ${added} wishlist candidates, skipped ${skipped} duplicates ===`);
    console.log(`Total candidates: ${countRow[0].c}`);
  } catch (err) {
    console.error("Error during scraping:", err.message);
    try {
      const html = await page.content();
      fs.writeFileSync(path.join(__dirname, "debug-wishlist.html"), html);
      console.log("Saved debug-wishlist.html for inspection.");
    } catch (_) {}
  } finally {
    await page.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point — dispatch based on CLI argument
// ---------------------------------------------------------------------------

const mode = process.argv[2];
if (mode === "suggested") {
  mainSuggested();
} else if (mode === "wishlist") {
  mainWishlist();
} else {
  main();
}
