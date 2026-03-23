// images.js — Image processor: background removal, normalization, flagging
// Usage: node images.js <candidate_id>
// Also importable: const { processCandidate } = require('./images')

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { getDb, initSchema } = require("./db");
const { ensureDir } = require("./lib/image-utils");

const PROCESSED_DIR = path.join(__dirname, "images", "processed");
const BRAND_BG = { r: 245, g: 242, b: 237, alpha: 255 }; // #F5F2ED
const TARGET_WIDTH = 800;
const TARGET_HEIGHT = 1000;

// ---------------------------------------------------------------------------
// Flag detection heuristics
// ---------------------------------------------------------------------------

async function detectFlags(imagePath) {
  const flags = [];
  const fullPath = path.resolve(__dirname, imagePath);
  if (!fs.existsSync(fullPath)) return flags;

  try {
    const img = sharp(fullPath);
    const metadata = await img.metadata();
    const { width, height } = metadata;

    // Size chart detection: nearly square with small dimensions
    if (width && height) {
      const ratio = width / height;
      if (ratio > 0.9 && ratio < 1.1 && width < 600) {
        flags.push("size_chart");
      }
    }

    // Analyze image for busy background and product size
    const { data, info } = await img
      .resize(200, 200, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Border color variance (busy background detection)
    // Sample pixels from the border (top/bottom 10% and left/right 10%)
    const borderPixels = [];
    const w = info.width;
    const h = info.height;
    const channels = info.channels;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const isBorder = y < h * 0.1 || y > h * 0.9 || x < w * 0.1 || x > w * 0.9;
        if (isBorder) {
          const idx = (y * w + x) * channels;
          borderPixels.push([data[idx], data[idx + 1], data[idx + 2]]);
        }
      }
    }

    if (borderPixels.length > 0) {
      // Calculate color variance in border
      const avgR = borderPixels.reduce((s, p) => s + p[0], 0) / borderPixels.length;
      const avgG = borderPixels.reduce((s, p) => s + p[1], 0) / borderPixels.length;
      const avgB = borderPixels.reduce((s, p) => s + p[2], 0) / borderPixels.length;

      const variance = borderPixels.reduce((s, p) => {
        return s + (p[0] - avgR) ** 2 + (p[1] - avgG) ** 2 + (p[2] - avgB) ** 2;
      }, 0) / borderPixels.length;

      if (variance > 3000) {
        flags.push("busy_background");
      }
    }

    // Product size detection: count non-background pixels
    // Assume background is the dominant color in borders
    if (borderPixels.length > 0) {
      const bgR = Math.round(borderPixels.reduce((s, p) => s + p[0], 0) / borderPixels.length);
      const bgG = Math.round(borderPixels.reduce((s, p) => s + p[1], 0) / borderPixels.length);
      const bgB = Math.round(borderPixels.reduce((s, p) => s + p[2], 0) / borderPixels.length);

      let foregroundPixels = 0;
      const totalPixels = w * h;
      for (let i = 0; i < data.length; i += channels) {
        const dr = Math.abs(data[i] - bgR);
        const dg = Math.abs(data[i + 1] - bgG);
        const db = Math.abs(data[i + 2] - bgB);
        if (dr + dg + db > 60) foregroundPixels++;
      }

      const foregroundRatio = foregroundPixels / totalPixels;
      if (foregroundRatio < 0.4) {
        flags.push("product_too_small");
      }
    }

    // Text overlay detection: high contrast small regions in top/bottom 15%
    // Simple heuristic: check if top/bottom strips have very high local contrast
    const topStrip = [];
    const bottomStrip = [];
    for (let y = 0; y < Math.floor(h * 0.15); y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * channels;
        topStrip.push(data[idx]);
      }
    }
    for (let y = Math.floor(h * 0.85); y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * channels;
        bottomStrip.push(data[idx]);
      }
    }

    function localContrast(pixels) {
      if (pixels.length < 10) return 0;
      let jumps = 0;
      for (let i = 1; i < pixels.length; i++) {
        if (Math.abs(pixels[i] - pixels[i - 1]) > 100) jumps++;
      }
      return jumps / pixels.length;
    }

    if (localContrast(topStrip) > 0.15 || localContrast(bottomStrip) > 0.15) {
      flags.push("text_overlay");
    }
  } catch (err) {
    flags.push(`analysis_error: ${err.message}`);
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Background removal via remove.bg API
// ---------------------------------------------------------------------------

async function removeBackground(imagePath) {
  const apiKey = process.env.REMOVEBG_API_KEY;
  if (!apiKey) return null; // Skip if no API key

  const fullPath = path.resolve(__dirname, imagePath);
  const imageData = fs.readFileSync(fullPath);

  const formData = new FormData();
  formData.append("image_file", new Blob([imageData]), path.basename(fullPath));
  formData.append("size", "auto");
  formData.append("bg_color", "F5F2ED");

  const res = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: { "X-Api-Key": apiKey },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`remove.bg error ${res.status}: ${errText}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Normalize image to 800x1000 portrait with brand background
// ---------------------------------------------------------------------------

async function normalizeImage(imageBuffer) {
  return sharp(imageBuffer)
    .resize(TARGET_WIDTH, TARGET_HEIGHT, {
      fit: "contain",
      background: BRAND_BG,
    })
    .flatten({ background: BRAND_BG })
    .normalize()
    .jpeg({ quality: 90 })
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Process a single candidate
// ---------------------------------------------------------------------------

async function processCandidate(candidateId, db) {
  const ownDb = !db;
  if (!db) {
    db = getDb();
    initSchema(db);
  }

  ensureDir(PROCESSED_DIR);

  const candidate = db.prepare("SELECT * FROM candidates WHERE id = ?").get(candidateId);
  if (!candidate) throw new Error(`Candidate ${candidateId} not found`);
  if (!candidate.image_path) throw new Error(`Candidate ${candidateId} has no image`);

  const imageUrl = candidate.image_url;
  const imagePath = candidate.image_path;
  const results = [];

  // Process main image
  console.log(`  Detecting flags...`);
  const flags = await detectFlags(imagePath);
  const hasFlags = flags.length > 0;

  let processedPath = null;
  const outputFilename = `${candidateId}_0.jpg`;
  const outputPath = path.join(PROCESSED_DIR, outputFilename);

  try {
    // Try remove.bg first
    let imageBuffer = await removeBackground(imagePath);
    if (imageBuffer) {
      console.log(`  Background removed via remove.bg`);
    } else {
      // Fallback: just read the original
      console.log(`  No REMOVEBG_API_KEY — using original image`);
      imageBuffer = fs.readFileSync(path.resolve(__dirname, imagePath));
    }

    // Normalize
    const normalized = await normalizeImage(imageBuffer);
    fs.writeFileSync(outputPath, normalized);
    processedPath = path.relative(__dirname, outputPath);
    console.log(`  Normalized to ${TARGET_WIDTH}x${TARGET_HEIGHT}`);
  } catch (err) {
    console.log(`  Processing error: ${err.message}`);
  }

  // Save to image_processing table
  const insertImg = db.prepare(`
    INSERT INTO image_processing (candidate_id, original_url, processed_path, flags, hidden, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertImg.run(
    candidateId,
    imageUrl,
    processedPath,
    JSON.stringify(flags),
    hasFlags ? 1 : 0,
    0
  );

  // Update candidate
  db.prepare("UPDATE candidates SET processed_images = ?, image_flags = ? WHERE id = ?").run(
    JSON.stringify(processedPath ? [processedPath] : []),
    JSON.stringify(flags),
    candidateId
  );

  if (flags.length > 0) {
    console.log(`  Flags: ${flags.join(", ")}`);
  }

  if (ownDb) db.close();

  return { processedPath, flags };
}

if (require.main === module) {
  const id = parseInt(process.argv[2]);
  if (!id) {
    console.error("Usage: node images.js <candidate_id>");
    process.exit(1);
  }
  processCandidate(id)
    .then((r) => {
      console.log(`Processed: ${r.processedPath || "failed"}`);
      console.log(`Flags: ${r.flags.length ? r.flags.join(", ") : "none"}`);
    })
    .catch((e) => {
      console.error("Error:", e.message);
      process.exit(1);
    });
}

module.exports = { processCandidate, detectFlags, normalizeImage };
