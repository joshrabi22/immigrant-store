// Content resolution utility — canonical field priority chains.
// Each resolver walks the chain and returns the first truthy value.

export function resolveName(item) {
  return item.edited_name || item.generated_name || item.title || "";
}

export function resolveDescription(item) {
  return item.edited_description || item.generated_description || "";
}

export function resolvePrice(item) {
  if (item.edited_price != null) return item.edited_price;
  if (item.price != null) return item.price;
  return null;
}

export function resolveImage(item) {
  return item.processed_image_url || item.image_url || null;
}

// Convenience: resolve all at once
export function resolveContent(item) {
  return {
    name: resolveName(item),
    description: resolveDescription(item),
    price: resolvePrice(item),
    image: resolveImage(item),
  };
}
