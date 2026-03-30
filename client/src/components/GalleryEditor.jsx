import { useState, useEffect } from "react";

export default function GalleryEditor({ images, onSave, onSplit, saving, splitStatus }) {
  const [gallery, setGallery] = useState(images || []);
  const [dirty, setDirty] = useState(false);
  const [failedUrls, setFailedUrls] = useState(new Set());

  // Sync from parent when images prop changes (e.g. after split reload)
  useEffect(() => { setGallery(images || []); setDirty(false); }, [images]);

  const move = (idx, dir) => {
    const next = [...gallery];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setGallery(next);
    setDirty(true);
  };

  const makeHero = (idx) => {
    if (idx === 0) return;
    const next = [...gallery];
    const [img] = next.splice(idx, 1);
    next.unshift(img);
    setGallery(next);
    setDirty(true);
  };

  const remove = (idx) => {
    setGallery((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const handleSave = async () => {
    await onSave(gallery);
    setDirty(false);
  };

  const handleImgError = (url) => {
    setFailedUrls((prev) => new Set(prev).add(url));
  };

  return (
    <div>
      <div style={S.header}>
        <span style={S.label}>Gallery ({gallery.length})</span>
        <div style={S.headerActions}>
          {dirty && (
            <button style={S.saveBtn} onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save Gallery"}
            </button>
          )}
          {dirty && (
            <button
              style={S.resetBtn}
              onClick={() => { setGallery(images || []); setDirty(false); }}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {splitStatus && (
        <div style={{
          ...S.splitMsg,
          background: splitStatus.type === "error" ? "#fdf0ed" : "#edf7f0",
          color: splitStatus.type === "error" ? "#D4644A" : "#2D8659",
        }}>
          {splitStatus.message}
        </div>
      )}

      {gallery.length === 0 ? (
        <div style={S.empty}>No images in gallery.</div>
      ) : (
        <div style={S.grid}>
          {gallery.map((url, idx) => {
            const isFailed = failedUrls.has(url);
            return (
              <div key={url + idx} style={{ ...S.thumb, ...(idx === 0 ? S.hero : {}) }}>
                {!isFailed ? (
                  <img
                    src={url}
                    alt={`Image ${idx + 1}`}
                    style={S.thumbImg}
                    loading="lazy"
                    onError={() => handleImgError(url)}
                  />
                ) : (
                  <div style={S.broken}>
                    <span style={S.brokenIcon}>✕</span>
                    <span style={S.brokenText}>Failed</span>
                  </div>
                )}
                {idx === 0 && <span style={S.heroBadge}>HERO</span>}
                <span style={S.indexBadge}>{idx + 1}</span>

                <div style={S.thumbActions}>
                  {idx !== 0 && (
                    <button style={S.actionBtn} onClick={() => makeHero(idx)} title="Set as hero">
                      ★
                    </button>
                  )}
                  <button
                    style={S.actionBtn}
                    onClick={() => move(idx, -1)}
                    disabled={idx === 0}
                    title="Move left"
                  >
                    ←
                  </button>
                  <button
                    style={S.actionBtn}
                    onClick={() => move(idx, 1)}
                    disabled={idx === gallery.length - 1}
                    title="Move right"
                  >
                    →
                  </button>
                  <button
                    style={{ ...S.actionBtn, color: "#ff8080" }}
                    onClick={() => remove(idx)}
                    title="Remove from gallery"
                  >
                    ✕
                  </button>
                  {onSplit && (
                    <button
                      style={{ ...S.actionBtn, color: "#B8A0FF" }}
                      onClick={() => onSplit(url)}
                      title="Split as variant"
                    >
                      ✂
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const S = {
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  headerActions: {
    display: "flex",
    gap: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: "#1A1A1A",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  saveBtn: {
    background: "#1A1A1A",
    color: "#F5F2ED",
    border: "none",
    borderRadius: 4,
    padding: "6px 16px",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
  },
  resetBtn: {
    background: "none",
    color: "#999",
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "5px 12px",
    fontSize: 11,
    cursor: "pointer",
  },
  splitMsg: {
    fontSize: 12,
    padding: "8px 12px",
    borderRadius: 4,
    marginBottom: 12,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
    gap: 10,
  },
  thumb: {
    position: "relative",
    borderRadius: 6,
    overflow: "hidden",
    background: "#f0ede8",
    aspectRatio: "1",
  },
  hero: {
    outline: "2px solid #C4A882",
    outlineOffset: -2,
  },
  thumbImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  broken: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    color: "#bbb",
    gap: 4,
  },
  brokenIcon: { fontSize: 20 },
  brokenText: { fontSize: 10 },
  heroBadge: {
    position: "absolute",
    top: 6,
    left: 6,
    background: "#C4A882",
    color: "#1A1A1A",
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: 1,
    padding: "2px 7px",
    borderRadius: 3,
  },
  indexBadge: {
    position: "absolute",
    top: 6,
    right: 6,
    background: "rgba(26,26,26,0.5)",
    color: "#fff",
    fontSize: 9,
    fontWeight: 600,
    padding: "1px 5px",
    borderRadius: 3,
  },
  thumbActions: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    display: "flex",
    justifyContent: "center",
    gap: 1,
    padding: "5px 4px",
    background: "rgba(26,26,26,0.7)",
    opacity: 0.85,
  },
  actionBtn: {
    background: "none",
    border: "none",
    color: "#F5F2ED",
    fontSize: 14,
    cursor: "pointer",
    padding: "2px 5px",
    lineHeight: 1,
  },
  empty: {
    color: "#999",
    fontSize: 13,
    padding: "24px 0",
    textAlign: "center",
    background: "#f8f7f4",
    borderRadius: 6,
  },
};
