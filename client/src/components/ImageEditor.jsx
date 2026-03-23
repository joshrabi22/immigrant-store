import React, { useState } from "react";
import { updatePick } from "../api";

const styles = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    background: "#F5F2ED",
    borderRadius: 8,
    padding: 24,
    maxWidth: 600,
    width: "90%",
    maxHeight: "80vh",
    overflow: "auto",
  },
  title: { fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 20, fontWeight: 300, marginBottom: 16 },
  grid: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 },
  imgWrap: {
    position: "relative",
    borderRadius: 4,
    overflow: "hidden",
    border: "2px solid transparent",
    cursor: "grab",
  },
  imgHidden: { opacity: 0.3, border: "2px solid #cc6666" },
  img: { width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" },
  badge: {
    position: "absolute",
    top: 4,
    right: 4,
    fontSize: 10,
    padding: "2px 6px",
    borderRadius: 3,
    background: "#cc6666",
    color: "#fff",
    fontWeight: 600,
  },
  toggleBtn: {
    position: "absolute",
    bottom: 4,
    right: 4,
    fontSize: 10,
    padding: "2px 8px",
    borderRadius: 3,
    background: "#fff",
    border: "1px solid #ccc",
    cursor: "pointer",
  },
  footer: { display: "flex", justifyContent: "space-between", marginTop: 16, alignItems: "center" },
  closeBtn: {
    padding: "8px 24px",
    background: "#C4A882",
    color: "#fff",
    border: "none",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 13,
  },
  flagCount: { fontSize: 12, color: "#8A8580" },
};

export default function ImageEditor({ candidateId, images, onClose }) {
  const [localImages, setLocalImages] = useState(images);

  const toggleHidden = async (imgId, currentHidden) => {
    await updatePick(candidateId, { image_hidden: { image_id: imgId, hidden: !currentHidden } });
    setLocalImages((prev) =>
      prev.map((i) => (i.id === imgId ? { ...i, hidden: i.hidden ? 0 : 1 } : i))
    );
  };

  const hiddenCount = localImages.filter((i) => i.hidden).length;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={styles.title}>edit images</h2>

        {localImages.length === 0 && (
          <p style={{ color: "#8A8580", fontSize: 13 }}>
            No images processed yet. Use the "Process" button on the picks tab.
          </p>
        )}

        <div style={styles.grid}>
          {localImages.map((img, idx) => {
            const src = img.processed_path
              ? `/images/${img.processed_path.replace("images/", "")}`
              : img.original_url;

            let flags = [];
            try { flags = JSON.parse(img.flags || "[]"); } catch (_) {}

            return (
              <div
                key={img.id}
                style={{ ...styles.imgWrap, ...(img.hidden ? styles.imgHidden : {}) }}
              >
                {src && <img src={src} alt={`Image ${idx + 1}`} style={styles.img} />}
                {flags.length > 0 && <span style={styles.badge}>{flags.join(", ")}</span>}
                <button
                  style={styles.toggleBtn}
                  onClick={() => toggleHidden(img.id, img.hidden)}
                >
                  {img.hidden ? "Show" : "Hide"}
                </button>
              </div>
            );
          })}
        </div>

        <div style={styles.footer}>
          <span style={styles.flagCount}>{hiddenCount} auto-hidden</span>
          <button style={styles.closeBtn} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
