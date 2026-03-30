import { useEffect, useState, useCallback, useRef } from "react";
import {
  getPhotoSuiteReadyCount,
  startFlow,
  startSession,
  getNextReview,
  acceptReview,
  rejectReview,
  discardReview,
  abandonSession,
} from "../../lib/api";
import { useCounts } from "../../lib/CountsContext";
import { resolveImage } from "../../lib/resolveContent";
import PhotoSuiteReviewCard from "../../components/PhotoSuiteReviewCard";

// Preload an image URL into browser cache
function preloadImage(url) {
  if (!url) return;
  const img = new Image();
  img.src = url;
}

export default function PhotoSuitePage() {
  const { refresh: refreshCounts } = useCounts();

  // Session state
  const [readyCount, setReadyCount] = useState(null);
  const [session, setSession] = useState(null); // {id, mode, status, batch_size, items_accepted, ...}
  const [currentItem, setCurrentItem] = useState(null);
  const [done, setDone] = useState(false);

  // UI state
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(null); // "flow" | "session" | null
  const [fetching, setFetching] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [error, setError] = useState(null);
  const [batchSize, setBatchSize] = useState("10");

  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Load ready count
  const loadReadyCount = useCallback(async () => {
    try {
      const data = await getPhotoSuiteReadyCount();
      if (mountedRef.current) setReadyCount(data.count);
    } catch {
      // silent
    }
  }, []);

  // Fetch next item in session
  const fetchNext = useCallback(async () => {
    setFetching(true);
    setError(null);
    try {
      const data = await getNextReview();
      if (!mountedRef.current) return;
      if (data.done) {
        setCurrentItem(null);
        setDone(true);
        if (data.session) setSession(data.session);
      } else {
        // Preload hero image into browser cache for instant display
        preloadImage(resolveImage(data));
        setCurrentItem(data);
        setDone(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        // 404 means no active session — clear session state
        if (err.status === 404) {
          setSession(null);
          setCurrentItem(null);
          setDone(false);
        } else {
          setError(err.message || "Failed to load next item");
        }
      }
    } finally {
      if (mountedRef.current) setFetching(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    (async () => {
      setLoading(true);
      await loadReadyCount();
      // Try to resume an existing session
      try {
        const data = await getNextReview();
        if (data.done) {
          setDone(true);
          if (data.session) setSession(data.session);
        } else {
          // Infer active session from item
          setCurrentItem(data);
          setSession({ mode: "unknown", status: "active" });
        }
      } catch {
        // No active session — that's fine, stay in idle state
      }
      setLoading(false);
    })();
  }, [loadReadyCount]);

  // Start flow
  const handleStartFlow = async () => {
    setStarting("flow");
    setError(null);
    try {
      const sess = await startFlow();
      setSession(sess);
      setDone(false);
      await fetchNext();
      refreshCounts();
      loadReadyCount();
    } catch (err) {
      setError(err.message || "Failed to start flow");
    } finally {
      if (mountedRef.current) setStarting(null);
    }
  };

  // Start session
  const handleStartSession = async () => {
    const size = parseInt(batchSize, 10);
    if (!size || size < 1) {
      setError("Batch size must be a positive number");
      return;
    }
    setStarting("session");
    setError(null);
    try {
      const data = await startSession(size);
      setSession(data.session);
      setDone(false);
      await fetchNext();
      refreshCounts();
      loadReadyCount();
    } catch (err) {
      setError(err.message || "Failed to start session");
    } finally {
      if (mountedRef.current) setStarting(null);
    }
  };

  // Abandon session
  const handleAbandon = async () => {
    setAbandoning(true);
    setError(null);
    try {
      await abandonSession();
      setSession(null);
      setCurrentItem(null);
      setDone(false);
      refreshCounts();
      loadReadyCount();
    } catch (err) {
      setError(err.message || "Failed to abandon session");
    } finally {
      if (mountedRef.current) setAbandoning(false);
    }
  };

  // Review actions — return error string or null
  const handleAccept = async (id) => {
    await acceptReview(id);
  };
  const handleReject = async (id) => {
    await rejectReview(id);
  };
  const handleDiscard = async (id) => {
    await discardReview(id);
  };

  // Called by ReviewCard after a successful action
  const handleActionSuccess = async (actionName) => {
    refreshCounts();
    loadReadyCount();
    await fetchNext();
  };

  // Refresh
  const handleRefresh = async () => {
    await loadReadyCount();
    if (session) {
      await fetchNext();
    }
  };

  const isActive = session && !done;
  const reviewed = session
    ? (session.items_accepted || 0) + (session.items_rejected || 0) + (session.items_discarded || 0)
    : 0;

  if (loading) {
    return (
      <div style={S.center}>
        <p style={S.muted}>Loading Photo Suite...</p>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={S.header}>
        <div style={S.headerLeft}>
          <h1 style={S.title}>Photo Suite</h1>
          {readyCount != null && (
            <span style={S.readyBadge}>{readyCount} ready</span>
          )}
        </div>
        <div style={S.headerRight}>
          {session && (
            <button
              style={S.abandonBtn}
              onClick={handleAbandon}
              disabled={abandoning || starting !== null}
            >
              {abandoning ? "Abandoning..." : "Abandon Session"}
            </button>
          )}
          <button
            style={S.refreshBtn}
            onClick={handleRefresh}
            disabled={fetching}
          >
            {fetching ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Session info bar */}
      {session && (
        <div style={S.sessionBar}>
          <div style={S.sessionChips}>
            <span style={S.sessionChip}>
              {session.mode === "flow" ? "Flow Mode" : session.mode === "session" ? "Session Mode" : "Active Session"}
            </span>
            {session.id && (
              <span style={S.sessionId}>#{session.id.slice(0, 8)}</span>
            )}
            {session.batch_size && (
              <span style={S.sessionMeta}>batch: {session.batch_size}</span>
            )}
          </div>
          <div style={S.sessionStats}>
            {session.items_accepted > 0 && (
              <span style={S.statAccepted}>{session.items_accepted} accepted</span>
            )}
            {session.items_rejected > 0 && (
              <span style={S.statRejected}>{session.items_rejected} rejected</span>
            )}
            {session.items_discarded > 0 && (
              <span style={S.statDiscarded}>{session.items_discarded} discarded</span>
            )}
            {reviewed > 0 && <span style={S.sessionMeta}>{reviewed} reviewed</span>}
          </div>
        </div>
      )}

      {/* Error bar */}
      {error && (
        <div style={S.errorBar}>
          <span>{error}</span>
          <button style={S.errorDismiss} onClick={() => setError(null)}>dismiss</button>
        </div>
      )}

      {/* Main content */}
      {!session && !done && (
        <IdleState
          readyCount={readyCount}
          batchSize={batchSize}
          onBatchSizeChange={setBatchSize}
          onStartFlow={handleStartFlow}
          onStartSession={handleStartSession}
          starting={starting}
        />
      )}

      {session && done && (
        <DoneState session={session} onAbandon={handleAbandon} abandoning={abandoning} />
      )}

      {isActive && fetching && !currentItem && (
        <div style={S.center}>
          <p style={S.muted}>Loading next item...</p>
        </div>
      )}

      {isActive && currentItem && (
        <PhotoSuiteReviewCard
          item={currentItem}
          onAccept={handleAccept}
          onReject={handleReject}
          onDiscard={handleDiscard}
          onActionSuccess={handleActionSuccess}
        />
      )}

      {isActive && !fetching && !currentItem && !done && (
        <div style={S.center}>
          <p style={S.muted}>No item loaded. Try refreshing.</p>
        </div>
      )}
    </div>
  );
}

// ---------- Idle State ----------

function IdleState({ readyCount, batchSize, onBatchSizeChange, onStartFlow, onStartSession, starting }) {
  return (
    <div style={S.idleWrap}>
      <div style={S.idleIcon}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </div>
      <h2 style={S.idleTitle}>Photo Suite Review</h2>
      <p style={S.idleDesc}>
        {readyCount != null && readyCount > 0
          ? `${readyCount} items are ready for review.`
          : "No items are ready for review yet."}
      </p>

      {/* Quality rules summary */}
      <div style={S.rulesSummary}>
        <div style={S.rulesSummaryTitle}>Review Criteria</div>
        <div style={S.rulesSummaryGrid}>
          <span style={S.ruleItem}><span style={S.ruleCheck}>✓</span> Background — clean #F5F2ED</span>
          <span style={S.ruleItem}><span style={S.ruleCheck}>✓</span> Lighting — soft studio, top-left</span>
          <span style={S.ruleItem}><span style={S.ruleCheck}>✓</span> Shadow — subtle contact shadow</span>
          <span style={S.ruleItem}><span style={S.ruleCheck}>✓</span> Fidelity — true to original</span>
          <span style={S.ruleItem}><span style={S.ruleCheck}>✓</span> Framing — centered, 10% breathing room</span>
        </div>
        <div style={S.rulesSummaryHint}>
          Accept if all pass. Reject to reprocess. Discard to remove.
        </div>
      </div>

      <p style={S.idleHint}>
        Choose <strong>Flow</strong> to review one at a time,
        or <strong>Session</strong> to lock a batch.
      </p>

      <div style={S.startActions}>
        <button
          style={S.startFlowBtn}
          onClick={onStartFlow}
          disabled={starting !== null || readyCount === 0}
        >
          {starting === "flow" ? "Starting..." : "Start Flow"}
        </button>

        <div style={S.sessionStartGroup}>
          <input
            type="number"
            min="1"
            value={batchSize}
            onChange={(e) => onBatchSizeChange(e.target.value)}
            style={S.batchInput}
            placeholder="Batch size"
          />
          <button
            style={S.startSessionBtn}
            onClick={onStartSession}
            disabled={starting !== null || readyCount === 0}
          >
            {starting === "session" ? "Starting..." : "Start Session"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Done State ----------

function DoneState({ session, onAbandon, abandoning }) {
  const reviewed = (session.items_accepted || 0) + (session.items_rejected || 0) + (session.items_discarded || 0);
  return (
    <div style={S.doneWrap}>
      <div style={S.doneIcon}>
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#6B8E6B" strokeWidth="1.5">
          <circle cx="12" cy="12" r="10" />
          <path d="M8 12l3 3 5-5" />
        </svg>
      </div>
      <h2 style={S.doneTitle}>Session Complete</h2>
      <p style={S.doneDesc}>All items in this session have been reviewed.</p>
      <div style={S.doneStats}>
        {session.items_accepted > 0 && (
          <span style={S.statAccepted}>{session.items_accepted} accepted</span>
        )}
        {session.items_rejected > 0 && (
          <span style={S.statRejected}>{session.items_rejected} rejected</span>
        )}
        {session.items_discarded > 0 && (
          <span style={S.statDiscarded}>{session.items_discarded} discarded</span>
        )}
        <span style={S.sessionMeta}>{reviewed} total</span>
      </div>
      <button
        style={S.doneBtn}
        onClick={onAbandon}
        disabled={abandoning}
      >
        {abandoning ? "Closing..." : "Close Session"}
      </button>
    </div>
  );
}

// ---------- Styles ----------

const S = {
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "40vh",
  },
  muted: { color: "#999", fontSize: 14 },

  // Header
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
  headerRight: {
    display: "flex",
    gap: 8,
  },
  title: {
    fontFamily: "'Cormorant Garamond', serif",
    fontWeight: 300,
    fontSize: 28,
    color: "#1A1A1A",
    margin: 0,
  },
  readyBadge: {
    fontSize: 11,
    fontWeight: 600,
    color: "#6B8E6B",
    background: "#edf4ed",
    border: "1px solid #c8dcc8",
    padding: "3px 10px",
    borderRadius: 20,
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
  abandonBtn: {
    background: "none",
    border: "1px solid #e0c4bc",
    borderRadius: 4,
    padding: "6px 14px",
    fontSize: 11,
    fontWeight: 500,
    color: "#D4644A",
    cursor: "pointer",
  },

  // Session bar
  sessionBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
    background: "#f8f7f4",
    border: "1px solid #e8e4de",
    borderRadius: 6,
    padding: "10px 16px",
    marginBottom: 20,
  },
  sessionChips: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  sessionChip: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 1,
    color: "#5B7FD4",
    background: "#f0f4fd",
    border: "1px solid #c8d5f0",
    padding: "3px 10px",
    borderRadius: 4,
  },
  sessionId: {
    fontSize: 11,
    color: "#999",
    fontFamily: "monospace",
  },
  sessionMeta: {
    fontSize: 11,
    color: "#999",
  },
  sessionStats: {
    display: "flex",
    gap: 10,
    alignItems: "center",
  },
  statAccepted: {
    fontSize: 11,
    fontWeight: 600,
    color: "#6B8E6B",
  },
  statRejected: {
    fontSize: 11,
    fontWeight: 600,
    color: "#C4A882",
  },
  statDiscarded: {
    fontSize: 11,
    fontWeight: 600,
    color: "#D4644A",
  },

  // Error bar
  errorBar: {
    background: "#fdf0ed",
    border: "1px solid #f0c8be",
    borderRadius: 6,
    padding: "10px 16px",
    marginBottom: 16,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    fontSize: 13,
    color: "#D4644A",
  },
  errorDismiss: {
    background: "none",
    border: "none",
    color: "#D4644A",
    fontSize: 11,
    cursor: "pointer",
    textDecoration: "underline",
    flexShrink: 0,
  },

  // Idle state
  idleWrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "50vh",
    textAlign: "center",
    maxWidth: 460,
    margin: "0 auto",
  },
  idleIcon: {
    marginBottom: 16,
  },
  idleTitle: {
    fontFamily: "'Cormorant Garamond', serif",
    fontWeight: 400,
    fontSize: 22,
    color: "#1A1A1A",
    margin: "0 0 8px",
  },
  idleDesc: {
    fontSize: 14,
    color: "#6B6B6B",
    margin: "0 0 6px",
  },
  idleHint: {
    fontSize: 12,
    color: "#999",
    margin: "0 0 28px",
    lineHeight: 1.5,
  },
  rulesSummary: {
    background: "#faf9f7",
    border: "1px solid #e8e4de",
    borderRadius: 8,
    padding: "14px 20px",
    margin: "12px 0 20px",
    width: "100%",
    textAlign: "left",
  },
  rulesSummaryTitle: {
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 1,
    color: "#1A1A1A",
    marginBottom: 8,
  },
  rulesSummaryGrid: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  ruleItem: {
    fontSize: 12,
    color: "#6B6B6B",
    lineHeight: 1.5,
  },
  ruleCheck: {
    color: "#4a7c4a",
    fontWeight: 700,
    marginRight: 4,
  },
  rulesSummaryHint: {
    fontSize: 11,
    color: "#999",
    marginTop: 10,
    paddingTop: 8,
    borderTop: "1px solid #e8e4de",
  },
  startActions: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
    alignItems: "center",
    width: "100%",
    maxWidth: 320,
  },
  startFlowBtn: {
    width: "100%",
    background: "#1A1A1A",
    color: "#F5F2ED",
    border: "none",
    borderRadius: 6,
    padding: "12px 24px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    letterSpacing: 0.3,
  },
  sessionStartGroup: {
    display: "flex",
    gap: 8,
    width: "100%",
  },
  batchInput: {
    width: 80,
    border: "1px solid #ddd",
    borderRadius: 6,
    padding: "10px 12px",
    fontSize: 13,
    textAlign: "center",
    outline: "none",
    flexShrink: 0,
  },
  startSessionBtn: {
    flex: 1,
    background: "#f8f7f4",
    color: "#1A1A1A",
    border: "1px solid #ddd",
    borderRadius: 6,
    padding: "10px 16px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    letterSpacing: 0.3,
  },

  // Done state
  doneWrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "45vh",
    textAlign: "center",
  },
  doneIcon: {
    marginBottom: 16,
  },
  doneTitle: {
    fontFamily: "'Cormorant Garamond', serif",
    fontWeight: 400,
    fontSize: 22,
    color: "#1A1A1A",
    margin: "0 0 8px",
  },
  doneDesc: {
    fontSize: 14,
    color: "#6B6B6B",
    margin: "0 0 16px",
  },
  doneStats: {
    display: "flex",
    gap: 14,
    alignItems: "center",
    marginBottom: 24,
  },
  doneBtn: {
    background: "#1A1A1A",
    color: "#F5F2ED",
    border: "none",
    borderRadius: 6,
    padding: "10px 28px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
};
