// Get the best image URL for a candidate
//
// Local dev:  prefer image_path (served via /images/ static route) — avoids
//             AliExpress CDN hotlink blocks on localhost.
// Cloud:      image_path files don't exist (Railway filesystem is ephemeral).
//             AliExpress CDN is also hotlink-blocked from non-AliExpress origins.
//             Use /api/image-proxy to fetch images server-side (no hotlink issue).
//
// processed_image_url (Cloudinary) is checked BEFORE calling imgUrl() in every
// component, so this function only handles unprocessed source images.

function cleanAliUrl(url) {
  if (!url) return null;
  if (url.startsWith("//")) url = "https:" + url;
  // Strip .avif wrapper and size suffixes to get renderable .jpg
  const jpgMatch = url.match(/^(.*?\.(?:jpg|jpeg|png))/i);
  return jpgMatch ? jpgMatch[1] : url.replace(/_?\.avif$/i, "");
}

function isLocalDev() {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1";
}

function isAliCdn(url) {
  return url && (url.includes("alicdn.com") || url.includes("aliexpress-media.com"));
}

/**
 * Resolve a raw gallery URL for display only.
 * State and DB always retain the original URL — this is render-time only.
 *
 * - Cloudinary / non-AliCDN: return cleaned URL as-is
 * - Local dev + AliCDN: return cleaned URL as-is (hotlink-blocked, known limitation)
 * - Cloud + AliCDN: route through /api/image-proxy (adds AliExpress Referer server-side)
 */
export function resolveGalleryUrl(url) {
  if (!url) return null;
  const clean = cleanAliUrl(url);
  if (!clean) return null;
  if (!isAliCdn(clean)) return clean;        // Cloudinary or other CDN — use directly
  if (isLocalDev()) return clean;            // Local dev — proxy not needed (image_path used for hero)
  return `/api/image-proxy?url=${encodeURIComponent(clean)}`;
}

export default function imgUrl(item, bustCache) {
  const local = isLocalDev();

  // Local dev: use static file path (works, avoids CDN hotlink on localhost)
  if (local && item.image_path) {
    const p = `/images/${item.image_path.replace("images/", "")}`;
    return bustCache ? `${p}?t=${Date.now()}` : p;
  }

  // Resolve the CDN URL
  const cdn = cleanAliUrl(item.image_url);

  if (cdn) {
    // Cloud: proxy AliExpress images through backend to avoid hotlink blocks
    if (!local && isAliCdn(cdn)) {
      return `/api/image-proxy?url=${encodeURIComponent(cdn)}`;
    }
    // Non-AliExpress URLs or local fallback: use directly
    return cdn;
  }

  return null;
}
