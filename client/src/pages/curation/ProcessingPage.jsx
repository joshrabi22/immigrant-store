import { useEffect, useState, useCallback, useRef } from "react";
import { getProcessing, retryProcessing, returnProcessing } from "../../lib/api";
import { useCounts } from "../../lib/CountsContext";
import ProcessingRow from "../../components/ProcessingRow";

const REFRESH_MS = 10000;

export default function ProcessingPage() {
  const [items, setItems] = useState([]);
  const [initialLoad, setInitialLoad] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const { refresh: refreshCounts } = useCounts();
  const timerRef = useRef(null);

  // Flicker-free load: only show full loading state on first fetch
  const load = useCallback((silent = false) => {
    if (!silent) setInitialLoad(true);
    else setRefreshing(true);
    setError(null);
    getProcessing()
      .then((data) => setItems(data.items || []))
      .catch((err) => { if (!silent) setError(err.message); })
      .finally(() => { setInitialLoad(false); setRefreshing(false); });
  }, []);

  // Initial load + auto-refresh
  useEffect(() => {
    load();
    timerRef.current = setInterval(() => load(true), REFRESH_MS);
    return () => clearInterval(timerRef.current);
  }, [load]);

  const handleRetry = async (id) => {
    await retryProcessing(id);
    // Update item in place to show pending status
    setItems((prev) => prev.map((i) =>
      i.id === id ? { ...i, processing_status: "pending", latest_job_error: null } : i
    ));
    refreshCounts();
  };

  const handleReturn = async (id) => {
    await returnProcessing(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    refreshCounts();
  };

  // Counts by status
  const failed = items.filter((i) => i.processing_status === "failed").length;
  const active = items.filter((i) => i.processing_status === "processing").length;
  const pending = items.filter((i) => i.processing_status === "pending").length;

  if (initialLoad) {
    return <div style={S.center}><p style={S.muted}>Loading processing queue…</p></div>;
  }

  if (error) {
    return (
      <div style={S.center}>
        <p style={S.error}>{error}</p>
        <button onClick={() => load()} style={S.retryLoadBtn}>Retry</button>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerLeft}>
          <h1 style={S.title}>Processing</h1>
          <span style={S.totalCount}>{items.length} items</span>
        </div>
        <button
          style={S.refreshBtn}
          onClick={() => load(true)}
          disabled={refreshing}
        >
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Status chips */}
      {items.length > 0 && (
        <div style={S.chips}>
          {failed > 0 && (
            <span style={{ ...S.chip, background: "#fdf0ed", color: "#D4644A", borderColor: "#f0c8be" }}>
              {failed} failed
            </span>
          )}
          {active > 0 && (
            <span style={{ ...S.chip, background: "#f0f4fd", color: "#5B7FD4", borderColor: "#c8d5f0" }}>
              {active} processing
            </span>
          )}
          {pending > 0 && (
            <span style={{ ...S.chip, background: "#f8f7f4", color: "#9A8A6E", borderColor: "#e0ddd8" }}>
              {pending} pending
            </span>
          )}
        </div>
      )}

      {/* List */}
      {items.length === 0 ? (
        <div style={S.emptyState}>
          <div style={S.emptyIcon}>◎</div>
          <p style={S.emptyText}>No items in processing.</p>
          <p style={S.emptyHint}>Items sent from Staging will appear here.</p>
        </div>
      ) : (
        <div style={S.list}>
          {items.map((item) => (
            <ProcessingRow
              key={item.id}
              item={item}
              onRetry={handleRetry}
              onReturn={handleReturn}
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
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
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
  totalCount: {
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
  chips: {
    display: "flex",
    gap: 8,
    marginBottom: 20,
  },
  chip: {
    fontSize: 11,
    fontWeight: 600,
    padding: "4px 12px",
    borderRadius: 20,
    border: "1px solid",
  },
  list: {
    maxWidth: 860,
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
  retryLoadBtn: {
    marginTop: 12,
    background: "#1A1A1A",
    color: "#F5F2ED",
    border: "none",
    borderRadius: 4,
    padding: "8px 20px",
    fontSize: 12,
    cursor: "pointer",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "40vh",
    color: "#999",
  },
  emptyIcon: {
    fontSize: 36,
    marginBottom: 12,
    color: "#ddd",
  },
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
};
