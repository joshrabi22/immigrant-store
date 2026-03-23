import React, { useState, useEffect, useCallback } from "react";
import { getPicks, deletePick } from "../api";
import imgUrl from "../imgUrl";

const STATUS_DOT = {
  approved: { bg: "#D9D4CE", label: "saved" },       // grey
  editing: { bg: "#C4A882", label: "edited" },         // sand
  skipped: { bg: "#C4A882", label: "skipped" },        // sand
  published: { bg: "#1A1A1A", label: "live" },         // black
};

export default function PicksTab({ onStartEdit }) {
  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await getPicks();
    setPicks(data.picks);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRemove = async (id) => { await deletePick(id); load(); };

  const unedited = picks.filter((p) => p.status === "approved").length;

  if (loading) return <div style={{ padding: 24 }}><p style={{ color: "#8A8580" }}>Loading...</p></div>;

  return (
    <div style={{ padding: "16px", maxWidth: 1200, margin: "0 auto" }}>
      {/* Header + Start Editing button */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 24, fontWeight: 300 }}>my picks</h1>
        <span style={{ fontSize: 13, color: "#8A8580" }}>{picks.length} items</span>
      </div>

      {unedited > 0 && (
        <button onClick={() => onStartEdit()} style={{
          width: "100%", padding: "14px", fontSize: 14, fontWeight: 500, letterSpacing: "0.04em",
          background: "#C4A882", color: "#fff", border: "none", borderRadius: 8,
          cursor: "pointer", marginBottom: 20, minHeight: 50,
        }}>
          Start Editing ({unedited} unedited)
        </button>
      )}

      {picks.length === 0 && (
        <p style={{ textAlign: "center", padding: 60, color: "#8A8580" }}>
          No picks yet. Swipe to approve products.
        </p>
      )}

      <div style={{ columnCount: 3, columnGap: 12 }}>
        {picks.map((p) => {
          const img = imgUrl(p);
          const dot = STATUS_DOT[p.status] || STATUS_DOT.approved;

          return (
            <div key={p.id} style={{
              breakInside: "avoid", marginBottom: 12, background: "#fff",
              borderRadius: 6, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
            }}>
              {img && (
                <div style={{ position: "relative", cursor: "pointer" }} onClick={() => onStartEdit(p.id)}>
                  <img src={img} alt="" style={{ width: "100%", display: "block" }} />
                  {/* Status dot */}
                  <div style={{
                    position: "absolute", top: 8, right: 8,
                    width: 10, height: 10, borderRadius: "50%",
                    background: dot.bg, border: "2px solid rgba(255,255,255,0.8)",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                  }} title={dot.label} />
                </div>
              )}
              <div style={{ padding: "8px 12px" }}>
                <p style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 13, fontWeight: 300, margin: "0 0 4px" }}>
                  {p.edited_name || p.immigrant_name || p.title?.substring(0, 35)}
                </p>
                <div style={{ fontSize: 11, color: "#8A8580", display: "flex", justifyContent: "space-between" }}>
                  <span>{p.edited_price ? `$${p.edited_price}` : p.price ? `$${p.price}` : ""}</span>
                  <button onClick={(e) => { e.stopPropagation(); handleRemove(p.id); }}
                    style={{ fontSize: 10, border: "1px solid #cc6666", background: "none", borderRadius: 3, color: "#cc6666", cursor: "pointer", padding: "1px 6px" }}>
                    ×
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
