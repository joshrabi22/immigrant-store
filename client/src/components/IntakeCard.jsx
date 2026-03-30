import { useState } from "react";
import imgUrl from "../imgUrl";

export default function IntakeCard({ item, onApprove, onReject, focused }) {
  const [acting, setActing] = useState(null); // "approve" | "reject" | null
  const [imgError, setImgError] = useState(false);
  const image = item.processed_image_url || imgUrl(item);
  const price = item.price != null ? `$${Number(item.price).toFixed(2)}` : null;

  const act = async (action, handler) => {
    setActing(action);
    try {
      await handler(item.id);
    } catch {
      setActing(null);
    }
  };

  // Truncate raw AliExpress titles to something scannable
  const displayTitle = (item.generated_name || item.edited_name)
    ? (item.edited_name || item.generated_name)
    : (item.title || "").length > 60
      ? item.title.slice(0, 60) + "..."
      : item.title;

  return (
    <div style={{ ...S.card, ...(focused ? S.cardFocused : {}) }}>
      <div style={S.imageWrap}>
        {image && !imgError ? (
          <img
            src={image}
            alt={displayTitle}
            style={S.image}
            loading="lazy"
            onError={() => setImgError(true)}
          />
        ) : (
          <div style={S.noImage}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="1.2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="M21 15l-5-5L5 21" />
            </svg>
            <span style={S.noImageText}>No image</span>
          </div>
        )}
        {item.source && <span style={S.sourceBadge}>{item.source}</span>}
      </div>

      <div style={S.body}>
        {/* Gender / category chips */}
        {(item.gender || item.detected_category) && (
          <div style={S.chipRow}>
            {item.gender && <span style={S.chip}>{item.gender}</span>}
            {item.detected_category && <span style={S.chip}>{item.detected_category}</span>}
          </div>
        )}

        {/* Title — de-emphasized for raw AliExpress titles */}
        <div style={
          (item.generated_name || item.edited_name) ? S.brandTitle : S.rawTitle
        }>
          {displayTitle}
        </div>

        {price && <div style={S.price}>{price}</div>}
      </div>

      <div style={S.actions}>
        <button
          style={{ ...S.btn, ...S.rejectBtn }}
          disabled={acting !== null}
          onClick={() => act("reject", onReject)}
        >
          {acting === "reject" ? "..." : "Reject"}
        </button>
        <button
          style={{ ...S.btn, ...S.approveBtn }}
          disabled={acting !== null}
          onClick={() => act("approve", onApprove)}
        >
          {acting === "approve" ? "..." : "Approve"}
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
    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    transition: "box-shadow 0.15s, outline 0.15s",
    outline: "2px solid transparent",
  },
  cardFocused: {
    outline: "2px solid #C4A882",
    boxShadow: "0 2px 12px rgba(196,168,130,0.25)",
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
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    color: "#bbb",
  },
  noImageText: {
    fontSize: 11,
    color: "#bbb",
  },
  sourceBadge: {
    position: "absolute",
    top: 8,
    left: 8,
    background: "rgba(26,26,26,0.7)",
    color: "#F5F2ED",
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: 1,
    textTransform: "uppercase",
    padding: "2px 8px",
    borderRadius: 4,
  },
  body: {
    padding: "10px 12px 6px",
    flex: 1,
  },
  chipRow: {
    display: "flex",
    gap: 4,
    marginBottom: 6,
    flexWrap: "wrap",
  },
  chip: {
    fontSize: 9,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#6B6B6B",
    background: "#f0ede8",
    padding: "2px 7px",
    borderRadius: 3,
  },
  brandTitle: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 14,
    fontWeight: 500,
    lineHeight: 1.3,
    color: "#1A1A1A",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  rawTitle: {
    fontSize: 11,
    lineHeight: 1.4,
    color: "#999",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  price: {
    fontSize: 13,
    fontWeight: 600,
    color: "#1A1A1A",
    marginTop: 4,
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
    transition: "opacity 0.15s",
  },
  approveBtn: {
    background: "#1A1A1A",
    color: "#F5F2ED",
  },
  rejectBtn: {
    background: "#e8e4de",
    color: "#6B6B6B",
  },
};
