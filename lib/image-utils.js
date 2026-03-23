// lib/image-utils.js — Shared image helpers

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// Detect actual image format from file magic bytes
function detectMediaType(imageData) {
  if (imageData[0] === 0x89 && imageData[1] === 0x50) return "image/png";
  if (imageData[0] === 0x52 && imageData[1] === 0x49 && imageData[2] === 0x46 && imageData[3] === 0x46) return "image/webp";
  if (imageData[0] === 0x47 && imageData[1] === 0x49 && imageData[2] === 0x46) return "image/gif";
  return "image/jpeg";
}

// Read an image file and return { base64, mediaType }
function readImageForApi(filePath) {
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) return null;
  const data = fs.readFileSync(fullPath);
  return { base64: data.toString("base64"), mediaType: detectMediaType(data), data };
}

// Download an image from URL to local path, following one redirect
function downloadImage(url, dest) {
  return new Promise((resolve, reject) => {
    if (!url) return resolve(null);
    if (url.startsWith("//")) url = "https:" + url;
    const client = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);
    client
      .get(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(dest, () => {});
          downloadImage(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => { file.close(); resolve(dest); });
      })
      .on("error", (err) => {
        file.close();
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

// ---------------------------------------------------------------------------
// AliExpress URL variations — try multiple formats before giving up
// ---------------------------------------------------------------------------

// Generate all URL variations to try for an AliExpress image
function getAliImageUrlVariations(rawUrl) {
  if (!rawUrl) return [];
  let url = rawUrl;
  if (url.startsWith("//")) url = "https:" + url;

  const variations = [];

  // 1. Strip to base .jpg (most reliable)
  const jpgMatch = url.match(/^(.*?\.jpg)/i);
  if (jpgMatch) variations.push(jpgMatch[1]);

  // 2. Strip to base .png
  const pngMatch = url.match(/^(.*?\.png)/i);
  if (pngMatch) variations.push(pngMatch[1]);

  // 3. Try replacing extension with .webp
  if (jpgMatch) variations.push(jpgMatch[1].replace(/\.jpg$/i, ".webp"));

  // 4. Try the raw URL with avif stripped
  const noAvif = url.replace(/_?\.avif$/i, "");
  if (noAvif !== url && !variations.includes(noAvif)) variations.push(noAvif);

  // 5. Try stripping trailing underscore (common artifact)
  for (const v of [...variations]) {
    if (v.endsWith("_")) variations.push(v.slice(0, -1));
  }

  // 6. Original URL as last resort
  if (!variations.includes(url)) variations.push(url);

  // Deduplicate while preserving order
  return [...new Set(variations)];
}

// Try downloading an image using multiple URL variations
// Returns { path, url, format } or null if all fail
async function downloadAliImage(rawUrl, destDir, filenameBase) {
  const variations = getAliImageUrlVariations(rawUrl);
  if (variations.length === 0) return null;

  for (const url of variations) {
    const ext = url.match(/\.(jpg|jpeg|png|webp)$/i)?.[1] || "jpg";
    const dest = path.join(destDir, `${filenameBase}.${ext}`);
    try {
      await downloadImage(url, dest);
      const stat = fs.statSync(dest);
      if (stat.size >= 5000) {
        return { path: dest, url, format: ext, size: stat.size };
      }
      // Too small — try next variation
      fs.unlinkSync(dest);
    } catch (_) {
      // Clean up partial file and try next
      try { fs.unlinkSync(dest); } catch (__) {}
    }
  }

  return null; // All variations failed
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9_-]/gi, "_").substring(0, 80);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  detectMediaType, readImageForApi, downloadImage,
  downloadAliImage, getAliImageUrlVariations,
  sanitizeFilename, ensureDir,
};
