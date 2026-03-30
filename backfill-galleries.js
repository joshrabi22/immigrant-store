#!/usr/bin/env node
/**
 * backfill-galleries.js — One-time backfill for staged items missing gallery data
 *
 * Visits AliExpress product pages via CDP (Chrome DevTools Protocol) and captures
 * full gallery + SKU data for staged items that currently only have a hero image.
 *
 * Prerequisites:
 *   - Chrome with CDP enabled: open -a "Google Chrome" --args --remote-debugging-port=9222
 *   - Logged into AliExpress in that Chrome session
 *   - Local SQLite mode: TURSO_DATABASE_URL= node backfill-galleries.js
 *
 * Behavior:
 *   - Only touches items where all_images is NULL, empty, or corrupted JSON
 *   - Only touches items with ali_product_id (can construct product URL)
 *   - Updates all_images and variant_specifics — does NOT change stage, status, or other fields
 *   - Logs every action for auditability
 *   - Idempotent: safe to re-run (skips items that already have good gallery data)
 *
 * Usage:
 *   TURSO_DATABASE_URL= node backfill-galleries.js           # backfill all eligible staged items
 *   TURSO_DATABASE_URL= node backfill-galleries.js --dry-run  # preview what would be backfilled
 *   TURSO_DATABASE_URL= node backfill-galleries.js --id 286   # backfill a single item by ID
 */

const { chromium } = require("playwright");
const { getDb, queryAll, run, initSchema } = require("./db");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

const DRY_RUN = process.argv.includes("--dry-run");
const SINGLE_ID = process.argv.includes("--id")
  ? parseInt(process.argv[process.argv.indexOf("--id") + 1], 10)
  : null;

const CANDIDATES_IMAGES_DIR = path.join(__dirname, "images", "candidates");

// ---------------------------------------------------------------------------
// Image download helper (same as scraper.js)
// ---------------------------------------------------------------------------
function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    if (url.startsWith("//")) url = "https:" + url;
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    client
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          return downloadImage(res.headers.location, dest).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", (err) => {
          fs.unlinkSync(dest);
          reject(err);
        });
      })
      .on("error", (err) => {
        fs.unlinkSync(dest);
        reject(err);
      });
  });
}

// ---------------------------------------------------------------------------
// Sanitize filename (same as scraper.js)
// ---------------------------------------------------------------------------
function sanitizeFilename(title) {
  return title
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .substring(0, 60)
    .replace(/_+$/, "");
}

// ---------------------------------------------------------------------------
// scrapeProductDetail — identical to scraper.js scrapeProductDetail()
// Extracted here to avoid modifying scraper.js exports.
// ---------------------------------------------------------------------------
async function scrapeProductDetail(page, productUrl, productId) {
  try {
    await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2500);

    // Expand View More inside SKU rows (scoped, safe)
    try {
      const expanded = await page.evaluate(() => {
        let count = 0;
        document.querySelectorAll("[data-sku-row]").forEach((row) => {
          row.querySelectorAll('[class*="viewMore"], [class*="ViewMore"], [class*="view-more"]').forEach((btn) => {
            const cls = (btn.className || "") + " " + (btn.textContent || "");
            if (/wish|heart|fav|collect|remove|delete|trash/i.test(cls)) return;
            btn.click();
            count++;
          });
        });
        return count;
      });
      if (expanded > 0) {
        console.log(`  [${productId}] Expanded ${expanded} SKU "View More" overlay(s)`);
        await page.waitForTimeout(600);
      }
    } catch (_) {}

    const result = await page.evaluate(() => {
      const images = new Set();

      // Collect all candidate images from DOM
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

      // DOM-based SKU extraction
      let skuModel = { properties: [], skus: [], imageGroups: {} };
      let imagePathList = [];

      const KNOWN_PROP_NAMES = {
        "14": "Color", "5": "Size", "200007763": "Shoe Size",
        "200000828": "Length",
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

          const toFullSize = (url) =>
            url.replace(/[._]\d+x\d+q?\d*\.(?:jpg|jpeg|png|webp)_?\.?(?:avif|webp|jpg|png)?$/i, "");
          // Check if URL is a tiny-dimension filename (e.g. /60x60.png)
          const isTinyDimFile = (url) => {
            const dm = url.match(/\/(\d+)x(\d+)\.\w+$/);
            return dm && (parseInt(dm[1]) < 400 || parseInt(dm[2]) < 400);
          };

          const val = { id: valueId, name };
          if (imgSrc) {
            const fullSizeImg = toFullSize(imgSrc);
            // Skip tiny dimension filenames like /60x60.png — these are not product images
            if (!isTinyDimFile(fullSizeImg)) {
              val.image = fullSizeImg;
              val.thumbnailImage = imgSrc;
              images.add(fullSizeImg);
              const groupKey = propId + ":" + valueId;
              if (!skuModel.imageGroups[groupKey]) skuModel.imageGroups[groupKey] = [];
              skuModel.imageGroups[groupKey].push(fullSizeImg);
            }
          }
          if (isDisabled) val.disabled = true;

          values.push(val);
        });

        if (values.length > 0) {
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

      // Fallback: Script-tag JSON extraction
      const scripts = document.querySelectorAll("script");
      for (const script of scripts) {
        const text = script.textContent || "";
        if (text.length < 100) continue;

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
              } catch (e) {}
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
              } catch (e) {}
            }
          }

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

      // Build SKU combos from DOM properties if not found in scripts
      if (skuModel.properties.length > 0 && skuModel.skus.length === 0) {
        const propArrays = skuModel.properties.map((p) =>
          p.values.filter((v) => !v.disabled).map((v) => String(p.id) + ":" + v.id)
        );
        if (propArrays.length === 1) {
          skuModel.skus = propArrays[0].map((id) => ({ propIds: id }));
        } else if (propArrays.length >= 2) {
          for (const a of propArrays[0]) {
            for (const b of propArrays[1]) {
              skuModel.skus.push({ propIds: a + "," + b });
            }
          }
        }
      }

      // Filter & dedup
      const PAGE_CHROME = new Set([
        "Sa976459fb7724bf1bca6e153a425a8ebg","S9e723ca0d10848499e4e3fb33be2224do",
        "S64c04957a1244dffbab7086d6e1a7cad7","Sb100bd23552d499c9fa8e1499f3c46dbw",
        "S5c3261cf46fb47aa8c7f3abbdd792574S","Saf2ebe3af38947179531973d0d08ef74Y",
        "Sd8c759485ca2404d87d8f5d5ed0d98e0K","S16183c3f12904fbbaf3f8aef523f0b73T",
        "S9bad0c7ed77b4899ae22645df613a766r","Sa42ea28366094829a2e882420e1e269aJ",
        "S3f91b770226a464c8baf581b22e148f7Y","S5fde9fa3ffdb45cf908380fcc49bf6771",
        "Sa3e67595f2374efa9ce9f91574dc4650T",
        "S98a18bcd33c34d28a0e5276b0aa20f48e","Hfff52cf71f784d99ad93c73a334e7e37a",
      ]);
      const extractHash = (u) => { const m = u.match(/\/kf\/([A-Za-z0-9_]+)/); return m ? m[1] : null; };

      const filtered = [...images].filter((url) => {
        if (!url || typeof url !== "string") return false;
        if (url.length < 30 || url.startsWith("data:")) return false;
        if (!url.includes("alicdn.com") && !url.includes("aliexpress-media.com")) return false;
        if (!url.includes("/kf/")) return false;
        const h = extractHash(url);
        if (h && PAGE_CHROME.has(h)) return false;
        if (/\/\d{1,3}x\d{1,3}\.(?:png|jpg|gif)/i.test(url)) return false;
        if (/_\d{1,3}x\d{1,3}[._]/.test(url)) return false;
        if (/_\d{2,4}x\d{2,4}q\d+\.jpg/i.test(url)) return false;
        if (/\/ae-us\/.*?(category|nav|menu|header|footer)/i.test(url)) return false;
        if (/icon|sprite|logo|star|rating|arrow|button|banner|placeholder|avatar/i.test(url)) return false;
        const tbDimMatch = url.match(/TB\w+-(\d+)-(\d+)\.\w+$/);
        if (tbDimMatch && (parseInt(tbDimMatch[1]) < 300 || parseInt(tbDimMatch[2]) < 300)) return false;
        return true;
      });

      const seen = new Set();
      const deduped = filtered.filter((url) => {
        const h = extractHash(url);
        const key = h ? h.toLowerCase() : url.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      // Legacy variantMap
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

      return { images: deduped, imagePathList, variantMap, skuModel };
    });

    // Per-color price + filmstrip enrichment via swatch clicking
    const colorProp = result.skuModel.properties.find(
      (p) => p.values.some((v) => v.image)
    );
    if (colorProp && colorProp.values.length > 0) {
      // Re-expand View More
      try {
        await page.evaluate(() => {
          document.querySelectorAll("[data-sku-row]").forEach((row) => {
            row.querySelectorAll('[class*="viewMore"], [class*="ViewMore"], [class*="view-more"]').forEach((btn) => {
              const cls = (btn.className || "") + " " + (btn.textContent || "");
              if (/wish|heart|fav|collect|remove|delete|trash/i.test(cls)) return;
              btn.click();
            });
          });
        });
        await page.waitForTimeout(300);
      } catch (_) {}

      const perColorData = {};
      for (const val of colorProp.values) {
        const colId = `${colorProp.id}-${val.id}`;
        try {
          const clicked = await page.evaluate((cid) => {
            const el = document.querySelector(`[data-sku-col="${cid}"]`);
            if (!el) return false;
            const row = el.closest("[data-sku-row]");
            if (!row) return false;
            el.click();
            return true;
          }, colId);

          if (!clicked) continue;
          await page.waitForTimeout(800);

          const snapshot = await page.evaluate(() => {
            const curEl = document.querySelector(".price-default--current--F8OlYIo");
            const origEl = document.querySelector(".price-default--original--CWcHOit");
            const curText = curEl ? curEl.textContent.trim() : null;
            const origText = origEl ? origEl.textContent.trim() : null;

            const parsePrice = (t) => {
              if (!t) return null;
              const m = t.replace(/[^\d.,]/g, "").replace(",", ".");
              const n = parseFloat(m);
              return isNaN(n) ? null : n;
            };

            const filmUrls = [];
            const filmSeen = new Set();
            const FILM_JUNK = new Set([
              "Sa976459fb7724bf1bca6e153a425a8ebg","S9e723ca0d10848499e4e3fb33be2224do",
              "S64c04957a1244dffbab7086d6e1a7cad7","Sb100bd23552d499c9fa8e1499f3c46dbw",
              "S5c3261cf46fb47aa8c7f3abbdd792574S","Saf2ebe3af38947179531973d0d08ef74Y",
              "Sd8c759485ca2404d87d8f5d5ed0d98e0K","S16183c3f12904fbbaf3f8aef523f0b73T",
              "S9bad0c7ed77b4899ae22645df613a766r","Sa42ea28366094829a2e882420e1e269aJ",
              "S3f91b770226a464c8baf581b22e148f7Y","S5fde9fa3ffdb45cf908380fcc49bf6771",
              "Sa3e67595f2374efa9ce9f91574dc4650T",
              "S98a18bcd33c34d28a0e5276b0aa20f48e","Hfff52cf71f784d99ad93c73a334e7e37a",
            ]);
            document.querySelectorAll("img").forEach((img) => {
              const src = img.src || "";
              if (!src.includes("/kf/")) return;
              const hash = (src.match(/\/kf\/([^/.]+)/) || [])[1] || "";
              if (!hash || filmSeen.has(hash) || FILM_JUNK.has(hash)) return;
              if (img.naturalWidth >= 50 && img.naturalWidth <= 100) {
                filmSeen.add(hash);
                const fullUrl = src.replace(/[._]\d+x\d+q?\d*\.(?:jpg|jpeg|png|webp)_?\.?(?:avif|webp|jpg|png)?$/i, "");
                // Reject tiny-dimension filenames like /60x60.png after the /kf/hash/ path
                const dimMatch = fullUrl.match(/\/(\d+)x(\d+)\.\w+$/);
                if (dimMatch && (parseInt(dimMatch[1]) < 400 || parseInt(dimMatch[2]) < 400)) return;
                filmUrls.push(fullUrl);
              }
            });

            let heroHash = "";
            document.querySelectorAll("img").forEach((img) => {
              if (!heroHash && img.src.includes("/kf/") && img.naturalWidth >= 300) {
                heroHash = (img.src.match(/\/kf\/([^/.]+)/) || [])[1] || "";
              }
            });

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
              filmstripUrls: filmUrls,
              heroHash,
              liveSizes,
            };
          });

          perColorData[val.id] = snapshot;
        } catch (e) {
          console.log(`  [variant] click failed for ${colId}: ${e.message}`);
        }
      }

      // Enrich skuModel
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

        if (data.currentPrice != null) {
          colorGroupPrices[groupKey] = {
            current: data.currentPrice,
            original: data.originalPrice,
            currentText: data.currentPriceText,
          };
        }

        if (data.filmstripUrls && data.filmstripUrls.length > 0) {
          const cleanFilm = data.filmstripUrls.filter((u) => {
            const dm = u.match(/\/(\d+)x(\d+)\.\w+$/);
            return !(dm && (parseInt(dm[1]) < 400 || parseInt(dm[2]) < 400));
          });
          if (cleanFilm.length > 0) {
            colorGroupFilmstrips[groupKey] = cleanFilm;
            if (!firstFilmstrip) {
              firstFilmstrip = JSON.stringify(cleanFilm);
            } else if (JSON.stringify(cleanFilm) !== firstFilmstrip) {
              allFilmstripsSame = false;
            }
          }
        }

        if (data.liveSizes && data.liveSizes.length > 0) {
          const availableIds = data.liveSizes.filter((s) => s.available).map((s) => ({ id: s.id, name: s.name }));
          const soldOutIds = data.liveSizes.filter((s) => !s.available).map((s) => ({ id: s.id, name: s.name }));
          colorGroupSizes[groupKey] = { available: availableIds, soldOut: soldOutIds };
          const availKey = availableIds.map((s) => s.id).join(",");
          if (!firstSizeSet) {
            firstSizeSet = availKey;
          } else if (availKey !== firstSizeSet) {
            allSizesSame = false;
          }
        }
      }

      if (Object.keys(colorGroupPrices).length > 0) {
        result.skuModel.colorPrices = colorGroupPrices;
      }
      if (Object.keys(colorGroupFilmstrips).length > 0) {
        result.skuModel.colorFilmstrips = colorGroupFilmstrips;
        result.skuModel.filmstripsVaryByColor = !allFilmstripsSame;
      }

      // Merge filmstrip images into result.images (with junk filtering)
      const existingHashes = new Set(
        result.images.map((u) => {
          const m = u.match(/\/kf\/([A-Za-z0-9_]+)/);
          return m ? m[1].toLowerCase() : u.toLowerCase();
        })
      );
      for (const urls of Object.values(colorGroupFilmstrips)) {
        for (const url of urls) {
          // Skip tiny-dimension filenames like /60x60.png (under 400px)
          const dimM = url.match(/\/(\d+)x(\d+)\.\w+$/);
          if (dimM && (parseInt(dimM[1]) < 400 || parseInt(dimM[2]) < 400)) continue;
          const m = url.match(/\/kf\/([A-Za-z0-9_]+)/);
          const key = m ? m[1].toLowerCase() : url.toLowerCase();
          if (!existingHashes.has(key)) {
            existingHashes.add(key);
            result.images.push(url);
          }
        }
      }

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

// ---------------------------------------------------------------------------
// Check if all_images is missing, empty, or corrupted
// ---------------------------------------------------------------------------
function needsBackfill(allImagesRaw) {
  if (!allImagesRaw || allImagesRaw.trim() === "" || allImagesRaw.trim() === "[]" || allImagesRaw.trim() === "null") {
    return { needs: true, reason: "empty/null" };
  }
  try {
    const imgs = JSON.parse(allImagesRaw);
    if (!Array.isArray(imgs) || imgs.length <= 1) {
      return { needs: true, reason: `only ${Array.isArray(imgs) ? imgs.length : 0} images` };
    }
    return { needs: false };
  } catch (e) {
    return { needs: true, reason: `corrupted JSON: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Also upgrade hero image_url from thumbnail to full-size if needed
// ---------------------------------------------------------------------------
function upgradeHeroUrl(imageUrl) {
  if (!imageUrl) return imageUrl;
  // Strip thumbnail suffix like _220x220.jpg or _220x220q75.jpg_.avif
  return imageUrl.replace(/[._]\d+x\d+q?\d*\.(?:jpg|jpeg|png|webp)_?\.?(?:avif|webp|jpg|png)?$/i, "");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== BACKFILL GALLERIES — One-time staged item repair ===");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  if (SINGLE_ID) console.log(`Target: single item ID ${SINGLE_ID}`);
  console.log();

  const db = getDb();
  await initSchema(db);

  // Find all staged items needing backfill
  let rows;
  if (SINGLE_ID) {
    rows = await queryAll(db,
      `SELECT id, ali_product_id, product_url, image_url, image_path, all_images, title, source
       FROM candidates WHERE id = ?`, [SINGLE_ID]);
  } else {
    rows = await queryAll(db,
      `SELECT id, ali_product_id, product_url, image_url, image_path, all_images, title, source
       FROM candidates WHERE stage = 'staged' ORDER BY id ASC`);
  }

  // Separate into categories
  const backfillable = [];  // Has ali_product_id, needs gallery
  const noProductId = [];   // Past orders without product ID — can only upgrade hero
  const alreadyGood = [];   // Already has gallery data

  for (const row of rows) {
    const check = needsBackfill(row.all_images);

    // --id mode: force-refresh the targeted item even if gallery already exists.
    // This allows repairing titles and metadata on previously backfilled rows.
    if (SINGLE_ID) {
      if (row.ali_product_id) {
        const reason = check.needs ? check.reason : "force-refresh (--id)";
        backfillable.push({ ...row, reason });
      } else {
        noProductId.push({ ...row, reason: check.needs ? check.reason : "force-refresh (--id)" });
      }
      continue;
    }

    if (!check.needs) {
      alreadyGood.push(row);
      continue;
    }

    if (row.ali_product_id) {
      backfillable.push({ ...row, reason: check.reason });
    } else {
      noProductId.push({ ...row, reason: check.reason });
    }
  }

  console.log(`Total staged items: ${rows.length}`);
  console.log(`Already have good gallery: ${alreadyGood.length} (skipping)`);
  console.log(`Backfillable (have ali_product_id): ${backfillable.length}`);
  console.log(`No product ID (past_order, hero-only upgrade): ${noProductId.length}`);
  console.log();

  // --- Phase 1: Upgrade hero URLs for past_order items (no CDP needed) ---
  if (noProductId.length > 0) {
    console.log("--- Phase 1: Upgrading hero URLs for items without product ID ---");
    for (const item of noProductId) {
      const upgraded = upgradeHeroUrl(item.image_url);
      if (upgraded !== item.image_url) {
        console.log(`  ID=${item.id} [${item.source}]: Hero ${item.image_url.slice(-30)} → ${upgraded.slice(-30)}`);
        if (!DRY_RUN) {
          // Set all_images to [upgraded hero URL] so at least the hero shows up full-size
          await run(db,
            `UPDATE candidates SET image_url = ?, all_images = ?, updated_at = ? WHERE id = ?`,
            [upgraded, JSON.stringify([upgraded]), new Date().toISOString(), item.id]
          );
        }
      } else {
        // Hero is already full-size — just set all_images = [image_url] so it's not NULL
        console.log(`  ID=${item.id} [${item.source}]: Hero already full-size, setting all_images = [hero]`);
        if (!DRY_RUN) {
          await run(db,
            `UPDATE candidates SET all_images = ?, updated_at = ? WHERE id = ?`,
            [JSON.stringify([item.image_url]), new Date().toISOString(), item.id]
          );
        }
      }
    }
    console.log(`  Phase 1 complete: ${noProductId.length} items\n`);
  }

  // --- Phase 2: Full gallery backfill via CDP ---
  if (backfillable.length === 0) {
    console.log("No items need full gallery backfill. Done.");
    return;
  }

  console.log("--- Phase 2: Full gallery backfill via CDP ---");
  console.log("Connecting to Chrome DevTools Protocol on port 9222...");

  let browser;
  try {
    browser = await chromium.connectOverCDP("http://localhost:9222");
  } catch (err) {
    console.error("ERROR: Cannot connect to Chrome CDP. Make sure Chrome is running with:");
    console.error('  open -a "Google Chrome" --args --remote-debugging-port=9222');
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  const context = browser.contexts()[0];
  const page = await context.newPage();

  let backfilled = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < backfillable.length; i++) {
    const item = backfillable[i];
    const productUrl = item.product_url || `https://www.aliexpress.com/item/${item.ali_product_id}.html`;

    console.log(`\n[${i + 1}/${backfillable.length}] ID=${item.id} (${item.reason})`);
    console.log(`  Title: ${(item.title || "").substring(0, 60)}`);
    console.log(`  URL: ${productUrl}`);

    if (DRY_RUN) {
      console.log(`  DRY RUN: would scrape and update`);
      skipped++;
      continue;
    }

    try {
      const detail = await scrapeProductDetail(page, productUrl, item.ali_product_id);

      if (detail.images.length === 0) {
        console.log(`  WARNING: Scrape returned 0 images — product may be delisted. Skipping.`);
        failed++;
        continue;
      }

      const allImages = JSON.stringify(detail.images);

      // Build variant_specifics v2
      let variantSpecifics = null;
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
          _legacyVariantMap: hasLegacy ? detail.variantMap : undefined,
        };
        if (detail.skuModel.colorPrices) v2Data.colorPrices = detail.skuModel.colorPrices;
        if (detail.skuModel.colorFilmstrips) v2Data.colorFilmstrips = detail.skuModel.colorFilmstrips;
        if (detail.skuModel.colorSizes) {
          v2Data.colorSizes = detail.skuModel.colorSizes;
          v2Data.sizesVaryByColor = detail.skuModel.sizesVaryByColor || false;
        }
        variantSpecifics = JSON.stringify(v2Data);
      }

      // Also upgrade hero and re-download if needed
      const upgradedHero = upgradeHeroUrl(item.image_url);
      let newImagePath = item.image_path;

      // Download full-size hero if current hero is a thumbnail
      if (upgradedHero !== item.image_url && !item.image_path) {
        try {
          const filename = `backfill_${sanitizeFilename(item.title || "product")}_${Date.now()}.jpg`;
          const dest = path.join(CANDIDATES_IMAGES_DIR, filename);
          await downloadImage(upgradedHero, dest);
          newImagePath = path.relative(path.dirname(require.main.filename || __filename), dest);
          console.log(`  Downloaded full-size hero: ${newImagePath}`);
        } catch (e) {
          console.log(`  Hero download failed: ${e.message} (non-fatal)`);
        }
      }

      // Always attempt to extract the real product title from the page.
      // The DB title may be junk ("Only 1 left", "Aliexpress", etc.) from a previous
      // bad scrape or from a previous backfill run that extracted garbage.
      let newTitle = item.title;
      try {
        const pageTitle = await page.evaluate(() => {
          // Blocklist: generic garbage that is NOT a product title
          const TITLE_JUNK = /^(aliexpress|ali\s*express|wishlist|home|shop|store|cart|checkout|sign\s*in|log\s*in|register|my\s*orders?|welcome|free\s*shipping|only\s+\d+\s+left)$/i;

          // Candidate selectors in priority order (most specific → least)
          const selectors = [
            "[data-pl='product-title']",
            "h1[data-pl='product-title']",
            "[class*='ProductTitle'] h1",
            "[class*='product-title'] h1",
            "[class*='productTitle']",
            "h1[class*='title']",
          ];

          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
              const text = el.textContent.trim();
              if (text.length > 5 && !TITLE_JUNK.test(text)) return text;
            }
          }

          // Last resort: first h1 that doesn't look like page chrome
          const h1s = document.querySelectorAll("h1");
          for (const h1 of h1s) {
            const text = h1.textContent.trim();
            if (text.length > 10 && !TITLE_JUNK.test(text)) return text;
          }

          return null;
        });
        if (pageTitle && pageTitle.length > 5) {
          // Only overwrite if the page title is clearly better than what we have
          const JUNK_TITLE = /^(aliexpress|ali\s*express|wishlist|home|shop|store|only\s+\d+\s+left)$/i;
          if (JUNK_TITLE.test(item.title) || item.title.length < 10) {
            newTitle = pageTitle;
            console.log(`  Title updated: "${item.title}" → "${newTitle.substring(0, 60)}"`);
          }
        }
      } catch (_) {}

      // Write to DB
      const now = new Date().toISOString();
      await run(db,
        `UPDATE candidates SET
           all_images = ?,
           variant_specifics = COALESCE(?, variant_specifics),
           image_url = ?,
           image_path = COALESCE(?, image_path),
           title = ?,
           updated_at = ?
         WHERE id = ? AND stage = 'staged'`,
        [allImages, variantSpecifics, upgradedHero, newImagePath, newTitle, now, item.id]
      );

      const filteredCount = detail.images.length;
      const propCount = detail.skuModel.properties.length;
      const skuCount = detail.skuModel.skus.length;
      console.log(`  ✓ Backfilled: ${filteredCount} images, ${propCount} properties, ${skuCount} SKUs`);
      backfilled++;

      // Polite delay between page loads
      await page.waitForTimeout(1500);
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      failed++;
    }
  }

  await page.close();
  // Don't close the browser — it's the user's Chrome session

  console.log(`\n=== BACKFILL COMPLETE ===`);
  console.log(`  Backfilled:  ${backfilled}`);
  console.log(`  Failed:      ${failed}`);
  console.log(`  Skipped:     ${skipped} (dry run)`);
  console.log(`  Already good: ${alreadyGood.length}`);
  console.log(`  Hero-only:   ${noProductId.length}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
