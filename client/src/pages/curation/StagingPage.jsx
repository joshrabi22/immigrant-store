import { useEffect, useState, useCallback } from "react";
import { getStaging, processItem, removeFromStaging } from "../../lib/api";
import { useCounts } from "../../lib/CountsContext";
import StagingCard from "../../components/StagingCard";

export default function StagingPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { refresh } = useCounts();

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getStaging()
      .then((data) => setItems(data.items || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleProcess = async (id) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    await processItem(id);
    refresh();
  };

  const handleRemove = async (id) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
    await removeFromStaging(id);
    refresh();
  };

  if (loading) {
    return <div style={S.center}><p style={S.muted}>Loading staging…</p></div>;
  }

  if (error) {
    return (
      <div style={S.center}>
        <p style={S.error}>{error}</p>
        <button onClick={load} style={S.retryBtn}>Retry</button>
      </div>
    );
  }

  return (
    <div>
      <div style={S.header}>
        <h1 style={S.title}>Staging</h1>
        <span style={S.count}>{items.length} items</span>
      </div>
      {items.length === 0 ? (
        <div style={S.center}><p style={S.muted}>No items in staging.</p></div>
      ) : (
        <div style={S.grid}>
          {items.map((item) => (
            <StagingCard
              key={item.id}
              item={item}
              onProcess={handleProcess}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const S = {
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: 12,
    marginBottom: 24,
  },
  title: {
    fontFamily: "'Cormorant Garamond', serif",
    fontWeight: 300,
    fontSize: 28,
    color: "#1A1A1A",
    margin: 0,
  },
  count: { fontSize: 13, color: "#999" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 16,
  },
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "50vh",
  },
  muted: { color: "#999", fontSize: 14 },
  error: { color: "#c44", fontSize: 14 },
  retryBtn: {
    marginTop: 12,
    background: "#1A1A1A",
    color: "#F5F2ED",
    border: "none",
    borderRadius: 4,
    padding: "8px 20px",
    fontSize: 12,
    cursor: "pointer",
  },
};
