import { useState } from "react";
import { resolveName, resolveDescription, resolvePrice } from "../lib/resolveContent";
import imgUrl from "../imgUrl";

const CATEGORIES = ["tops", "bottoms", "outerwear", "footwear", "jewelry", "belts", "accessories"];
const GENDERS = ["mens", "womens", "unisex"];

export default function ApprovedCard({ item, onSave, onLaunch, onRemove }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState(null); // "launch" | "remove"
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  // Edit form state — initialize from item
  const [form, setForm] = useState(() => initForm(item));

  function initForm(itm) {
    return {
      edited_name: itm.edited_name || itm.generated_name || itm.title || "",
      edited_description: itm.edited_description || itm.generated_description || "",
      edited_price: itm.edited_price ?? itm.price ?? "",
      detected_category: itm.detected_category || "",
      gender: itm.gender || "",
    };
  }

  const setField = (k, v) => setForm((p) => ({ ...p, [k]: v }));

  const name = resolveName(item);
  const description = resolveDescription(item);
  const price = resolvePrice(item);
  const image = item.processed_image_url || imgUrl(item);

  const approvedDate = item.approved_at
    ? new Date(item.approved_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;

  // Compute changed fields only
  const getChanges = () => {
    const changes = {};
    if (form.edited_name !== (item.edited_name || "")) changes.edited_name = form.edited_name;
    if (form.edited_description !== (item.edited_description || "")) changes.edited_description = form.edited_description;
    const formPrice = form.edited_price === "" ? null : Number(form.edited_price);
    if (formPrice !== (item.edited_price ?? null)) changes.edited_price = formPrice;
    if (form.detected_category !== (item.detected_category || "")) changes.detected_category = form.detected_category;
    if (form.gender !== (item.gender || "")) changes.gender = form.gender;
    return changes;
  };

  const handleSave = async () => {
    const changes = getChanges();
    if (Object.keys(changes).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(item.id, changes);
      setEditing(false);
      flashSuccess("Saved");
    } catch (err) {
      setError(err.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setForm(initForm(item));
    setEditing(false);
    setError(null);
  };

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

  const flashSuccess = (msg) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 2000);
  };

  const busy = saving || acting !== null;

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
        {!editing ? (
          <>
            <div style={S.name}>{name || "Untitled"}</div>
            {price != null && <div style={S.price}>${Number(price).toFixed(2)}</div>}
            {description && <p style={S.desc}>{description}</p>}
            <div style={S.metaRow}>
              {item.gender && <span style={S.tag}>{item.gender}</span>}
              {item.detected_category && <span style={S.tag}>{item.detected_category}</span>}
              {item.source && <span style={{ ...S.tag, color: "#999" }}>{item.source}</span>}
            </div>
            {approvedDate && <div style={S.approvedAt}>Approved {approvedDate}</div>}
          </>
        ) : (
          <div style={S.editForm}>
            <label style={S.label}>
              Name
              <input
                style={S.input}
                value={form.edited_name}
                onChange={(e) => setField("edited_name", e.target.value)}
              />
            </label>
            <label style={S.label}>
              Price
              <input
                style={S.input}
                type="number"
                step="0.01"
                value={form.edited_price}
                onChange={(e) => setField("edited_price", e.target.value)}
              />
            </label>
            <label style={S.label}>
              Description
              <textarea
                style={{ ...S.input, ...S.textarea }}
                value={form.edited_description}
                onChange={(e) => setField("edited_description", e.target.value)}
                rows={3}
              />
            </label>
            <div style={S.selectRow}>
              <label style={{ ...S.label, flex: 1 }}>
                Gender
                <select style={S.select} value={form.gender} onChange={(e) => setField("gender", e.target.value)}>
                  <option value="">—</option>
                  {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </label>
              <label style={{ ...S.label, flex: 1 }}>
                Category
                <select style={S.select} value={form.detected_category} onChange={(e) => setField("detected_category", e.target.value)}>
                  <option value="">—</option>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>
          </div>
        )}
      </div>

      {/* Feedback */}
      {error && (
        <div style={S.errorBar}>
          <span>{error}</span>
          <button style={S.dismissBtn} onClick={() => setError(null)}>dismiss</button>
        </div>
      )}
      {success && <div style={S.successBar}>{success}</div>}

      {/* Actions — hover-reveal style but always visible for now */}
      <div style={S.actions}>
        {!editing ? (
          <>
            <button style={S.editBtn} onClick={() => setEditing(true)} disabled={busy}>
              Edit
            </button>
            <div style={S.actionRight}>
              <button
                style={S.removeActionBtn}
                onClick={() => handleAction("remove", onRemove)}
                disabled={busy}
              >
                {acting === "remove" ? "..." : "Remove"}
              </button>
              <button
                style={S.launchBtn}
                onClick={() => handleAction("launch", onLaunch)}
                disabled={busy}
              >
                {acting === "launch" ? "Moving..." : "Move to Launch"}
              </button>
            </div>
          </>
        ) : (
          <>
            <button style={S.cancelBtn} onClick={handleCancel} disabled={saving}>
              Cancel
            </button>
            <button style={S.saveBtn} onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </>
        )}
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

  // Edit form
  editForm: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    fontSize: 9,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 1,
    color: "#999",
  },
  input: {
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "7px 10px",
    fontSize: 13,
    color: "#1A1A1A",
    fontWeight: 400,
    textTransform: "none",
    letterSpacing: 0,
    outline: "none",
    fontFamily: "inherit",
  },
  textarea: {
    resize: "vertical",
    minHeight: 50,
    lineHeight: 1.5,
  },
  selectRow: {
    display: "flex",
    gap: 10,
  },
  select: {
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "7px 8px",
    fontSize: 13,
    color: "#1A1A1A",
    fontWeight: 400,
    textTransform: "none",
    letterSpacing: 0,
    background: "#fff",
    outline: "none",
    width: "100%",
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
  successBar: {
    background: "#edf4ed",
    border: "1px solid #c8dcc8",
    margin: "0 16px 8px",
    borderRadius: 4,
    padding: "7px 12px",
    fontSize: 12,
    color: "#6B8E6B",
    fontWeight: 500,
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
  actionRight: {
    display: "flex",
    gap: 8,
  },
  editBtn: {
    background: "none",
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "6px 14px",
    fontSize: 11,
    fontWeight: 500,
    color: "#6B6B6B",
    cursor: "pointer",
  },
  removeActionBtn: {
    background: "#fdf0ed",
    border: "1px solid #f0c8be",
    borderRadius: 4,
    padding: "6px 14px",
    fontSize: 11,
    fontWeight: 600,
    color: "#D4644A",
    cursor: "pointer",
  },
  launchBtn: {
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
  cancelBtn: {
    background: "none",
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "6px 14px",
    fontSize: 11,
    fontWeight: 500,
    color: "#6B6B6B",
    cursor: "pointer",
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
    marginLeft: "auto",
  },
};
