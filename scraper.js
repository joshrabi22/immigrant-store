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

// ---------------------------------------------------------------------------
// Scrape full product detail from individual product page.
// Returns gallery images + full structured SKU model (properties, values,
// image-to-variant mapping, prices per SKU combo).
//
// This is the critical layer for split-aware intake:
//   - properties[].values[].image → which images belong to which colorway
//   - skus[].propIds → which size+color combos exist and at what price
//   - imageGroups{} → color value ID → [image URLs] for that variant
//
// When a listing contains multiple real products (e.g. hat with "America"
// text vs hat with "Israel" text), imageGroups lets the split system
// carry the correct images and sizes to each child listing.
// ---------------------------------------------------------------------------

async function scrapeProductDetail(page, productUrl, productId) {
  try {
    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2500);

    const result = await page.evaluate(() => {
      const images = new Set();

      // --- Collect all candidate images from DOM ---
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

      // ==================================================================
      // PRIMARY: DOM-based SKU extraction (current AliExpress 2025-2026)
      // ==================================================================
      // AliExpress renders variant data as DOM elements with data attributes:
      //   data-sku-row="14"           → property ID (14=Color, 5=Size)
      //   data-sku-col="14-200004890" → property:value ID pair
      //
      // Each sku-item contains either:
      //   - An <img> with alt text → color/style variant with image
      //   - Text content          → size/option variant
      //
      // This is now the primary extraction method because AliExpress no
      // longer embeds skuModule JSON in script tags on most pages.
      // ==================================================================

      let skuModel = { properties: [], skus: [], imageGroups: {} };
      let imagePathList = [];

      // Well-known AliExpress property IDs → human-readable names
      const KNOWN_PROP_NAMES = {
        "14": "Color", "5": "Size", "200007763": "Shoe Size",
        "200000828": "Length", "200000828": "Shoe Width",
      };

      const skuRows = document.querySelectorAll("[data-sku-row]");
      const seenProps = new Set();

      skuRows.forEach((row) => {
        const propId = row.getAttribute("data-sku-row");
        if (!propId || seenProps.has(propId)) return;
        seenProps.add(propId);

        const values = [];
        const cols = row.querySelectorAll("[data-sku-col]");

        cols.forEach((col) => {
          const colId = col.getAttribute("data-sku-col") || "";
          // Format: "propertyId-valueId" e.g. "14-200004890"
          const dashIdx = colId.indexOf("-");
          const valueId = dashIdx >= 0 ? colId.substring(dashIdx + 1) : colId;

          const img = col.querySelector("img");
          const isDisabled = (col.className || "").includes("disabled");

          let name = "";
          let imgSrc = null;

          if (img) {
            name = img.alt || col.getAttribute("title") || "";
            imgSrc = img.src || img.getAttribute("data-src") || "";
          } else {
            name = col.getAttribute("title") || col.textContent.trim();
          }

          // Reconstruct full-size URL from thumbnail
          // AliExpress swatch thumbnails: hash.jpg_220x220q75.jpg_.avif → hash.jpg
          const toFullSize = (url) =>
            url.replace(/[._]\d+x\d+q?\d*\.(?:jpg|jpeg|png|webp)_?\.?(?:avif|webp|jpg|png)?$/i, "");

          const val = { id: valueId, name };
          if (imgSrc) {
            const fullSizeImg = toFullSize(imgSrc);
            val.image = fullSizeImg;
            val.thumbnailImage = imgSrc; // preserve original for reference
            images.add(fullSizeImg);
            // Build imageGroups: "propertyId:valueId" → [image URLs]
            const groupKey = propId + ":" + valueId;
            if (!skuModel.imageGroups[groupKey]) skuModel.imageGroups[groupKey] = [];
            skuModel.imageGroups[groupKey].push(fullSizeImg);
          }
          if (isDisabled) val.disabled = true;

          values.push(val);
        });

        if (values.length > 0) {
          // Determine property name: known ID, or infer from content
          let propName = KNOWN_PROP_NAMES[propId] || "";
          if (!propName) {
            propName = values.some((v) => v.image) ? "Color" : "Size";
          }

          skuModel.properties.push({
            id: parseInt(propId) || propId,
            name: propName,
            values,
          });
        }
      });

      // ==================================================================
      // FALLBACK: Script-tag JSON extraction (older AliExpress pages)
      // ==================================================================
      // Some pages still embed skuModule in script tags. Only use this
      // if the DOM extraction found zero properties.
      // ==================================================================

      const scripts = document.querySelectorAll("script");
      for (const script of scripts) {
        const text = script.textContent || "";
        if (text.length < 100) continue;

        // imagePathList: official ordered product gallery (still in scripts)
        const imgListMatch = text.match(/"imagePathList"\s*:\s*\[(.*?)\]/);
        if (imgListMatch) {
          const urls = imgListMatch[1].match(/"(https?:\/\/[^"]+)"/g);
          if (urls) {
            urls.forEach((u) => {
              const clean = u.replace(/"/g, "");
              images.add(clean);
              imagePathList.push(clean);
            });
          }
        }

        // Only parse skuModule from scripts if DOM extraction found nothing
        if (skuModel.properties.length === 0) {
          const skuModuleMatch = text.match(/"skuModule"\s*:\s*\{/);
          if (skuModuleMatch) {
            const propListMatch = text.match(/"productSKUPropertyList"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
            if (propListMatch) {
              try {
                const propList = JSON.parse(propListMatch[1]);
                for (const prop of propList) {
                  const property = { id: prop.skuPropertyId, name: prop.skuPropertyName || "", values: [] };
                  if (Array.isArray(prop.skuPropertyValues)) {
                    for (const val of prop.skuPropertyValues) {
                      const v = {
                        id: String(val.propertyValueId || val.propertyValueIdLong || ""),
                        name: val.propertyValueDisplayName || val.skuPropertyTips || val.propertyValueName || "",
                      };
                      if (val.skuPropertyImagePath) {
                        let img = val.skuPropertyImagePath;
                        if (img.startsWith("//")) img = "https:" + img;
                        v.image = img;
                        images.add(img);
                        const groupKey = String(prop.skuPropertyId) + ":" + v.id;
                        if (!skuModel.imageGroups[groupKey]) skuModel.imageGroups[groupKey] = [];
                        skuModel.imageGroups[groupKey].push(img);
                      }
                      property.values.push(v);
                    }
                  }
                  skuModel.properties.push(property);
                }
              } catch (e) { /* JSON parse failed */ }
            }

            const priceListMatch = text.match(/"skuPriceList"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
            if (priceListMatch) {
              try {
                const priceList = JSON.parse(priceListMatch[1]);
                for (const sku of priceList) {
                  const entry = { propIds: sku.skuPropIds || "" };
                  if (sku.skuVal) {
                    if (sku.skuVal.skuAmount) entry.price = sku.skuVal.skuAmount.value;
                    if (sku.skuVal.skuActivityAmount) entry.salePrice = sku.skuVal.skuActivityAmount.value;
                    if (sku.skuVal.availQuantity != null) entry.quantity = sku.skuVal.availQuantity;
                  }
                  skuModel.skus.push(entry);
                }
              } catch (e) { /* JSON parse failed */ }
            }
          }

          // Last-resort regex: skuPropertyId → image in raw text
          if (skuModel.properties.length === 0) {
            const skuBlocks = text.matchAll(/"skuPropertyId"\s*:\s*"([^"]+)"[^}]*?"skuPropertyName"\s*:\s*"([^"]*)"[^}]*?"skuPropertyImagePath"\s*:\s*"(https?:\/\/[^"]+)"/g);
            for (const m of skuBlocks) {
              const [_, propId, propName, imgUrl] = m;
              images.add(imgUrl);
              if (!skuModel.imageGroups[propId]) skuModel.imageGroups[propId] = [];
              skuModel.imageGroups[propId].push(imgUrl);
            }
          }

          if (skuModel.skus.length === 0) {
            const skuPrices = text.matchAll(/"skuPropIds"\s*:\s*"([^"]+)"/g);
            for (const m of skuPrices) skuModel.skus.push({ propIds: m[1] });
          }
        }
      }

      // ==================================================================
      // POST-EXTRACTION: Build SKU combo list from DOM property IDs
      // ==================================================================
      // If we got properties from DOM but no SKU combos from scripts,
      // generate all valid combos from the property value IDs.
      // Format: "14:200004890,5:361386" (color:value,size:value)
      // ==================================================================
      if (skuModel.properties.length > 0 && skuModel.skus.length === 0) {
        // Build all possible combinations
        const propArrays = skuModel.properties.map((p) =>
          p.values.filter((v) => !v.disabled).map((v) => String(p.id) + ":" + v.id)
        );
        // Cartesian product (max 2 properties — Color × Size)
        if (propArrays.length === 1) {
          skuModel.skus = propArrays[0].map((id) => ({ propIds: id }));
        } else if (propArrays.length === 2) {
          for (const a of propArrays[0]) {
            for (const b of propArrays[1]) {
              skuModel.skus.push({ propIds: a + "," + b });
            }
          }
        } else if (propArrays.length >= 3) {
          // 3+ properties — just pair them without full cartesian to avoid explosion
          for (const a of propArrays[0]) {
            for (const b of propArrays[1]) {
              skuModel.skus.push({ propIds: a + "," + b });
            }
          }
        }
      }

      // ==================================================================
      // FILTER & DEDUP images
      // ==================================================================
      const PAGE_CHROME = new Set([
        "Sa976459fb7724bf1bca6e153a425a8ebg","S9e723ca0d10848499e4e3fb33be2224do",
        "S64c04957a1244dffbab7086d6e1a7cad7","Sb100bd23552d499c9fa8e1499f3c46dbw",
        "S5c3261cf46fb47aa8c7f3abbdd792574S","Saf2ebe3af38947179531973d0d08ef74Y",
        "Sd8c759485ca2404d87d8f5d5ed0d98e0K","S16183c3f12904fbbaf3f8aef523f0b73T",
        "S9bad0c7ed77b4899ae22645df613a766r","Sa42ea28366094829a2e882420e1e269aJ",
        "S3f91b770226a464c8baf581b22e148f7Y","S5fde9fa3ffdb45cf908380fcc49bf6771",
        "Sa3e67595f2374efa9ce9f91574dc4650T",
        // Cross-product platform images (64x64/65x70 junk found across multiple products)
        "S98a18bcd33c34d28a0e5276b0aa20f48e","Hfff52cf71f784d99ad93c73a334e7e37a",
      ]);
      const extractHash = (u) => { const m = u.match(/\/kf\/([A-Za-z0-9_]+)/); return m ? m[1] : null; };

      const filtered = [...images].filter((url) => {
        if (!url || typeof url !== "string") return false;
        if (url.length < 30 || url.startsWith("data:")) return false;
        if (!url.includes("alicdn.com") && !url.includes("aliexpress-media.com")) return false;
        const h = extractHash(url);
        if (h && PAGE_CHROME.has(h)) return false;
        if (/\/\d{1,3}x\d{1,3}\.(?:png|jpg|gif)/i.test(url)) return false;
        if (/_\d{1,3}x\d{1,3}[._]/.test(url)) return false;
        if (/_\d{2,4}x\d{2,4}q\d+\.jpg/i.test(url)) return false;
        if (/\/ae-us\/.*?(category|nav|menu|header|footer)/i.test(url)) return false;
        if (/icon|sprite|logo|star|rating|arrow|button|banner|placeholder|avatar/i.test(url)) return false;
        return true;
      });

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

      // ==================================================================
      // BUILD legacy variantMap for backward compat
      // ==================================================================
      const variantMap = {};
      for (const prop of skuModel.properties) {
        for (const val of prop.values) {
          if (val.image) {
            const propKey = String(prop.id) + ":" + val.id;
            variantMap[val.image] = {
              propertyId: propKey,
              propertyName: val.name || "",
              sizes: [],
            };
            // Populate sizes: find SKU combos containing this color
            for (const sku of skuModel.skus) {
              const parts = (sku.propIds || "").split(",");
              if (parts.includes(propKey) || parts[0] === propKey) {
                const sizeParts = parts.filter((p) => p !== propKey);
                if (sizeParts.length > 0) variantMap[val.image].sizes.push(sizeParts.join(","));
              }
            }
          }
        }
      }

      return {
        images: deduped,
        imagePathList,
        variantMap,
        skuModel,
      };
    });

    // ==================================================================
    // POST-EXTRACTION: Per-color price + filmstrip enrichment
    // ==================================================================
    // Click each color swatch via CDP, read live price + filmstrip images.
    // This captures per-color price differences and per-color gallery images
    // that are only revealed when the user clicks a swatch.
    // ==================================================================
    const colorProp = result.skuModel.properties.find(
      (p) => p.values.some((v) => v.image)
    );
    if (colorProp && colorProp.values.length > 0) {
      const perColorData = {};
      for (const val of colorProp.values) {
        const colId = `${colorProp.id}-${val.id}`;
        try {
          // Click the swatch
          await page.click(`[data-sku-col="${colId}"]`);
          await page.waitForTimeout(800);

          // Read price + filmstrip + size availability from the live page state
          const snapshot = await page.evaluate(() => {
            const curEl = document.querySelector(".price-default--current--F8OlYIo");
            const origEl = document.querySelector(".price-default--original--CWcHOit");
            const curText = curEl ? curEl.textContent.trim() : null;
            const origText = origEl ? origEl.textContent.trim() : null;

            // Parse numeric price from text like "₪124.47" or "$15.99"
            const parsePrice = (t) => {
              if (!t) return null;
              const m = t.replace(/[^\d.,]/g, "").replace(",", ".");
              const n = parseFloat(m);
              return isNaN(n) ? null : n;
            };

            // Capture filmstrip: small thumbnail images (50-100px width)
            const filmHashes = [];
            const seen = new Set();
            document.querySelectorAll("img").forEach((img) => {
              const src = img.src || "";
              const hash = (src.match(/\/kf\/([^/.]+)/) || [])[1] || "";
              if (hash && !seen.has(hash) && img.naturalWidth >= 50 && img.naturalWidth <= 100) {
                seen.add(hash);
                filmHashes.push(hash);
              }
            });

            // Also capture the hero image hash (the large one)
            let heroHash = "";
            document.querySelectorAll("img").forEach((img) => {
              if (!heroHash && img.src.includes("/kf/") && img.naturalWidth >= 300) {
                heroHash = (img.src.match(/\/kf\/([^/.]+)/) || [])[1] || "";
              }
            });

            // Capture live size availability for the currently selected color.
            // AliExpress uses sku-item--soldOut-- class on size buttons that are
            // out of stock for the selected color. This differs per color swatch.
            const liveSizes = [];
            document.querySelectorAll('[data-sku-row="5"] [data-sku-col]').forEach((col) => {
              const colId = col.getAttribute("data-sku-col") || "";
              const dashIdx = colId.indexOf("-");
              const valueId = dashIdx >= 0 ? colId.substring(dashIdx + 1) : colId;
              const name = col.getAttribute("title") || col.textContent.trim();
              const cls = col.className || "";
              const isSoldOut = /sku-item--soldOut--/.test(cls);
              const isDisabled = /sku-item--disabled--/.test(cls) || cls.includes("disabled");
              liveSizes.push({ id: valueId, name, available: !isSoldOut && !isDisabled });
            });

            return {
              currentPrice: parsePrice(curText),
              currentPriceText: curText,
              originalPrice: parsePrice(origText),
              originalPriceText: origText,
              filmstripHashes: filmHashes,
              heroHash,
              liveSizes,
            };
          });

          perColorData[val.id] = snapshot;
        } catch (e) {
          // Swatch click failed — non-fatal, continue to next color
          console.log(`  [variant] click failed for ${colId}: ${e.message}`);
        }
      }

      // Enrich the skuModel with per-color price, filmstrip, and size availability
      const colorGroupPrices = {};
      const colorGroupFilmstrips = {};
      const colorGroupSizes = {};
      let allFilmstripsSame = true;
      let firstFilmstrip = null;
      let allSizesSame = true;
      let firstSizeSet = null;

      for (const val of colorProp.values) {
        const data = perColorData[val.id];
        if (!data) continue;

        const groupKey = `${colorProp.id}:${val.id}`;

        // Attach per-color price
        if (data.currentPrice != null) {
          colorGroupPrices[groupKey] = {
            current: data.currentPrice,
            original: data.originalPrice,
            currentText: data.currentPriceText,
          };
        }

        // Attach per-color filmstrip (filtered through existing junk filter)
        if (data.filmstripHashes.length > 0) {
          colorGroupFilmstrips[groupKey] = data.filmstripHashes;
          if (!firstFilmstrip) {
            firstFilmstrip = JSON.stringify(data.filmstripHashes);
          } else if (JSON.stringify(data.filmstripHashes) !== firstFilmstrip) {
            allFilmstripsSame = false;
          }
        }

        // Attach per-color live size availability
        // liveSizes: [{ id, name, available }] — from clicking this color swatch
        if (data.liveSizes && data.liveSizes.length > 0) {
          const availableIds = data.liveSizes
            .filter((s) => s.available)
            .map((s) => ({ id: s.id, name: s.name }));
          const soldOutIds = data.liveSizes
            .filter((s) => !s.available)
            .map((s) => ({ id: s.id, name: s.name }));
          colorGroupSizes[groupKey] = {
            available: availableIds,
            soldOut: soldOutIds,
          };
          const availKey = availableIds.map((s) => s.id).join(",");
          if (!firstSizeSet) {
            firstSizeSet = availKey;
          } else if (availKey !== firstSizeSet) {
            allSizesSame = false;
          }
        }
      }

      // Store in skuModel
      if (Object.keys(colorGroupPrices).length > 0) {
        result.skuModel.colorPrices = colorGroupPrices;
      }

      // Only store per-color filmstrips if they actually differ across colors
      if (!allFilmstripsSame && Object.keys(colorGroupFilmstrips).length > 0) {
        result.skuModel.colorFilmstrips = colorGroupFilmstrips;
      }

      // Store per-color size availability.
      // Always store when captured — even if identical across colors, the split
      // endpoint needs explicit available sizes per color, not just the union.
      // The allSizesSame flag lets consumers know if sizes vary by color.
      if (Object.keys(colorGroupSizes).length > 0) {
        result.skuModel.colorSizes = colorGroupSizes;
        result.skuModel.sizesVaryByColor = !allSizesSame;
      }
    }

    return result;
  } catch (err) {
    console.log(`  Gallery scrape failed for ${productId}: ${err.message}`);
    return { images: [], imagePathList: [], variantMap: {}, skuModel: { properties: [], skus: [], imageGroups: {} } };
  }
}

// Backward-compat wrapper — existing callers (suggested scrape) use this name
async function scrapeProductGallery(page, productUrl, productId) {
  const detail = await scrapeProductDetail(page, productUrl, productId);
  return { images: detail.images, variantMap: detail.variantMap };
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

// ---------------------------------------------------------------------------
// Helper: find the wishlist scroll container
// AliExpress /p/wish-manage/ is a React SPA with a virtual-list inside a
// scrollable div. Items only exist in DOM while visible. We must scroll
// incrementally and scrape at each position.
// ---------------------------------------------------------------------------
function findScrollContainerJS() {
  // Return JS code string to find the scroll container
  return `
    (() => {
      const selectors = [
        '[class*="wish-list"]', '[class*="wishList"]', '[class*="wish_list"]',
        '[class*="manage-list"]', '[class*="manageList"]',
        '[class*="item-list"]', '[class*="itemList"]',
        '[class*="product-list"]', '[class*="productList"]',
        '[class*="scroll"]', '[class*="list-wrap"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight + 100) return el;
      }
      let best = null, bestH = 0;
      document.querySelectorAll("div, section, ul").forEach(el => {
        const oy = window.getComputedStyle(el).overflowY;
        if ((oy === "auto" || oy === "scroll") && el.scrollHeight > bestH) {
          bestH = el.scrollHeight; best = el;
        }
      });
      return best;
    })()
  `;
}

async function mainWishlist() {
  console.log("=== IMMIGRANT Store — AliExpress Wishlist Scraper (Full Paginated) ===\n");
  console.log("This scrapes your FULL wishlist from AliExpress.\n");
  console.log("Make sure Chrome is running with ./start-chrome.sh and you're logged in.\n");

  await waitForEnter("Press Enter when ready... ");

  ensureDir(CANDIDATES_IMAGES_DIR);

  const db = getDb();
  await initSchema(db);

  // Dedup against all existing candidates (cross-source to prevent any duplicate product)
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

    // --- EXHAUSTIVE SCROLL-AND-SCRAPE ---
    // Virtual list only renders visible items. We scroll through the entire
    // list, scraping at each position, collecting unique product IDs.
    // Stop after 3 consecutive scrolls yield zero new items.
    console.log("\nStarting exhaustive scroll-and-scrape...");
    const allProducts = new Map(); // ali_product_id → product data
    let noNewRounds = 0;
    const MAX_NO_NEW = 4; // stop after 4 scrolls with no new items
    let scrollRound = 0;

    // Initial scrape at current position
    const initial = await scrapeWishlistProducts(page);
    for (const p of initial) {
      if (p.ali_product_id && !allProducts.has(p.ali_product_id)) {
        allProducts.set(p.ali_product_id, p);
      }
    }
    console.log(`  Round 0: ${initial.length} visible, ${allProducts.size} unique total`);

    while (noNewRounds < MAX_NO_NEW) {
      scrollRound++;

      // Scroll down one viewport in the container
      await page.evaluate(() => {
        const container = (() => {
          const selectors = [
            '[class*="wish-list"]', '[class*="wishList"]', '[class*="wish_list"]',
            '[class*="manage-list"]', '[class*="manageList"]',
            '[class*="item-list"]', '[class*="itemList"]',
            '[class*="product-list"]', '[class*="productList"]',
            '[class*="scroll"]', '[class*="list-wrap"]',
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.scrollHeight > el.clientHeight + 100) return el;
          }
          let best = null, bestH = 0;
          document.querySelectorAll("div, section, ul").forEach(el => {
            const oy = window.getComputedStyle(el).overflowY;
            if ((oy === "auto" || oy === "scroll") && el.scrollHeight > bestH) {
              bestH = el.scrollHeight; best = el;
            }
          });
          return best;
        })();
        if (container) container.scrollTop += container.clientHeight * 0.8;
        else window.scrollBy(0, window.innerHeight * 0.8);
      });
      await page.waitForTimeout(1500);

      // Scrape visible items at this scroll position
      const visible = await scrapeWishlistProducts(page);
      let newCount = 0;
      for (const p of visible) {
        if (p.ali_product_id && !allProducts.has(p.ali_product_id)) {
          allProducts.set(p.ali_product_id, p);
          newCount++;
        }
      }

      if (newCount === 0) {
        noNewRounds++;
      } else {
        noNewRounds = 0;
      }

      console.log(`  Round ${scrollRound}: ${visible.length} visible, +${newCount} new, ${allProducts.size} unique total (noNew: ${noNewRounds}/${MAX_NO_NEW})`);
    }

    const products = Array.from(allProducts.values());
    console.log(`\n=== Wishlist discovery complete: ${products.length} unique products found ===\n`);

    // Save debug HTML
    const debugHtml = await page.content();
    fs.writeFileSync(path.join(__dirname, "debug-wishlist.html"), debugHtml);
    console.log("Saved debug-wishlist.html\n");

    if (products.length === 0) {
      console.log("No products found. Check debug-wishlist.html.");
      await page.close();
      await browser.close();
      return;
    }

    // --- INGEST EACH PRODUCT ---
    // For each unique product: dedup check, download hero, scrape full gallery + SKU model.
    let added = 0;
    let skipped = 0;
    const skippedItems = [];

    for (let i = 0; i < products.length; i++) {
      const p = products[i];

      // Duplicate check: skip if already in DB (any source)
      if (p.ali_product_id && existingIds.has(p.ali_product_id)) {
        skipped++;
        skippedItems.push({ id: p.ali_product_id, title: p.title.substring(0, 50), reason: "already in DB" });
        console.log(`  [${i + 1}/${products.length}] SKIP (dup): ${p.title.substring(0, 55)}...`);
        continue;
      }

      // Download hero image locally
      let imagePath = null;
      if (p.image_url) {
        const filename = `wishlist_${sanitizeFilename(p.title)}_${Date.now()}.jpg`;
        const dest = path.join(CANDIDATES_IMAGES_DIR, filename);
        try {
          await downloadImage(p.image_url, dest);
          imagePath = path.relative(__dirname, dest);
        } catch (_) {}
      }

      // Full product page scrape: gallery + SKU model
      let allImages = null;
      let variantSpecifics = null;
      let skuDataStr = null;
      if (p.product_url) {
        const detail = await scrapeProductDetail(page, p.product_url, p.ali_product_id);
        if (detail.images.length > 0) allImages = JSON.stringify(detail.images);

        // Build enhanced variant_specifics (version 2 format)
        const hasProperties = detail.skuModel.properties.length > 0;
        const hasSkus = detail.skuModel.skus.length > 0;
        const hasImageGroups = Object.keys(detail.skuModel.imageGroups).length > 0;
        const hasLegacy = Object.keys(detail.variantMap).length > 0;

        if (hasProperties || hasSkus || hasImageGroups || hasLegacy) {
          const v2Data = {
            version: 2,
            properties: detail.skuModel.properties,
            skus: detail.skuModel.skus,
            imageGroups: detail.skuModel.imageGroups,
            // Keep legacy variantMap for backward compat
            _legacyVariantMap: hasLegacy ? detail.variantMap : undefined,
          };
          // Per-color price (only present when prices differ by colorway)
          if (detail.skuModel.colorPrices) {
            v2Data.colorPrices = detail.skuModel.colorPrices;
          }
          // Per-color filmstrip (only present when filmstrip differs by colorway)
          if (detail.skuModel.colorFilmstrips) {
            v2Data.colorFilmstrips = detail.skuModel.colorFilmstrips;
          }
          // Per-color size availability (live sold-out detection per color swatch)
          if (detail.skuModel.colorSizes) {
            v2Data.colorSizes = detail.skuModel.colorSizes;
            v2Data.sizesVaryByColor = detail.skuModel.sizesVaryByColor || false;
          }
          variantSpecifics = JSON.stringify(v2Data);
        }
      }

      const safePrice = (p.price != null && isFinite(p.price)) ? p.price : null;
      await run(db,
        `INSERT INTO candidates (title, image_url, image_path, source, ali_product_id, price, product_url,
         status, stage, all_images, variant_specifics, created_at)
         VALUES (?, ?, ?, 'wishlist', ?, ?, ?, 'new', 'intake', ?, ?, ?)`,
        [p.title, p.image_url, imagePath, p.ali_product_id, safePrice, p.product_url,
         allImages, variantSpecifics, new Date().toISOString()]
      );

      if (p.ali_product_id) existingIds.add(p.ali_product_id);
      added++;

      const galleryCount = allImages ? JSON.parse(allImages).length : 0;
      const variantCount = variantSpecifics ? JSON.parse(variantSpecifics).properties?.length || 0 : 0;
      const skuCount = variantSpecifics ? JSON.parse(variantSpecifics).skus?.length || 0 : 0;
      const shortTitle = p.title.substring(0, 50);
      const priceStr = p.price ? `$${p.price}` : "no price";
      console.log(`  [${i + 1}/${products.length}] ${shortTitle}... — ${priceStr} (${galleryCount} imgs, ${variantCount} props, ${skuCount} skus)`);
    }

    // --- SUMMARY ---
    const countRow = await queryAll(db, "SELECT COUNT(*) as c FROM candidates");
    const wishlistCount = await queryAll(db, "SELECT COUNT(*) as c FROM candidates WHERE source = 'wishlist'");
    console.log(`\n=== WISHLIST SCRAPE COMPLETE ===`);
    console.log(`  Discovered:  ${products.length} unique products`);
    console.log(`  Added:       ${added} new candidates`);
    console.log(`  Skipped:     ${skipped} duplicates`);
    console.log(`  Total DB:    ${countRow[0].c} candidates`);
    console.log(`  Wishlist DB: ${wishlistCount[0].c} wishlist candidates`);
    console.log(`  Scroll rounds: ${scrollRound}`);
    console.log(`  Scrape status: COMPLETE (exhausted after ${MAX_NO_NEW} consecutive no-new scrolls)`);

    if (skippedItems.length > 0) {
      console.log(`\n  Skipped items:`);
      for (const s of skippedItems) {
        console.log(`    - [${s.id}] ${s.title} (${s.reason})`);
      }
    }
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
