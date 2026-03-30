// repair-bad-heroes.js — One-time repair for legacy Suggested rows (IDs 1025–1054)
//
// Context:
//   A single old scrape batch missed the product hero image selector and captured
//   UI/sprite assets (48x48 icons, 154x64 banners, shared logo PNGs) as image_url.
//   The all_images field contains real product images mixed with the icon noise.
//
// This script:
//   1. Scans only source='suggested', stage='intake' rows with known-bad image_url values.
//   2. Finds the first valid product image in all_images using priority:
//        a. any .jpg URL that is not a small-dimension asset
//        b. fallback: any .png URL that is not a small-dimension asset (for PNG-only products)
//   3. Updates image_url.
//   4. If no valid image is found, quarantines the row to stage='removed'.
//   5. Is idempotent: re-running after a clean repair finds 0 rows to process.
//
// Usage: node repair-bad-heroes.js
//   (runs against local SQLite — does not load .env / does not touch Turso)

const { createClient } = require("@libsql/client");
const path = require("path");

const DB_PATH = path.join(__dirname, "data.db");

// ---------------------------------------------------------------------------
// Image classifiers
// ---------------------------------------------------------------------------

// Matches paths where the final filename IS a dimension — e.g.:
//   /27x27.png          /48x48.png         /154x64.png
//   /204x64.jpg_.avif   /65x70.gif         /150x150.gif
// Does NOT match product thumbnails like:
//   _220x220q75.jpg_.avif   (no slash before the dimension)
//   S5c3261cf.png_220x220.png_.avif  (hash before the dimension)
const DIMENSION_FILENAME_RE = /\/\d+x\d+\.(png|gif|jpg)(_\.avif)?($|_)/i;

// Known shared UI hashes that appear as hero on multiple products.
// These are site-wide elements with no dimension in the path so DIMENSION_FILENAME_RE
// alone won't catch them.
const KNOWN_UI_HASHES = new Set([
  "Sa976459fb7724bf1bca6e153a425a8ebg", // AliExpress shared graphic
  "S5c3261cf46fb47aa8c7f3abbdd792574S", // repeated icon (no dimension in URL)
]);

function extractHash(url) {
  // Pull the filename stem: the segment after the last /kf/ or last /
  const m = url.match(/\/([A-Za-z0-9_.-]+?)(\.png|\.jpg|\.gif|\.avif)(\b|$|_)/i);
  return m ? m[1] : null;
}

function isBadImage(url) {
  if (!url) return true;
  if (/\.(gif)(\b|$|_)/i.test(url)) return true;        // animated badge/icon GIFs
  if (DIMENSION_FILENAME_RE.test(url)) return true;       // size-only filename
  const hash = extractHash(url);
  if (hash && KNOWN_UI_HASHES.has(hash)) return true;    // known shared UI element
  return false;
}

// Priority 1: .jpg product image (most AliExpress product photos are JPG)
function isProductJpg(url) {
  if (!url) return false;
  if (isBadImage(url)) return false;
  return url.toLowerCase().includes(".jpg");
}

// Priority 2: .png product thumbnail (some products only have PNG images)
// Accept only if it has a proper product hash filename (not a tiny standalone PNG).
function isProductPng(url) {
  if (!url) return false;
  if (isBadImage(url)) return false;
  if (!url.toLowerCase().includes(".png")) return false;
  // Must have a size qualifier suffix like _220x220 or _960x960 after the hash
  // (confirms it went through AliExpress thumbnail pipeline, not a raw UI PNG)
  return /_\d{3,}x\d{3,}/.test(url);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const db = createClient({ url: `file:${DB_PATH}` });

  console.log("=== repair-bad-heroes.js — Legacy Suggested Hero Repair ===\n");
  console.log(`Database: ${DB_PATH}\n`);

  const rows = await db.execute(
    "SELECT id, title, image_url, all_images FROM candidates " +
    "WHERE source = 'suggested' AND stage = 'intake' AND id BETWEEN 1025 AND 1054"
  );

  if (rows.rows.length === 0) {
    console.log("No rows found in range 1025–1054 with source=suggested, stage=intake.");
    return;
  }

  let repaired = 0;
  let alreadyOk = 0;
  let quarantined = 0;

  for (const row of rows.rows) {
    if (!isBadImage(row.image_url)) {
      alreadyOk++;
      continue;
    }

    let imgs = [];
    try {
      imgs = row.all_images ? JSON.parse(row.all_images) : [];
    } catch (_) {
      // Malformed JSON — quarantine
    }

    const chosen = imgs.find(isProductJpg) || imgs.find(isProductPng) || null;

    if (chosen) {
      await db.execute({
        sql: "UPDATE candidates SET image_url = ?, updated_at = datetime('now') WHERE id = ?",
        args: [chosen, row.id],
      });
      const shortTitle = (row.title || "").substring(0, 55);
      const oldTail = (row.image_url || "(null)").split("/").slice(-1)[0].substring(0, 40);
      const newTail = chosen.split("/").slice(-1)[0].substring(0, 60);
      console.log(`  [repair] id ${row.id} — ${shortTitle}`);
      console.log(`           was: .../${oldTail}`);
      console.log(`           now: .../${newTail}\n`);
      repaired++;
    } else {
      await db.execute({
        sql: "UPDATE candidates SET stage = 'removed', updated_at = datetime('now') WHERE id = ?",
        args: [row.id],
      });
      console.log(`  [quarantine] id ${row.id} — no valid product image found in all_images (${imgs.length} entries)\n`);
      quarantined++;
    }
  }

  console.log("=== Summary ===");
  console.log(`  Already clean:  ${alreadyOk}`);
  console.log(`  Repaired:       ${repaired}`);
  console.log(`  Quarantined:    ${quarantined}`);
  console.log(`  Total scanned:  ${rows.rows.length}`);

  if (repaired === 0 && quarantined === 0) {
    console.log("\n  All rows already have valid product hero images — nothing to do.");
  }
}

main().catch((err) => {
  console.error("REPAIR FAILED:", err.message);
  process.exit(1);
});
