import { useEffect, useState, useCallback } from "react";
import { getLaunch, returnFromLaunch, publishItem } from "../../lib/api";
import { useCounts } from "../../lib/CountsContext";
import LaunchCard from "../../components/LaunchCard";

export default function LaunchPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const { refresh: refreshCounts } = useCounts();

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    setError(null);
    getLaunch()
      .then((data) => setItems(data.items || []))
      .catch((err) => { if (!silent) setError(err.message); })
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleReturn = async (id) => {
    await returnFromLaunch(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    refreshCounts();
  };

  const handlePublish = async (id) => {
    await publishItem(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    refreshCounts();
  };

  if (loading) {
    return <div style={S.center}><p style={S.muted}>Loading launch items...</p></div>;
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
          <h1 style={S.title}>Launch</h1>
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
              <path d="M22 2L15 22l-4-9-9-4L22 2z" />
            </svg>
          </div>
          <p style={S.emptyText}>No launch-ready items.</p>
          <p style={S.emptyHint}>Items moved from Approved will appear here for final review before publishing.</p>
        </div>
      ) : (
        <div style={S.grid}>
          {items.map((item) => (
            <LaunchCard
              key={item.id}
              item={item}
              onReturn={handleReturn}
              onPublish={handlePublish}
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
