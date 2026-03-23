import React, { useState, useEffect, useCallback } from "react";
import {
  getEditItem, saveEdit, skipItem, generateName, generateDescription,
  removeBg, enhanceImage, applyEnhanced, revertImage, publishItem,
} from "../api";
import imgUrl from "../imgUrl";

const CATEGORIES = ["tops", "bottoms", "outerwear", "footwear", "jewelry", "belts", "accessories"];
const GENDERS = ["mens", "womens", "unisex"];
const SIZES = ["XS", "S", "M", "L", "XL"];
const GENDER_LABELS = { mens: "M", womens: "W", unisex: "U" };

export default function ProductEditor({ id, queuePosition, queueTotal, onNext, onPrev, onExit, hasPrev }) {
  const [item, setItem] = useState(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("");
  const [gender, setGender] = useState("unisex");
  const [category, setCategory] = useState("tops");
  const [sizes, setSizes] = useState(["S", "M", "L", "XL"]);
  const [colors, setColors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [nameLoading, setNameLoading] = useState(false);
  const [descLoading, setDescLoading] = useState(false);
  const [bgLoading, setBgLoading] = useState(false);
  const [enhanceLoading, setEnhanceLoading] = useState(false);
  const [enhancedPath, setEnhancedPath] = useState(null);
  const [showComparison, setShowComparison] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [flash, setFlash] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setEnhancedPath(null);
    setShowComparison(false);
    const data = await getEditItem(id);
    setItem(data);
    setName(data.edited_name || data.immigrant_name || "");
    setDescription(data.edited_description || data.immigrant_description || "");
    setPrice(data.edited_price || data.retail_price || "");
    setGender(data.gender || "unisex");
    setCategory(data.detected_category || "tops");
    try { setSizes(JSON.parse(data.edited_sizes) || ["S", "M", "L", "XL"]); } catch (_) { setSizes(["S", "M", "L", "XL"]); }
    try { setColors(JSON.parse(data.edited_colors) || []); } catch (_) { setColors([]); }
    setLoading(false);

    // Auto-generate name and description if empty
    if (!data.edited_name && !data.immigrant_name) doGenerateName(data.id);
    if (!data.edited_description && !data.immigrant_description) doGenerateDesc(data.id);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (overrides = {}) => {
    await saveEdit(id, { edited_name: name, edited_description: description, edited_price: parseFloat(price) || null, gender, detected_category: category, edited_sizes: sizes, edited_colors: colors, ...overrides });
  }, [id, name, description, price, gender, category, sizes, colors]);

  const doGenerateName = async (itemId) => {
    setNameLoading(true);
    try {
      const result = await generateName(itemId || id);
      setName(result.immigrant_name);
      if (result.color_names) setColors(result.color_names);
    } catch (_) {}
    setNameLoading(false);
  };

  const doGenerateDesc = async (itemId) => {
    setDescLoading(true);
    try {
      const result = await generateDescription(itemId || id);
      setDescription(result.description);
    } catch (_) {}
    setDescLoading(false);
  };

  const doRemoveBg = async () => {
    setBgLoading(true);
    try {
      await removeBg(id);
      setItem((prev) => ({ ...prev })); // force re-render
      setFlash("Background removed");
      setTimeout(() => setFlash(null), 2000);
    } catch (e) { setFlash(e.message); setTimeout(() => setFlash(null), 3000); }
    setBgLoading(false);
  };

  const doEnhance = async () => {
    setEnhanceLoading(true);
    try {
      const result = await enhanceImage(id);
      setEnhancedPath(result.enhanced_path);
      setShowComparison(true);
    } catch (e) { setFlash(e.message); setTimeout(() => setFlash(null), 3000); }
    setEnhanceLoading(false);
  };

  const doApplyEnhanced = async () => {
    await applyEnhanced(id, enhancedPath);
    setItem((prev) => ({ ...prev, image_path: enhancedPath }));
    setShowComparison(false);
    setEnhancedPath(null);
    setFlash("Enhanced image applied");
    setTimeout(() => setFlash(null), 2000);
  };

  const doRevert = async () => {
    await revertImage(id);
    load();
    setFlash("Reverted to original");
    setTimeout(() => setFlash(null), 2000);
  };

  const doSkip = async () => {
    await save();
    await skipItem(id);
    onNext();
  };

  const doPublish = async () => {
    setPublishing(true);
    await save();
    try {
      await publishItem(id);
      setFlash("Published!");
      setTimeout(() => { setFlash(null); onNext(); }, 1000);
    } catch (e) {
      setFlash(`Publish failed: ${e.message}`);
      setTimeout(() => setFlash(null), 3000);
    }
    setPublishing(false);
  };

  if (loading || !item) return <div style={S.full}><p style={S.muted}>Loading...</p></div>;

  const imgSrc = imgUrl(item, true);
  const enhancedSrc = enhancedPath ? `/images/${enhancedPath.replace("images/", "")}?t=${Date.now()}` : null;
  const costCalc = item.price ? `$${item.price} cost × 2.5 = $${Math.round(item.price * 2.5)}` : "";

  return (
    <div style={S.full}>
      {/* Flash toast */}
      {flash && <div style={S.toast}>{flash}</div>}

      {/* Top bar */}
      <div style={S.topBar}>
        <button onClick={onExit} style={S.backBtn}>←</button>
        <span style={{ fontSize: 13, color: "#8A8580" }}>{queuePosition} of {queueTotal}</span>
        {hasPrev && <button onClick={onPrev} style={S.backBtn}>‹ prev</button>}
      </div>

      <div style={S.scrollArea}>
        {/* SECTION 1 — PHOTO */}
        <div style={S.section}>
          {showComparison && enhancedSrc ? (
            <div>
              <div style={{ display: "flex", gap: 2 }}>
                <div style={{ flex: 1, textAlign: "center" }}>
                  <p style={S.label}>Original</p>
                  {imgSrc && <img src={imgSrc} alt="original" style={S.halfImg} />}
                </div>
                <div style={{ flex: 1, textAlign: "center" }}>
                  <p style={S.label}>Enhanced</p>
                  <img src={enhancedSrc} alt="enhanced" style={S.halfImg} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, padding: "12px 0" }}>
                <button onClick={() => { setShowComparison(false); setEnhancedPath(null); }} style={S.actionBtn}>Undo — keep original</button>
                <button onClick={doApplyEnhanced} style={S.accentBtn}>Keep Enhanced</button>
              </div>
            </div>
          ) : (
            <>
              {imgSrc && <img src={imgSrc} alt={item.title} style={S.heroImg} />}
              <div style={{ display: "flex", gap: 8, padding: "8px 0" }}>
                <button onClick={doRemoveBg} disabled={bgLoading} style={S.actionBtn}>
                  {bgLoading ? "Removing..." : "Remove BG"}
                </button>
                <button onClick={doEnhance} disabled={enhanceLoading} style={S.actionBtn}>
                  {enhanceLoading ? "Enhancing..." : "Enhance"}
                </button>
              </div>
              {item.original_image_path && (
                <button onClick={doRevert} style={{ ...S.link, marginBottom: 8 }}>revert to original</button>
              )}
            </>
          )}
        </div>

        {/* SECTION 2 — NAME */}
        <div style={S.section}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              value={name} onChange={(e) => setName(e.target.value)} onBlur={() => save({ edited_name: name })}
              placeholder="product name"
              style={S.nameInput}
            />
            <button onClick={() => doGenerateName()} disabled={nameLoading} style={S.regenBtn}>
              {nameLoading ? "..." : "↻"}
            </button>
          </div>
        </div>

        {/* SECTION 3 — DESCRIPTION */}
        <div style={S.section}>
          <p style={S.label}>Description</p>
          <div style={{ position: "relative" }}>
            <textarea
              value={description} onChange={(e) => setDescription(e.target.value)}
              onBlur={() => save({ edited_description: description })}
              placeholder="Product description..."
              rows={4} style={S.textarea}
            />
            <button onClick={() => doGenerateDesc()} disabled={descLoading}
              style={{ ...S.regenBtn, position: "absolute", top: 8, right: 8 }}>
              {descLoading ? "..." : "↻"}
            </button>
          </div>
          <p style={{ fontSize: 11, color: "#A8A4A0", marginTop: 4 }}>{description.length} chars</p>
        </div>

        {/* SECTION 4 — DETAILS */}
        <div style={S.section}>
          <p style={S.label}>Category</p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
            {CATEGORIES.map((c) => (
              <button key={c} onClick={() => { setCategory(c); save({ detected_category: c }); }}
                style={category === c ? S.toggleActive : S.toggle}>{c}</button>
            ))}
          </div>

          <p style={S.label}>Gender</p>
          <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
            {GENDERS.map((g) => (
              <button key={g} onClick={() => { setGender(g); save({ gender: g }); }}
                style={gender === g ? S.toggleActive : S.toggle}>{GENDER_LABELS[g]}</button>
            ))}
          </div>

          <p style={S.label}>Price</p>
          <input value={price} onChange={(e) => setPrice(e.target.value)}
            onBlur={() => save({ edited_price: parseFloat(price) || null })}
            type="number" style={S.priceInput} placeholder="0" />
          {costCalc && <p style={{ fontSize: 11, color: "#A8A4A0", marginTop: 4 }}>{costCalc}</p>}

          {colors.length > 0 && (
            <>
              <p style={{ ...S.label, marginTop: 16 }}>Colors</p>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {colors.map((c, i) => (
                  <input key={i} value={c} onChange={(e) => {
                    const next = [...colors]; next[i] = e.target.value; setColors(next);
                  }} onBlur={() => save({ edited_colors: colors })}
                    style={{ ...S.toggle, width: "auto", minWidth: 60, textAlign: "center" }} />
                ))}
              </div>
            </>
          )}

          <p style={{ ...S.label, marginTop: 16 }}>Sizes</p>
          <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
            {SIZES.map((s) => (
              <button key={s} onClick={() => {
                const next = sizes.includes(s) ? sizes.filter((x) => x !== s) : [...sizes, s];
                setSizes(next);
                save({ edited_sizes: next });
              }} style={sizes.includes(s) ? S.toggleActive : S.toggle}>{s}</button>
            ))}
          </div>
        </div>
      </div>

      {/* BOTTOM ACTIONS */}
      <div style={S.bottomBar}>
        <button onClick={doSkip} style={S.skipBtn}>Skip for now</button>
        <button onClick={doPublish} disabled={publishing} style={S.publishBtn}>
          {publishing ? "Publishing..." : "Publish to Shopify →"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const S = {
  full: { minHeight: "100vh", background: "#F5F2ED", display: "flex", flexDirection: "column" },
  topBar: { display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid #D9D4CE", flexShrink: 0 },
  backBtn: { background: "none", border: "none", fontSize: 18, cursor: "pointer", padding: "4px 8px", color: "#1A1A1A" },
  scrollArea: { flex: 1, overflowY: "auto", paddingBottom: 100 },
  section: { padding: "16px" },
  heroImg: { width: "100%", borderRadius: 6, aspectRatio: "4/5", objectFit: "cover" },
  halfImg: { width: "100%", borderRadius: 4, aspectRatio: "4/5", objectFit: "cover" },
  label: { fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", color: "#8A8580", marginBottom: 6, textTransform: "uppercase" },
  nameInput: {
    flex: 1, fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 24, fontWeight: 300,
    textTransform: "uppercase", letterSpacing: "0.08em", border: "none", background: "none",
    borderBottom: "1px solid #D9D4CE", padding: "8px 0", outline: "none", color: "#1A1A1A",
  },
  textarea: {
    width: "100%", border: "1px solid #D9D4CE", borderRadius: 4, padding: "10px 12px",
    fontSize: 14, lineHeight: 1.6, background: "#fff", resize: "vertical", outline: "none",
    fontFamily: "'Helvetica Neue', sans-serif",
  },
  priceInput: {
    width: 120, fontSize: 20, fontWeight: 300, border: "none", borderBottom: "1px solid #D9D4CE",
    background: "none", padding: "8px 0", outline: "none",
  },
  regenBtn: {
    width: 36, height: 36, borderRadius: "50%", border: "1px solid #D9D4CE",
    background: "#fff", fontSize: 16, cursor: "pointer", display: "flex",
    alignItems: "center", justifyContent: "center", flexShrink: 0,
  },
  toggle: {
    padding: "8px 14px", fontSize: 12, border: "1px solid #D9D4CE", background: "#fff",
    borderRadius: 4, cursor: "pointer", color: "#6B6B6B", minHeight: 36,
  },
  toggleActive: {
    padding: "8px 14px", fontSize: 12, border: "1px solid #1A1A1A", background: "#1A1A1A",
    borderRadius: 4, cursor: "pointer", color: "#F5F2ED", minHeight: 36,
  },
  actionBtn: {
    flex: 1, padding: "10px 16px", fontSize: 13, border: "1px solid #D9D4CE",
    background: "#fff", borderRadius: 6, cursor: "pointer", minHeight: 44,
  },
  accentBtn: {
    flex: 1, padding: "10px 16px", fontSize: 13, border: "none",
    background: "#C4A882", color: "#fff", borderRadius: 6, cursor: "pointer", minHeight: 44,
  },
  link: { fontSize: 12, color: "#A8A4A0", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" },
  bottomBar: {
    position: "fixed", bottom: 0, left: 0, right: 0, display: "flex", gap: 8,
    padding: "12px 16px", paddingBottom: "calc(12px + env(safe-area-inset-bottom))",
    background: "#F5F2ED", borderTop: "1px solid #D9D4CE",
  },
  skipBtn: {
    flex: 1, padding: "14px", fontSize: 14, fontWeight: 500, border: "1px solid #D9D4CE",
    background: "#fff", borderRadius: 8, cursor: "pointer", minHeight: 50,
  },
  publishBtn: {
    flex: 1, padding: "14px", fontSize: 14, fontWeight: 500, border: "none",
    background: "#1A1A1A", color: "#F5F2ED", borderRadius: 8, cursor: "pointer", minHeight: 50,
  },
  toast: {
    position: "fixed", top: 60, left: "50%", transform: "translateX(-50%)", zIndex: 200,
    background: "#1A1A1A", color: "#F5F2ED", padding: "8px 20px", borderRadius: 6,
    fontSize: 13, fontWeight: 500,
  },
  muted: { fontSize: 13, color: "#8A8580" },
};
