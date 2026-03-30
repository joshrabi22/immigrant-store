import { useState, useEffect, useCallback, useRef } from "react";
import { resolveName, resolveDescription, resolvePrice, resolveImage } from "../lib/resolveContent";
import { getFilteredGallery } from "../lib/galleryFilter";

// ---------------------------------------------------------------------------
// Quality rules — used both for display and for guiding review decisions
// ---------------------------------------------------------------------------

const QUALITY_RULES = [
  { id: "bg", label: "Background", pass: "Clean #F5F2ED, no artifacts", fail: "Visible original background, color bleed, or cutout halo" },
  { id: "lighting", label: "Lighting", pass: "Soft top-left studio light, consistent tone", fail: "Harsh shadows, uneven exposure, color cast" },
  { id: "shadow", label: "Shadow", pass: "Subtle contact shadow, diffuse edges", fail: "No shadow, hard shadow, or floating appearance" },
  { id: "fidelity", label: "Fidelity", pass: "Texture and color true to original", fail: "Warped, blurred, color-shifted, or AI artifacts" },
  { id: "framing", label: "Framing", pass: "Centered, 10% breathing room, consistent scale", fail: "Off-center, cropped, too small, or too large" },
];

// Determine baseline label from item data
function getBaseline(item) {
  const processed = item.processed_image_url;
  const original = item.image_url;
  if (!processed) return "degraded";
  if (processed === original) return "degraded";
  // Check processed_images for composited URLs
  try {
    const imgs = JSON.parse(item.processed_images || "[]");
    if (imgs.some(u => u && u.includes("_composited"))) return "stage2_composited";
  } catch {}
  return "stage1_only";
}

function getBaselineLabel(baseline) {
  switch (baseline) {
    case "stage2_composited": return "Stage 2 — Composited";
    case "stage1_only": return "Stage 1 — Extracted";
    case "degraded": return "Degraded — Raw";
    default: return "Unknown";
  }
}

function getBaselineColor(baseline) {
  switch (baseline) {
    case "stage2_composited": return { bg: "#edf4ed", color: "#4a7c4a", border: "#c8dcc8" };
    case "stage1_only": return { bg: "#f0f4fd", color: "#5B7FD4", border: "#c8d5f0" };
    case "degraded": return { bg: "#fdf0ed", color: "#D4644A", border: "#f0c8be" };
    default: return { bg: "#f4f2ee", color: "#999", border: "#ddd" };
  }
}

export default function PhotoSuiteReviewCard({ item, onAccept, onReject, onDiscard, onActionSuccess }) {
  const [acting, setActing] = useState(null);
  const [error, setError] = useState(null);
  const [heroIdx, setHeroIdx] = useState(0);
  const [fadeState, setFadeState] = useState("in");
  const [showOriginal, setShowOriginal] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const cardRef = useRef(null);

  const name = resolveName(item);
  const description = resolveDescription(item);
  const price = resolvePrice(item);
  const baseline = getBaseline(item);
  const baselineStyle = getBaselineColor(baseline);

  // Build PROCESSED gallery for review (not raw all_images)
  let processedGallery = [];
  try { processedGallery = JSON.parse(item.processed_images || "[]"); } catch {}
  if (processedGallery.length === 0 && item.processed_image_url) {
    processedGallery = [item.processed_image_url];
  }

  // Build original gallery for comparison — filtered to remove AliExpress junk
  // (icons, sprites, size charts, tiny thumbnails). Raw all_images can contain 40-65
  // URLs from scraping, most of which are UI elements, not product photos.
  const originalGallery = getFilteredGallery(item);

  const activeGallery = showOriginal ? originalGallery : processedGallery;
  const displayImage = activeGallery[heroIdx] || (showOriginal ? item.image_url : item.processed_image_url) || item.image_url;

  // Reset state when item changes
  useEffect(() => {
    setHeroIdx(0);
    setError(null);
    setActing(null);
    setFadeState("in");
    setShowOriginal(false);
  }, [item.id]);

  // Clamp heroIdx when switching galleries
  useEffect(() => {
    if (heroIdx >= activeGallery.length && activeGallery.length > 0) {
      setHeroIdx(0);
    }
  }, [showOriginal, activeGallery.length, heroIdx]);

  const cycleGallery = useCallback(() => {
    if (activeGallery.length <= 1) return;
    setHeroIdx(prev => (prev + 1) % activeGallery.length);
  }, [activeGallery.length]);

  const handleAction = useCallback(async (actionName, handler) => {
    setActing(actionName);
    setError(null);
    try {
      await handler(item.id);
      setFadeState("out");
      setTimeout(async () => {
        await onActionSuccess(actionName);
      }, 180);
    } catch (err) {
      setError(err.message || `${actionName} failed`);
      setActing(null);
    }
  }, [item.id, onActionSuccess]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
      if (acting) return;

      if (e.key === "ArrowRight") {
        e.preventDefault();
        handleAction("accept", onAccept);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        handleAction("reject", onReject);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        handleAction("discard", onDiscard);
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        setShowOriginal(prev => !prev);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [acting, handleAction, onAccept, onReject, onDiscard]);

  return (
    <div
      ref={cardRef}
      style={{
        ...S.card,
        opacity: fadeState === "out" ? 0 : 1,
        transform: fadeState === "out" ? "scale(0.98)" : "scale(1)",
        transition: "opacity 0.18s ease, transform 0.18s ease",
      }}
    >
      {/* Quality bar */}
      <div style={S.qualityBar}>
        <div style={S.qualityLeft}>
          <span style={{
            ...S.baselineBadge,
            background: baselineStyle.bg,
            color: baselineStyle.color,
            borderColor: baselineStyle.border,
          }}>
            {getBaselineLabel(baseline)}
          </span>
          <span style={S.imageCount}>
            {processedGallery.length} processed / {originalGallery.length} source
          </span>
        </div>
        <div style={S.qualityRight}>
          <button
            style={{
              ...S.compareToggle,
              ...(showOriginal ? S.compareToggleActive : {}),
            }}
            onClick={() => setShowOriginal(prev => !prev)}
            title="Toggle original/processed (C)"
          >
            {showOriginal ? "Viewing Original" : "Compare"}
            <span style={S.shortcutInline}>C</span>
          </button>
          <button
            style={S.rulesToggle}
            onClick={() => setShowRules(prev => !prev)}
            title="Quality rules reference"
          >
            {showRules ? "Hide Rules" : "Rules"}
          </button>
        </div>
      </div>

      {/* Quality rules panel (collapsible) */}
      {showRules && (
        <div style={S.rulesPanel}>
          <div style={S.rulesPanelTitle}>Quality Checklist</div>
          {QUALITY_RULES.map(rule => (
            <div key={rule.id} style={S.ruleRow}>
              <span style={S.ruleLabel}>{rule.label}</span>
              <span style={S.rulePass}>{rule.pass}</span>
              <span style={S.ruleFail}>{rule.fail}</span>
            </div>
          ))}
          <div style={S.rulesHint}>
            <strong>Accept</strong> — all 5 criteria pass. <strong>Reject</strong> — fixable issues, sends back to processing. <strong>Discard</strong> — unsalvageable, removes from pipeline.
          </div>
        </div>
      )}

      {/* Image area */}
      <div style={S.imageArea}>
        <div
          style={{
            ...S.heroWrap,
            ...(showOriginal ? S.heroWrapOriginal : {}),
          }}
          onClick={cycleGallery}
          title={activeGallery.length > 1 ? "Click to cycle images" : undefined}
        >
          {displayImage ? (
            <img src={displayImage} alt={name} style={S.heroImg} draggable={false} />
          ) : (
            <div style={S.heroEmpty}>No image available</div>
          )}

          {/* Gallery counter */}
          {activeGallery.length > 1 && (
            <div style={S.galleryCounter}>
              {heroIdx + 1} / {activeGallery.length}
            </div>
          )}

          {/* Original/Processed label */}
          <div style={S.viewLabel}>
            {showOriginal ? "ORIGINAL" : "PROCESSED"}
          </div>
        </div>

        {/* Thumbnail strip — processed images */}
        {activeGallery.length > 1 && (
          <div style={S.thumbStrip}>
            {activeGallery.map((url, i) => (
              <div
                key={i}
                style={{
                  ...S.thumb,
                  ...(i === heroIdx ? S.thumbActive : {}),
                }}
                onClick={() => setHeroIdx(i)}
              >
                <img src={url} alt="" style={S.thumbImg} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom bar: metadata + actions */}
      <div style={S.bottomBar}>
        <div style={S.metaRow}>
          <div style={S.namePrice}>
            <h2 style={S.name}>{name || "Untitled Item"}</h2>
            {price != null && <span style={S.price}>${Number(price).toFixed(2)}</span>}
          </div>

          <div style={S.chips}>
            {item.gender && <span style={S.chip}>{item.gender}</span>}
            {item.detected_category && <span style={S.chip}>{item.detected_category}</span>}
            {item.source && <span style={S.chipMuted}>{item.source}</span>}
            {item.is_split_child === 1 && <span style={S.chipSplit}>split child</span>}
          </div>
        </div>

        {description && <p style={S.description}>{description}</p>}

        {/* Error feedback */}
        {error && (
          <div style={S.errorBar}>
            <span>{error}</span>
            <button style={S.errorDismiss} onClick={() => setError(null)}>dismiss</button>
          </div>
        )}

        {/* Actions */}
        <div style={S.actions}>
          <button
            style={{ ...S.btn, ...S.acceptBtn, ...(acting === "accept" ? S.btnLoading : {}) }}
            disabled={acting !== null}
            onClick={() => handleAction("accept", onAccept)}
          >
            {acting === "accept" ? "Accepting..." : "Accept"}
            <span style={S.shortcut}>→</span>
          </button>
          <button
            style={{ ...S.btn, ...S.rejectBtn, ...(acting === "reject" ? S.btnLoading : {}) }}
            disabled={acting !== null}
            onClick={() => handleAction("reject", onReject)}
          >
            {acting === "reject" ? "Rejecting..." : "Revision"}
            <span style={S.shortcut}>←</span>
          </button>
          <button
            style={{ ...S.btn, ...S.discardBtn, ...(acting === "discard" ? S.btnLoading : {}) }}
            disabled={acting !== null}
            onClick={() => handleAction("discard", onDiscard)}
          >
            {acting === "discard" ? "Discarding..." : "Discard"}
            <span style={S.shortcut}>↓</span>
          </button>
        </div>

        <p style={S.hint}>
          <strong>→</strong> Accept &nbsp; <strong>←</strong> Revision &nbsp; <strong>↓</strong> Discard &nbsp; <strong>C</strong> Compare
        </p>
      </div>
    </div>
  );
}

// ---------- Styles ----------

const S = {
  card: {
    background: "#fff",
    borderRadius: 10,
    border: "1px solid #e8e4de",
    overflow: "hidden",
    boxShadow: "0 2px 12px rgba(0,0,0,0.04)",
    display: "flex",
    flexDirection: "column",
  },

  // Quality bar
  qualityBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
    padding: "10px 20px",
    borderBottom: "1px solid #f0ede8",
    background: "#faf9f7",
  },
  qualityLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  qualityRight: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  baselineBadge: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    padding: "3px 10px",
    borderRadius: 3,
    border: "1px solid",
  },
  imageCount: {
    fontSize: 11,
    color: "#999",
  },
  compareToggle: {
    background: "none",
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "4px 10px",
    fontSize: 10,
    fontWeight: 600,
    color: "#6B6B6B",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    gap: 5,
    transition: "all 0.12s",
  },
  compareToggleActive: {
    background: "#2a2a2a",
    color: "#F5F2ED",
    borderColor: "#2a2a2a",
  },
  shortcutInline: {
    fontSize: 9,
    opacity: 0.5,
    fontWeight: 400,
    fontFamily: "monospace",
  },
  rulesToggle: {
    background: "none",
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "4px 10px",
    fontSize: 10,
    fontWeight: 600,
    color: "#6B6B6B",
    cursor: "pointer",
  },

  // Quality rules panel
  rulesPanel: {
    background: "#faf9f7",
    borderBottom: "1px solid #f0ede8",
    padding: "12px 20px 14px",
  },
  rulesPanelTitle: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 1,
    color: "#1A1A1A",
    marginBottom: 8,
  },
  ruleRow: {
    display: "grid",
    gridTemplateColumns: "72px 1fr 1fr",
    gap: 8,
    padding: "4px 0",
    fontSize: 11,
    lineHeight: 1.4,
    borderBottom: "1px solid #f0ede8",
  },
  ruleLabel: {
    fontWeight: 600,
    color: "#1A1A1A",
  },
  rulePass: {
    color: "#4a7c4a",
  },
  ruleFail: {
    color: "#D4644A",
  },
  rulesHint: {
    fontSize: 11,
    color: "#888",
    marginTop: 8,
    lineHeight: 1.5,
  },

  // Image area
  imageArea: {
    background: "#F5F2ED",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    minHeight: 0,
    position: "relative",
  },
  heroWrap: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "32px 32px 16px",
    cursor: "pointer",
    position: "relative",
    width: "100%",
    minHeight: 420,
    maxHeight: "60vh",
    userSelect: "none",
  },
  heroWrapOriginal: {
    background: "repeating-conic-gradient(#e8e5e0 0% 25%, #F5F2ED 0% 50%) 50% / 16px 16px",
  },
  heroImg: {
    maxWidth: "100%",
    maxHeight: "56vh",
    objectFit: "contain",
    borderRadius: 4,
  },
  heroEmpty: {
    color: "#bbb",
    fontSize: 14,
  },
  galleryCounter: {
    position: "absolute",
    bottom: 20,
    right: 36,
    fontSize: 10,
    fontWeight: 600,
    color: "#999",
    background: "rgba(255,255,255,0.85)",
    padding: "3px 10px",
    borderRadius: 20,
    letterSpacing: 0.5,
  },
  viewLabel: {
    position: "absolute",
    top: 12,
    left: 20,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1.5,
    color: "#999",
    background: "rgba(255,255,255,0.8)",
    padding: "3px 8px",
    borderRadius: 3,
  },

  // Thumbnails
  thumbStrip: {
    display: "flex",
    gap: 5,
    padding: "0 32px 16px",
    overflowX: "auto",
    maxWidth: "100%",
  },
  thumb: {
    width: 40,
    height: 40,
    borderRadius: 3,
    overflow: "hidden",
    border: "2px solid transparent",
    cursor: "pointer",
    flexShrink: 0,
    transition: "border-color 0.12s",
    opacity: 0.6,
  },
  thumbActive: {
    borderColor: "#1A1A1A",
    opacity: 1,
  },
  thumbImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
    background: "#F5F2ED",
  },

  // Bottom bar
  bottomBar: {
    padding: "20px 24px 18px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  metaRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
  },
  namePrice: {
    display: "flex",
    alignItems: "baseline",
    gap: 14,
    minWidth: 0,
  },
  name: {
    fontFamily: "'Cormorant Garamond', serif",
    fontWeight: 400,
    fontSize: 20,
    color: "#1A1A1A",
    margin: 0,
    lineHeight: 1.3,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  price: {
    fontSize: 15,
    fontWeight: 600,
    color: "#1A1A1A",
    flexShrink: 0,
  },
  chips: {
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
    flexShrink: 0,
  },
  chip: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: "#6B6B6B",
    background: "#f4f2ee",
    padding: "3px 10px",
    borderRadius: 3,
  },
  chipMuted: {
    fontSize: 10,
    fontWeight: 500,
    color: "#aaa",
    padding: "3px 10px",
    borderRadius: 3,
  },
  chipSplit: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    color: "#7B68EE",
    background: "#f3f0ff",
    padding: "3px 10px",
    borderRadius: 3,
  },
  description: {
    fontSize: 13,
    color: "#888",
    lineHeight: 1.5,
    margin: 0,
  },

  // Error
  errorBar: {
    background: "#fdf0ed",
    border: "1px solid #f0c8be",
    borderRadius: 4,
    padding: "8px 12px",
    fontSize: 12,
    color: "#D4644A",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  errorDismiss: {
    background: "none",
    border: "none",
    color: "#D4644A",
    fontSize: 10,
    cursor: "pointer",
    textDecoration: "underline",
  },

  // Actions
  actions: {
    display: "flex",
    gap: 8,
    paddingTop: 6,
  },
  btn: {
    border: "none",
    borderRadius: 6,
    padding: "12px 20px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    letterSpacing: 0.3,
    transition: "opacity 0.12s",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  btnLoading: {
    opacity: 0.6,
  },
  acceptBtn: {
    background: "#1A1A1A",
    color: "#F5F2ED",
    flex: 2,
    justifyContent: "center",
  },
  rejectBtn: {
    background: "#f8f7f4",
    color: "#C4A882",
    border: "1px solid #e0ddd8",
    flex: 1,
    justifyContent: "center",
  },
  discardBtn: {
    background: "none",
    color: "#ccc",
    border: "1px solid #e8e4de",
    justifyContent: "center",
  },
  shortcut: {
    fontSize: 10,
    opacity: 0.5,
    fontWeight: 400,
  },
  hint: {
    fontSize: 11,
    color: "#bbb",
    textAlign: "center",
    margin: 0,
    paddingTop: 2,
  },
};
