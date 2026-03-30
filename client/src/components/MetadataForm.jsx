import { useState, useEffect } from "react";
import { resolveName, resolveDescription } from "../lib/resolveContent";

const GENDERS = ["mens", "womens", "unisex"];
const CATEGORIES = ["tops", "bottoms", "outerwear", "footwear", "jewelry", "belts", "accessories"];

// Deterministic name generation from category + color keywords
const STYLE_MAP = {
  hoodie: "Cloak", "t-shirt": "Frame", tee: "Frame", sweater: "Form",
  jacket: "Shell", coat: "Shell", pants: "Line", trousers: "Line",
  shorts: "Line", jeans: "Line", denim: "Line", vest: "Layer",
  shirt: "Frame", polo: "Frame", cardigan: "Form", blazer: "Shell",
  skirt: "Line", dress: "Silhouette", bag: "Hold", hat: "Crown",
  cap: "Crown", sneaker: "Stride", boot: "Stride", shoe: "Stride",
  belt: "Band", ring: "Loop", necklace: "Arc", bracelet: "Coil",
  earring: "Drop",
};

const COLOR_MAP = {
  green: "Verdant", black: "Noir", white: "Chalk", blue: "Slate",
  red: "Oxide", grey: "Ash", gray: "Ash", brown: "Umber",
  navy: "Slate", beige: "Sand", cream: "Ivory", pink: "Blush",
  purple: "Plum", orange: "Ember", yellow: "Sol", olive: "Moss",
  rust: "Oxide", tan: "Sand", khaki: "Sand", burgundy: "Claret",
  maroon: "Claret", teal: "Verdigris", indigo: "Indigo",
};

function generateName(item) {
  const title = (item.title || "").toLowerCase();

  // Find color
  let colorWord = null;
  for (const [key, val] of Object.entries(COLOR_MAP)) {
    if (title.includes(key)) { colorWord = val; break; }
  }

  // Find style
  let styleWord = null;
  for (const [key, val] of Object.entries(STYLE_MAP)) {
    if (title.includes(key)) { styleWord = val; break; }
  }

  const parts = [];
  if (colorWord) parts.push(colorWord);
  parts.push("0000");
  if (styleWord) parts.push(styleWord);

  if (parts.length <= 1) return null; // nothing useful extracted
  return parts.join(" ");
}

export default function MetadataForm({ item, onSave, saving, nameDescSupported = false }) {
  const [gender, setGender] = useState(item.gender || "unisex");
  const [category, setCategory] = useState(item.detected_category || "");
  const [price, setPrice] = useState(item.edited_price ?? item.price ?? "");
  const [editedName, setEditedName] = useState(item.edited_name || "");
  const [editedDesc, setEditedDesc] = useState(item.edited_description || "");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setGender(item.gender || "unisex");
    setCategory(item.detected_category || "");
    setPrice(item.edited_price ?? item.price ?? "");
    setEditedName(item.edited_name || "");
    setEditedDesc(item.edited_description || "");
    setDirty(false);
  }, [item.id]);

  const change = (setter) => (e) => { setter(e.target.value); setDirty(true); };

  const handleGenerate = () => {
    const suggested = generateName(item);
    if (suggested) {
      setEditedName(suggested);
      setDirty(true);
    }
  };

  const handleSave = async () => {
    const data = {};
    if (gender !== (item.gender || "unisex")) data.gender = gender;
    if (category !== (item.detected_category || "")) data.detected_category = category;
    const numPrice = price === "" ? undefined : Number(price);
    if (numPrice !== undefined && !isNaN(numPrice) && numPrice !== (item.edited_price ?? item.price)) {
      data.edited_price = numPrice;
    }
    if (nameDescSupported) {
      if (editedName !== (item.edited_name || "")) data.edited_name = editedName;
      if (editedDesc !== (item.edited_description || "")) data.edited_description = editedDesc;
    }
    if (Object.keys(data).length === 0) { setDirty(false); return; }
    await onSave(data);
    setDirty(false);
  };

  return (
    <div>
      <div style={S.sectionLabel}>Metadata</div>

      {/* Name */}
      <div style={S.field}>
        <label style={S.fieldLabel}>Name</label>
        {nameDescSupported ? (
          <>
            <input
              type="text"
              style={S.input}
              value={editedName}
              onChange={change(setEditedName)}
              placeholder={item.title || "Untitled"}
            />
            <button
              type="button"
              style={S.generateBtn}
              onClick={handleGenerate}
              title="Generate a suggested name from title keywords"
            >
              Suggest Name
            </button>
          </>
        ) : (
          <div style={S.readOnly}>{resolveName(item)}</div>
        )}
      </div>

      {/* Description */}
      <div style={S.field}>
        <label style={S.fieldLabel}>Description</label>
        {nameDescSupported ? (
          <textarea
            style={{ ...S.input, minHeight: 60, resize: "vertical" }}
            value={editedDesc}
            onChange={change(setEditedDesc)}
            placeholder="Add a description…"
          />
        ) : (
          <div style={S.readOnly}>
            {resolveDescription(item) || <em style={{ color: "#bbb" }}>No description</em>}
          </div>
        )}
      </div>

      <div style={S.divider} />

      <div style={S.field}>
        <label style={S.fieldLabel}>Gender</label>
        <select style={S.select} value={gender} onChange={change(setGender)}>
          {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      </div>

      <div style={S.field}>
        <label style={S.fieldLabel}>Category</label>
        <select style={S.select} value={category} onChange={change(setCategory)}>
          <option value="">— select —</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div style={S.field}>
        <label style={S.fieldLabel}>Price</label>
        <input
          type="number"
          step="0.01"
          style={S.input}
          value={price}
          onChange={change(setPrice)}
          placeholder="0.00"
        />
      </div>

      {dirty && (
        <button style={S.saveBtn} onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save Metadata"}
        </button>
      )}
    </div>
  );
}

const S = {
  sectionLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "#1A1A1A",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 16,
  },
  field: {
    marginBottom: 14,
  },
  fieldLabel: {
    display: "block",
    fontSize: 11,
    color: "#6B6B6B",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontWeight: 500,
  },
  select: {
    width: "100%",
    padding: "8px 10px",
    fontSize: 13,
    border: "1px solid #ddd",
    borderRadius: 4,
    background: "#fff",
    color: "#1A1A1A",
    boxSizing: "border-box",
  },
  input: {
    width: "100%",
    padding: "8px 10px",
    fontSize: 13,
    border: "1px solid #ddd",
    borderRadius: 4,
    background: "#fff",
    color: "#1A1A1A",
    boxSizing: "border-box",
    fontFamily: "inherit",
  },
  readOnly: {
    fontSize: 13,
    color: "#1A1A1A",
    lineHeight: 1.5,
    padding: "6px 0",
  },
  generateBtn: {
    display: "inline-block",
    marginTop: 6,
    background: "none",
    border: "1px solid #C4A882",
    color: "#9A8A6E",
    borderRadius: 4,
    padding: "4px 12px",
    fontSize: 11,
    fontWeight: 500,
    cursor: "pointer",
  },
  divider: {
    borderTop: "1px solid #eee",
    margin: "16px 0",
  },
  saveBtn: {
    background: "#1A1A1A",
    color: "#F5F2ED",
    border: "none",
    borderRadius: 4,
    padding: "8px 20px",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 4,
    width: "100%",
  },
};
