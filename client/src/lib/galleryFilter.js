// galleryFilter.js — Shared gallery dedup + junk filtering
//
// AliExpress product pages contain 40-65 images per product, most of which are
// page chrome: service badges, shipping icons, return policy graphics, trust
// shields, SKU swatches, size chart thumbnails, and navigation assets.
//
// This filter uses a multi-layer approach:
//   1. Known page-chrome fingerprints (cross-product hash blocklist)
//   2. Structural URL patterns (thumbnails, pixel icons, non-CDN)
//   3. Keyword patterns (icon, sprite, logo, etc.)
//
// Result: typically 3-8 real product images per item (down from 47-65 raw).

// ---------------------------------------------------------------------------
// Layer 1: Known AliExpress page-chrome image fingerprints
// These file hashes appear across 5+ different products in the DB — they are
// global page assets (shipping badge, free returns icon, buyer protection
// shield, etc.), NOT product images. Derived from cross-product frequency
// analysis of 146 products with galleries.
// ---------------------------------------------------------------------------
const PAGE_CHROME_HASHES = new Set([
  "Sa976459fb7724bf1bca6e153a425a8ebg",  // 145 products — service badge
  "S9e723ca0d10848499e4e3fb33be2224do",  // 140 products — service badge
  "S64c04957a1244dffbab7086d6e1a7cad7",  // 140 products — service badge
  "Sb100bd23552d499c9fa8e1499f3c46dbw",  // 140 products — service badge
  "S5c3261cf46fb47aa8c7f3abbdd792574S",  //  66 products — delivery truck icon
  "Saf2ebe3af38947179531973d0d08ef74Y",  //  60 products — service graphic
  "Sd8c759485ca2404d87d8f5d5ed0d98e0K",  //  30 products — service graphic
  "S16183c3f12904fbbaf3f8aef523f0b73T",  //  28 products — service graphic
  "S9bad0c7ed77b4899ae22645df613a766r",  //  20 products — service graphic
  "Sa42ea28366094829a2e882420e1e269aJ",  //  18 products — service graphic
  "S3f91b770226a464c8baf581b22e148f7Y",  //  13 products — service graphic
  "S5fde9fa3ffdb45cf908380fcc49bf6771",  //  12 products — service graphic
  "Sa3e67595f2374efa9ce9f91574dc4650T",  //  11 products — service graphic
]);

/**
 * Extract the unique file hash from an AliExpress CDN URL.
 * URLs look like: .../kf/S9e723ca0d10848499e4e3fb33be2224do.png
 * The hash is the part after /kf/ and before the extension.
 */
function extractHash(url) {
  const m = url.match(/\/kf\/([A-Za-z0-9_]+)/);
  return m ? m[1] : null;
}

/**
 * Normalize a URL to its base form for dedup comparison.
 * Strips AliExpress size suffixes, quality params, .avif wrappers.
 * Examples:
 *   .../kf/Sxxx.jpg_480x480q75.jpg_.avif → .../kf/Sxxx.jpg
 *   .../kf/Sxxx.png_960x960.png_.avif   → .../kf/Sxxx.png
 */
function baseUrl(u) {
  if (!u) return "";
  const m = u.match(/^(.*?\.(?:jpg|jpeg|png|webp))/i);
  return (m ? m[1] : u).replace(/^\/\//, "https://").toLowerCase();
}

/**
 * Test whether a URL is AliExpress junk. Multi-layer check:
 *   - Layer 1: known page-chrome fingerprints
 *   - Layer 2: structural URL patterns
 *   - Layer 3: keyword patterns
 */
function isJunkUrl(url) {
  if (!url || typeof url !== "string") return true;

  // Too short or data URI — broken/invalid
  if (url.length < 30 || url.startsWith("data:")) return true;

  // Non-CDN URLs (truncated scraper artifacts, broken URLs)
  if (!url.includes("alicdn.com") && !url.includes("aliexpress-media.com")) return true;

  // --- Layer 1: Known page-chrome fingerprints ---
  const hash = extractHash(url);
  if (hash && PAGE_CHROME_HASHES.has(hash)) return true;

  // --- Layer 2: Structural URL patterns ---

  // Tiny pixel images: /27x27.png, /20x20.png (swatch/icon dimensions in filename)
  if (/\/\d{1,3}x\d{1,3}\.(?:png|jpg|gif)/i.test(url)) return true;

  // Small explicit thumbnails: _50x50, _120x120
  if (/_\d{1,3}x\d{1,3}[._]/.test(url)) return true;

  // Medium thumbnails with quality suffix: _220x220q75.jpg, _480x480q75.jpg
  // These are SKU variant swatches or seller description thumbnails, not full images
  if (/_\d{2,4}x\d{2,4}q\d+\.jpg/i.test(url)) return true;

  // AliExpress navigation/category assets
  if (/\/ae-us\/.*?(category|nav|menu|header|footer)/i.test(url)) return true;

  // --- Layer 3: Keyword patterns ---
  if (/icon|sprite|logo|star|rating|arrow|button|banner|placeholder/i.test(url)) return true;

  return false;
}

/**
 * Filter and deduplicate a gallery array.
 * @param {string[]} urls - Raw URL array (typically from JSON.parse(all_images))
 * @returns {string[]} Cleaned, deduplicated URLs
 */
export function filterGallery(urls) {
  if (!Array.isArray(urls)) return [];
  const seen = new Set();
  return urls.filter((url) => {
    if (isJunkUrl(url)) return false;
    const key = baseUrl(url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Build a filtered gallery from an item's all_images field.
 * Falls back to image_url if all_images is empty/missing.
 * @param {Object} item - Candidate row with all_images and image_url fields
 * @returns {string[]} Cleaned gallery
 */
export function getFilteredGallery(item) {
  if (!item) return [];
  let raw = [];
  try { raw = JSON.parse(item.all_images || "[]"); } catch {}
  if (raw.length === 0 && item.image_url) raw = [item.image_url];
  return filterGallery(raw);
}
