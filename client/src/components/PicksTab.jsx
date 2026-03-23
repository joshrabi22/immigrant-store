import React, { useState, useEffect, useCallback } from "react";
import { getPicks, deletePick } from "../api";

export default function PicksTab() {
  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await getPicks();
    setPicks(data.picks);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRemove = async (id) => {
    await deletePick(id);
    load();
  };

  if (loading) return <div style={{ padding: 24 }}><p style={{ color: "#8A8580" }}>Loading...</p></div>;

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 24, fontWeight: 300 }}>
          my picks
        </h1>
        <span style={{ fontSize: 13, color: "#8A8580" }}>{picks.length} items</span>
      </div>

      {picks.length === 0 && (
        <p style={{ textAlign: "center", padding: 60, color: "#8A8580" }}>
          No picks yet. Swipe to approve products.
        </p>
      )}

      <div style={{ columnCount: 3, columnGap: 16 }}>
        {picks.map((p) => {
          const imgSrc = p.image_path
            ? `/images/${p.image_path.replace("images/", "")}`
            : p.image_url;

          return (
            <div key={p.id} style={{
              breakInside: "avoid",
              marginBottom: 16,
              background: "#fff",
              borderRadius: 6,
              overflow: "hidden",
              boxShadow: "0 1px 6px rgba(0,0,0,0.05)",
            }}>
              {imgSrc && (
                <a href={p.product_url} target="_blank" rel="noopener">
                  <img src={imgSrc} alt={p.title} style={{ width: "100%", display: "block" }} />
                </a>
              )}
              <div style={{ padding: "10px 14px" }}>
                <h3 style={{
                  fontFamily: "'Cormorant Garamond', Georgia, serif",
                  fontSize: 14, fontWeight: 300, margin: "0 0 4px",
                }}>
                  {p.title}
                </h3>
                <div style={{ fontSize: 12, color: "#8A8580", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>{p.price ? `$${p.price}` : ""} · {p.source}</span>
                  <button
                    onClick={() => handleRemove(p.id)}
                    style={{
                      fontSize: 11, padding: "2px 8px", border: "1px solid #cc6666",
                      background: "none", borderRadius: 3, color: "#cc6666", cursor: "pointer",
                    }}
                  >
                    remove
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
