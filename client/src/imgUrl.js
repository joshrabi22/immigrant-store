// Get the best image URL for a candidate
// On Railway: image_path files don't exist, so use AliExpress CDN (image_url)
// Locally: image_path files exist and load faster than CDN
//
// Strategy: if image_url exists, use CDN (works everywhere).
// Fall back to local path only if no image_url.

function cleanAliUrl(url) {
  if (!url) return null;
  if (url.startsWith("//")) url = "https:" + url;
  // Strip .avif wrapper and size suffixes to get renderable .jpg
  const jpgMatch = url.match(/^(.*?\.(?:jpg|jpeg|png))/i);
  return jpgMatch ? jpgMatch[1] : url.replace(/_?\.avif$/i, "");
}

export default function imgUrl(item, bustCache) {
  // Prefer CDN URL — works on both Railway and local
  if (item.image_url) {
    return cleanAliUrl(item.image_url);
  }

  // Fall back to local path (only works on local dev)
  if (item.image_path) {
    const local = `/images/${item.image_path.replace("images/", "")}`;
    return bustCache ? `${local}?t=${Date.now()}` : local;
  }

  return null;
}
