import { useState } from "react";
import { resolveName, resolveDescription, resolvePrice } from "../lib/resolveContent";
import imgUrl from "../imgUrl";

export default function LaunchCard({ item, onReturn, onPublish }) {
  const [acting, setActing] = useState(null); // "return" | "publish"
  const [error, setError] = useState(null);

  const name = resolveName(item);
  const description = resolveDescription(item);
  const price = resolvePrice(item);
  const image = item.processed_image_url || imgUrl(item);

  const approvedDate = item.approved_at
    ? new Date(item.approved_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;

  const handleAction = async (actionName, handler) => {
    setActing(actionName);
    setError(null);
    try {
      await handler(item.id);
    } catch (err) {
      setError(err.message || `${actionName} failed`);
      setActing(null);
    }
  };

  const busy = acting !== null;

  return (
    <div style={S.card}>
      {/* Large editorial image — 4:5 portrait */}
      <div style={S.imageWrap}>
        {image ? (
          <img src={image} alt={name} style={S.image} />
        ) : (
          <div style={S.imageEmpty}>No image</div>
        )}
      </div>

      {/* Content area */}
      <div style={S.content}>
        <div style={S.name}>{name || "Untitled"}</div>
        {price != null && <div style={S.price}>${Number(price).toFixed(2)}</div>}
        {description && <p style={S.desc}>{description}</p>}
        <div style={S.metaRow}>
          {item.gender && <span style={S.tag}>{item.gender}</span>}
          {item.detected_category && <span style={S.tag}>{item.detected_category}</span>}
          {item.source && <span style={{ ...S.tag, color: "#999" }}>{item.source}</span>}
        </div>
        {approvedDate && <div style={S.approvedAt}>Approved {approvedDate}</div>}
      </div>

      {/* Feedback */}
      {error && (
        <div style={S.errorBar}>
          <span>{error}</span>
          <button style={S.dismissBtn} onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      {/* Actions */}
      <div style={S.actions}>
        <button
          style={S.returnBtn}
          onClick={() => handleAction("return", onReturn)}
          disabled={busy}
        >
          {acting === "return" ? "Returning..." : "Return to Approved"}
        </button>
        <button
          style={S.publishBtn}
          onClick={() => handleAction("publish", onPublish)}
          disabled={busy}
        >
          {acting === "publish" ? "Publishing..." : "Publish"}
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
    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    display: "flex",
    flexDirection: "column",
  },

  /* Large editorial image */
  imageWrap: {
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
  imageEmpty: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#bbb",
    fontSize: 12,
  },

  /* Content */
  content: {
    padding: "14px 16px 8px",
    flex: 1,
  },
  name: {
    fontFamily: "'Cormorant Garamond', serif",
    fontWeight: 500,
    fontSize: 18,
    color: "#1A1A1A",
    marginBottom: 3,
    lineHeight: 1.3,
  },
  price: {
    fontSize: 14,
    fontWeight: 600,
    color: "#1A1A1A",
    marginBottom: 6,
  },
  desc: {
    fontSize: 12,
    color: "#6B6B6B",
    lineHeight: 1.5,
    margin: "0 0 8px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    display: "-webkit-box",
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical",
  },
  metaRow: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
    marginBottom: 6,
  },
  tag: {
    fontSize: 9,
    color: "#6B6B6B",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    background: "#f0ede8",
    padding: "2px 8px",
    borderRadius: 3,
  },
  approvedAt: {
    fontSize: 10,
    color: "#bbb",
  },

  // Feedback
  errorBar: {
    background: "#fdf0ed",
    border: "1px solid #f0c8be",
    margin: "0 16px 8px",
    borderRadius: 4,
    padding: "7px 12px",
    fontSize: 12,
    color: "#D4644A",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  dismissBtn: {
    background: "none",
    border: "none",
    color: "#D4644A",
    fontSize: 10,
    cursor: "pointer",
    textDecoration: "underline",
    flexShrink: 0,
  },

  // Actions
  actions: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 16px 14px",
    borderTop: "1px solid #f0ede8",
    gap: 8,
  },
  returnBtn: {
    background: "none",
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "6px 14px",
    fontSize: 11,
    fontWeight: 500,
    color: "#6B6B6B",
    cursor: "pointer",
  },
  publishBtn: {
    background: "#1A1A1A",
    color: "#F5F2ED",
    border: "none",
    borderRadius: 4,
    padding: "6px 16px",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    letterSpacing: 0.3,
  },
};
