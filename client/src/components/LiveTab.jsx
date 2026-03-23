import React, { useState, useEffect, useCallback } from "react";
import { getLive, unpublishItem } from "../api";

export default function LiveTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await getLive();
    setItems(data.items);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleUnpublish = async (id) => {
    await unpublishItem(id);
    load();
  };

  if (loading) return <div style={{ padding: 24 }}><p style={{ color: "#8A8580" }}>Loading...</p></div>;

  return (
    <div style={{ padding: "16px", maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 24, fontWeight: 300 }}>live</h1>
        <span style={{ fontSize: 13, color: "#8A8580" }}>{items.length} products live</span>
      </div>

      {items.length === 0 && (
        <div style={{ textAlign: "center", padding: 60 }}>
          <p style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 22, fontWeight: 300, color: "#8A8580" }}>
            Nothing live yet
          </p>
          <p style={{ fontSize: 13, color: "#A8A4A0", marginTop: 8 }}>Start editing your picks.</p>
        </div>
      )}

      <div style={{ columnCount: 3, columnGap: 12 }}>
        {items.map((item) => {
          const img = item.image_path ? `/images/${item.image_path.replace("images/", "")}` : null;
          const storeUrl = item.shopify_url || (item.shopify_product_id ? `https://${item.shopify_url || "22immigrant.myshopify.com"}/products/${item.shopify_product_id}` : null);

          return (
            <div key={item.id} style={{
              breakInside: "avoid", marginBottom: 12, background: "#fff",
              borderRadius: 6, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
            }}>
              {img && (
                <div style={{ position: "relative" }}>
                  <img src={img} alt="" style={{ width: "100%", display: "block" }} />
                  <div style={{
                    position: "absolute", top: 8, right: 8,
                    width: 10, height: 10, borderRadius: "50%",
                    background: "#34C759", border: "2px solid rgba(255,255,255,0.8)",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                  }} />
                </div>
              )}
              <div style={{ padding: "8px 12px" }}>
                <p style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 13, fontWeight: 300, margin: "0 0 4px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {item.edited_name || item.immigrant_name || item.title?.substring(0, 35)}
                </p>
                <p style={{ fontSize: 13, color: "#C4A882", margin: "0 0 8px" }}>
                  ${item.edited_price || item.retail_price || "—"}
                </p>
                <div style={{ display: "flex", gap: 6 }}>
                  {storeUrl && (
                    <a href={storeUrl} target="_blank" rel="noopener"
                      style={{ fontSize: 11, color: "#C4A882", textDecoration: "none" }}>
                      View on store →
                    </a>
                  )}
                  <button onClick={() => handleUnpublish(item.id)}
                    style={{ fontSize: 10, marginLeft: "auto", border: "1px solid #cc6666", background: "none", borderRadius: 3, color: "#cc6666", cursor: "pointer", padding: "2px 6px" }}>
                    unpublish
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
