import React, { useState, useEffect, useCallback, useRef } from "react";
import { getLaunchSummary, publishAll, getLaunchStatus } from "../api";

const styles = {
  container: { padding: "24px", maxWidth: 900, margin: "0 auto" },
  title: { fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 24, fontWeight: 300, marginBottom: 24 },
  stats: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 32 },
  stat: {
    background: "#fff",
    borderRadius: 6,
    padding: "20px 24px",
    boxShadow: "0 1px 6px rgba(0,0,0,0.05)",
  },
  statNum: { fontSize: 32, fontWeight: 300, color: "#C4A882", fontFamily: "'Cormorant Garamond', serif" },
  statLabel: { fontSize: 12, color: "#8A8580", letterSpacing: "0.05em", marginTop: 4 },
  actions: { display: "flex", gap: 16, marginBottom: 32 },
  publishBtn: {
    padding: "14px 40px",
    fontSize: 14,
    fontWeight: 500,
    letterSpacing: "0.05em",
    background: "#C4A882",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
  },
  publishBtnDisabled: { background: "#D9D4CE", cursor: "not-allowed" },
  reviewBtn: {
    padding: "14px 40px",
    fontSize: 14,
    border: "1px solid #D9D4CE",
    background: "#fff",
    borderRadius: 6,
    cursor: "pointer",
    color: "#6B6B6B",
  },
  progressWrap: { marginBottom: 24 },
  progressBar: { height: 4, background: "#E8E4DF", borderRadius: 2, overflow: "hidden" },
  progressFill: { height: "100%", background: "#C4A882", transition: "width 0.3s" },
  progressText: { fontSize: 12, color: "#8A8580", marginTop: 8 },
  successBox: {
    background: "#fff",
    borderRadius: 6,
    padding: 32,
    textAlign: "center",
    boxShadow: "0 1px 6px rgba(0,0,0,0.05)",
  },
  successTitle: { fontFamily: "'Cormorant Garamond', serif", fontSize: 28, fontWeight: 300 },
};

export default function LaunchTab() {
  const [summary, setSummary] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [status, setStatus] = useState(null);
  const pollRef = useRef(null);

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await getLaunchSummary());
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  const handlePublish = async () => {
    setPublishing(true);
    try {
      await publishAll();
      // Start polling
      pollRef.current = setInterval(async () => {
        const s = await getLaunchStatus();
        setStatus(s);
        if (!s.in_progress) {
          clearInterval(pollRef.current);
          setPublishing(false);
          loadSummary();
        }
      }, 2000);
    } catch (e) {
      alert("Publish error: " + e.message);
      setPublishing(false);
    }
  };

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  if (!summary) return <div style={styles.container}><p style={{ color: "#8A8580" }}>Loading...</p></div>;

  const canPublish = summary.ready_to_publish > 0 && !publishing;
  const total = status?.total || 0;
  const done = (status?.published || 0) + (status?.failed || 0);
  const pct = total > 0 ? (done / total) * 100 : 0;

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>launch</h1>

      <div style={styles.stats}>
        <div style={styles.stat}>
          <div style={styles.statNum}>{summary.total_approved}</div>
          <div style={styles.statLabel}>APPROVED</div>
        </div>
        <div style={styles.stat}>
          <div style={styles.statNum}>{summary.named}</div>
          <div style={styles.statLabel}>NAMED</div>
        </div>
        <div style={styles.stat}>
          <div style={styles.statNum}>{summary.priced}</div>
          <div style={styles.statLabel}>PRICED</div>
        </div>
        <div style={styles.stat}>
          <div style={styles.statNum}>{summary.images_processed}</div>
          <div style={styles.statLabel}>IMAGES PROCESSED</div>
        </div>
        <div style={styles.stat}>
          <div style={styles.statNum}>{summary.flagged_images}</div>
          <div style={styles.statLabel}>FLAGGED</div>
        </div>
        <div style={styles.stat}>
          <div style={styles.statNum}>{summary.ready_to_publish}</div>
          <div style={styles.statLabel}>READY TO PUBLISH</div>
        </div>
      </div>

      {publishing && status && (
        <div style={styles.progressWrap}>
          <div style={styles.progressBar}>
            <div style={{ ...styles.progressFill, width: `${pct}%` }} />
          </div>
          <p style={styles.progressText}>
            {status.published} published, {status.failed} failed of {status.total}
          </p>
        </div>
      )}

      {status && !status.in_progress && status.published > 0 && (
        <div style={styles.successBox}>
          <p style={styles.successTitle}>published</p>
          <p style={{ color: "#8A8580", marginTop: 8 }}>
            {status.published} items live on Shopify
            {status.failed > 0 && `, ${status.failed} failed`}
          </p>
        </div>
      )}

      {!status?.published && (
        <div style={styles.actions}>
          <button
            style={{ ...styles.publishBtn, ...(!canPublish ? styles.publishBtnDisabled : {}) }}
            disabled={!canPublish}
            onClick={handlePublish}
          >
            {publishing ? "Publishing..." : "PUBLISH ALL TO SHOPIFY"}
          </button>
          {summary.flagged_images > 0 && (
            <button style={styles.reviewBtn}>Review Flagged Images</button>
          )}
        </div>
      )}
    </div>
  );
}
