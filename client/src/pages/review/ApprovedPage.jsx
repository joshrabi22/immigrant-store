import { useEffect, useState, useCallback } from "react";
import { getApproved, updateApproved, moveToLaunch, removeApproved } from "../../lib/api";
import { useCounts } from "../../lib/CountsContext";
import ApprovedCard from "../../components/ApprovedCard";

export default function ApprovedPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const { refresh: refreshCounts } = useCounts();

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    getApproved()
      .then((data) => setItems(data.items || []))
      .catch((err) => { if (!silent) setError(err.message); })
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (id, fields) => {
    const updated = await updateApproved(id, fields);
    setItems((prev) => prev.map((i) => (i.id === id ? updated : i)));
  };

  const handleLaunch = async (id) => {
    await moveToLaunch(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    refreshCounts();
  };

  const handleRemove = async (id) => {
    await removeApproved(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    refreshCounts();
  };

  if (loading) {
    return <div style={S.center}><p style={S.muted}>Loading approved items...</p></div>;
  }

  if (error) {
    return (
      <div style={S.center}>
        <p style={S.error}>{error}</p>
        <button onClick={() => load()} style={S.retryBtn}>Retry</button>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerLeft}>
          <h1 style={S.title}>Approved</h1>
          <span style={S.count}>{items.length} items</span>
        </div>
        <button
          style={S.refreshBtn}
          onClick={() => load(true)}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {/* Empty */}
      {items.length === 0 ? (
        <div style={S.emptyWrap}>
          <div style={S.emptyIcon}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.2">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 12l3 3 5-5" />
            </svg>
          </div>
          <p style={S.emptyText}>No approved items yet.</p>
          <p style={S.emptyHint}>Items accepted in Photo Suite will appear here.</p>
        </div>
      ) : (
        <div style={S.grid}>
          {items.map((item) => (
            <ApprovedCard
              key={item.id}
              item={item}
              onSave={handleSave}
              onLaunch={handleLaunch}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const S = {
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
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  headerLeft: {
    display: "flex",
    alignItems: "baseline",
    gap: 12,
  },
  title: {
    fontFamily: "'Cormorant Garamond', serif",
    fontWeight: 300,
    fontSize: 28,
    color: "#1A1A1A",
    margin: 0,
  },
  count: {
    fontSize: 13,
    color: "#999",
  },
  refreshBtn: {
    background: "none",
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "6px 14px",
    fontSize: 11,
    fontWeight: 500,
    color: "#6B6B6B",
    cursor: "pointer",
  },
  emptyWrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "40vh",
    color: "#999",
  },
  emptyIcon: { marginBottom: 12 },
  emptyText: {
    fontSize: 15,
    margin: "0 0 4px",
    color: "#6B6B6B",
  },
  emptyHint: {
    fontSize: 12,
    margin: 0,
    color: "#bbb",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 40,
  },
};
