import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { resolveName, resolvePrice } from "../lib/resolveContent";
import imgUrl from "../imgUrl";
import { getFilteredGallery } from "../lib/galleryFilter";

export default function StagingCard({ item, onProcess, onRemove }) {
  const [acting, setActing] = useState(null);
  const navigate = useNavigate();

  const name = resolveName(item);
  const price = resolvePrice(item);
  // Use processed_image_url (Cloudinary) first, then clean AliExpress URL via imgUrl
  const image = item.processed_image_url || imgUrl(item);

  const galleryCount = getFilteredGallery(item).length;

  const act = async (e, action, handler) => {
    e.stopPropagation();
    setActing(action);
    try { await handler(item.id); } catch { setActing(null); }
  };

  return (
    <div style={S.card} onClick={() => navigate(`/curation/staging/${item.id}`)}>
      <div style={S.imageWrap}>
        {image ? (
          <img src={image} alt={name} style={S.image} loading="lazy" />
        ) : (
          <div style={S.noImage}>No image</div>
        )}

        {/* Badges */}
        <div style={S.badges}>
          {item.processing_status === "ready" && !item.review_status && (
            <span style={{ ...S.badge, background: "#4a7c4a" }}>READY</span>
          )}
          {item.is_split_child === 1 && <span style={{ ...S.badge, background: "#7B68EE" }}>SPLIT</span>}
          {item.review_status === "revision_needed" && <span style={{ ...S.badge, background: "#D4644A" }}>REVISION</span>}
          {item.source && <span style={S.badge}>{item.source}</span>}
        </div>

        {galleryCount > 0 && (
          <span style={S.galleryBadge}>{galleryCount} img</span>
        )}
      </div>

      <div style={S.body}>
        <div style={S.name}>{name}</div>
        <div style={S.meta}>
          {price != null && <span style={S.price}>${Number(price).toFixed(2)}</span>}
          {item.gender && <span style={S.tag}>{item.gender}</span>}
          {item.detected_category && <span style={S.tag}>{item.detected_category}</span>}
        </div>
      </div>

      <div style={S.actions}>
        <button
          style={{ ...S.btn, ...S.removeBtn }}
          disabled={acting !== null}
          onClick={(e) => act(e, "remove", onRemove)}
        >
          {acting === "remove" ? "…" : "Remove"}
        </button>
        <button
          style={{ ...S.btn, ...S.processBtn }}
          disabled={acting !== null}
          onClick={(e) => act(e, "process", onProcess)}
        >
          {acting === "process" ? "…" : "Process"}
        </button>
      </div>
    </div>
  );
}

const S = {
  card: {
    background: "#fff",
    borderRadius: 8,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
    cursor: "pointer",
    transition: "box-shadow 0.15s",
  },
  imageWrap: {
    position: "relative",
    aspectRatio: "4/5",
    background: "#F5F2ED",
    overflow: "hidden",
  },
  image: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    display: "block",
  },
  noImage: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#aaa",
    fontSize: 12,
  },
  badges: {
    position: "absolute",
    top: 8,
    left: 8,
    display: "flex",
    gap: 4,
    flexWrap: "wrap",
  },
  badge: {
    background: "rgba(26,26,26,0.7)",
    color: "#F5F2ED",
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: 1,
    textTransform: "uppercase",
    padding: "2px 8px",
    borderRadius: 4,
  },
  galleryBadge: {
    position: "absolute",
    bottom: 8,
    right: 8,
    background: "rgba(26,26,26,0.6)",
    color: "#F5F2ED",
    fontSize: 10,
    padding: "2px 6px",
    borderRadius: 4,
  },
  body: {
    padding: "10px 12px 6px",
    flex: 1,
  },
  name: {
    fontSize: 12,
    lineHeight: 1.4,
    color: "#1A1A1A",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  meta: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 6,
    alignItems: "center",
  },
  price: {
    fontSize: 13,
    fontWeight: 600,
    color: "#1A1A1A",
  },
  tag: {
    fontSize: 10,
    color: "#999",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  actions: {
    display: "flex",
    gap: 6,
    padding: "6px 12px 10px",
  },
  btn: {
    flex: 1,
    border: "none",
    borderRadius: 4,
    padding: "7px 0",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
  },
  processBtn: {
    background: "#1A1A1A",
    color: "#F5F2ED",
  },
  removeBtn: {
    background: "#e8e4de",
    color: "#6B6B6B",
  },
};
