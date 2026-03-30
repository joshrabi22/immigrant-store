// Get the best image URL for a candidate
// On Railway: image_path files don't exist, so use AliExpress CDN (image_url)
// Locally: image_path files exist and load faster + avoid CDN hotlink blocks
//
// Strategy: prefer local image_path (served via /images/ static route) when
// available — AliExpress CDN hotlink-protects images loaded from localhost.
// Fall back to CDN URL only when no local file exists (Railway deployment).

function cleanAliUrl(url) {
  if (!url) return null;
  if (url.startsWith("//")) url = "https:" + url;
  // Strip .avif wrapper and size suffixes to get renderable .jpg
  const jpgMatch = url.match(/^(.*?\.(?:jpg|jpeg|png))/i);
  return jpgMatch ? jpgMatch[1] : url.replace(/_?\.avif$/i, "");
}

export default function imgUrl(item, bustCache) {
  // Prefer local path — served by express.static('/images'), avoids CDN hotlink blocks
  if (item.image_path) {
    const local = `/images/${item.image_path.replace("images/", "")}`;
    return bustCache ? `${local}?t=${Date.now()}` : local;
  }

  // Fall back to CDN URL (Railway deployment where local files don't exist)
  if (item.image_url) {
    return cleanAliUrl(item.image_url);
  }

  return null;
}
