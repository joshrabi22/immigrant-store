import { useEffect, useState, useCallback, useRef } from "react";
import { getIntake, approveIntake, rejectIntake } from "../lib/api";
import { useCounts } from "../lib/CountsContext";
import IntakeCard from "./IntakeCard";

export default function IntakeGrid({ source, title }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [focusIdx, setFocusIdx] = useState(0);
  const [undoState, setUndoState] = useState(null); // { id, action, prevItems, timer }
  const undoRef = useRef(null); // mirrors undoState to avoid stale closures
  const { refresh } = useCounts();
  const gridRef = useRef(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getIntake(source)
      .then((data) => {
        setItems(data.items || []);
        setFocusIdx(0);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [source]);

  useEffect(() => { load(); }, [load]);

  // Keep focusIdx in bounds when items change
  useEffect(() => {
    if (focusIdx >= items.length && items.length > 0) {
      setFocusIdx(items.length - 1);
    }
  }, [items.length, focusIdx]);

  // Commit a pending undo (actually fire the API call)
  const commitAction = useCallback(async (actionId, action) => {
    try {
      if (action === "approve") {
        await approveIntake(actionId);
      } else {
        await rejectIntake(actionId);
      }
      refresh();   // update sidebar badge counts
      load();      // refetch item list from server to stay in sync
    } catch (err) {
      // On API error, we can't restore — the item is already removed from the list
      // and the undo window has passed. Show error instead.
      setError(err.message || `${action} failed`);
      load();      // refetch to restore server truth on error
    }
  }, [refresh, load]);

  // Optimistic remove with undo window
  const handleAction = useCallback((id, action) => {
    // If there's a pending undo for a DIFFERENT item, commit it immediately
    const pending = undoRef.current;
    if (pending && pending.id !== id) {
      clearTimeout(pending.timer);
      commitAction(pending.id, pending.action);
    }

    setItems((prev) => {
      const newItems = prev.filter((i) => i.id !== id);

      // Start undo timer — auto-commit after 5 seconds
      const timer = setTimeout(() => {
        commitAction(id, action);
        undoRef.current = null;
        setUndoState(null);
      }, 5000);

      const newUndo = { id, action, prevItems: prev, timer };
      undoRef.current = newUndo;
      setUndoState(newUndo);

      return newItems;
    });
  }, [commitAction]);

  const handleApprove = useCallback((id) => {
    handleAction(id, "approve");
  }, [handleAction]);

  const handleReject = useCallback((id) => {
    handleAction(id, "reject");
  }, [handleAction]);

  // Undo handler — restore items and cancel the pending API call
  const handleUndo = useCallback(() => {
    const pending = undoRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    setItems(pending.prevItems);
    undoRef.current = null;
    setUndoState(null);
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't capture if user is typing in an input
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") {
        return;
      }
      if (items.length === 0) return;

      const focusedItem = items[focusIdx];
      if (!focusedItem) return;

      switch (e.key.toLowerCase()) {
        case "a":
          e.preventDefault();
          handleApprove(focusedItem.id);
          break;
        case "r":
          e.preventDefault();
          handleReject(focusedItem.id);
          break;
        case "j":
        case "arrowdown":
          e.preventDefault();
          setFocusIdx((prev) => Math.min(prev + 1, items.length - 1));
          break;
        case "k":
        case "arrowup":
          e.preventDefault();
          setFocusIdx((prev) => Math.max(prev - 1, 0));
          break;
        case "arrowright":
          e.preventDefault();
          setFocusIdx((prev) => Math.min(prev + 1, items.length - 1));
          break;
        case "arrowleft":
          e.preventDefault();
          setFocusIdx((prev) => Math.max(prev - 1, 0));
          break;
        case "z":
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            handleUndo();
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [items, focusIdx, handleApprove, handleReject, handleUndo]);

  // Scroll focused card into view
  useEffect(() => {
    if (!gridRef.current) return;
    const cards = gridRef.current.children;
    if (cards[focusIdx]) {
      cards[focusIdx].scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [focusIdx]);

  if (loading) {
    return (
      <div style={S.center}>
        <p style={S.muted}>Loading {title.toLowerCase()}...</p>
      </div>
    );
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
        <h1 style={S.title}>{title}</h1>
        <span style={S.count}>{items.length} items</span>
        <span style={S.kbHint}>
          <kbd style={S.kbd}>A</kbd> approve
          <kbd style={{ ...S.kbd, marginLeft: 8 }}>R</kbd> reject
          <kbd style={{ ...S.kbd, marginLeft: 8 }}>&larr;&rarr;</kbd> navigate
        </span>
      </div>
      {items.length === 0 ? (
        <div style={S.center}>
          <p style={S.muted}>No items in {title.toLowerCase()}.</p>
        </div>
      ) : (
        <div style={S.grid} ref={gridRef}>
          {items.map((item, idx) => (
            <IntakeCard
              key={item.id}
              item={item}
              focused={idx === focusIdx}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ))}
        </div>
      )}

      {/* Undo toast */}
      {undoState && (
        <div style={S.undoToast}>
          <span>
            Item {undoState.action === "approve" ? "approved → Staging" : "rejected"}
          </span>
          <button style={S.undoBtn} onClick={handleUndo}>Undo</button>
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
    flexWrap: "wrap",
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
  kbHint: {
    fontSize: 11,
    color: "#bbb",
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  kbd: {
    display: "inline-block",
    background: "#f0ede8",
    border: "1px solid #e0ddd8",
    borderRadius: 3,
    padding: "1px 5px",
    fontSize: 10,
    fontFamily: "monospace",
    color: "#6B6B6B",
    lineHeight: "16px",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 40,
  },
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "50vh",
  },
  muted: {
    color: "#999",
    fontSize: 14,
  },
  error: {
    color: "#c44",
    fontSize: 14,
  },
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
  undoToast: {
    position: "fixed",
    bottom: 24,
    right: 24,
    background: "#1A1A1A",
    color: "#F5F2ED",
    fontSize: 13,
    fontWeight: 500,
    padding: "10px 16px",
    borderRadius: 6,
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
    zIndex: 9999,
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  undoBtn: {
    background: "none",
    border: "1px solid rgba(245,242,237,0.4)",
    borderRadius: 4,
    color: "#C4A882",
    fontSize: 12,
    fontWeight: 600,
    padding: "3px 10px",
    cursor: "pointer",
  },
};
