// Get the best image URL for a candidate
// Local path first, then clean AliExpress CDN URL as fallback
export default function imgUrl(item, bustCache) {
  if (item.image_path) {
    const local = `/images/${item.image_path.replace("images/", "")}`;
    return bustCache ? `${local}?t=${Date.now()}` : local;
  }
  if (item.image_url) {
    let url = item.image_url;
    if (url.startsWith("//")) url = "https:" + url;
    const jpgMatch = url.match(/^(.*?\.(?:jpg|jpeg|png))/i);
    return jpgMatch ? jpgMatch[1] : url.replace(/_?\.avif$/i, "");
  }
  return null;
}
