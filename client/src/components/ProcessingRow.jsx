import { useState } from "react";
import { getProcessingItem } from "../lib/api";
import { resolveName, resolveImage } from "../lib/resolveContent";

const STATUS = {
  failed:     { bg: "#fdf0ed", border: "#D4644A", text: "#D4644A", label: "Failed" },
  processing: { bg: "#f0f4fd", border: "#5B7FD4", text: "#5B7FD4", label: "Processing" },
  pending:    { bg: "#f8f7f4", border: "#C4A882", text: "#9A8A6E", label: "Pending" },
};

function Badge({ status }) {
  const c = STATUS[status] || STATUS.pending;
  return (
    <span style={{
      display: "inline-block", fontSize: 10, fontWeight: 700,
      textTransform: "uppercase", letterSpacing: 1,
      padding: "3px 10px", borderRadius: 4,
      border: `1px solid ${c.border}`, color: c.text, background: c.bg,
    }}>
      {c.label}
    </span>
  );
}

function relativeTime(iso) {
  if (!iso) return null;
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function ProcessingRow({ item, onRetry, onReturn }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState(null);
  const [acting, setActing] = useState(null);
  const [actionError, setActionError] = useState(null);

  const name = resolveName(item);
  const image = resolveImage(item);
  const isFailed = item.processing_status === "failed";
  const colors = STATUS[item.processing_status] || STATUS.pending;

  const toggle = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    setDetailError(null);
    if (!detail) {
      setLoadingDetail(true);
      try {
        setDetail(await getProcessingItem(item.id));
      } catch (err) {
        setDetailError(err.message || "Failed to load details");
      }
      setLoadingDetail(false);
    }
  };

  const handleAction = async (e, actionName, handler) => {
    e.stopPropagation();
    setActing(actionName);
    setActionError(null);
    try {
      await handler(item.id);
      // Success — parent handles list update
    } catch (err) {
      setActionError(err.message || `${actionName} failed`);
      setActing(null);
    }
  };

  return (
    <div style={{ ...S.row, borderLeftColor: colors.border }}>
      {/* Main row */}
      <div style={S.main} onClick={toggle}>
        <div style={S.thumb}>
          {image ? (
            <img src={image} alt="" style={S.thumbImg} loading="lazy"
              onError={(e) => { e.target.style.display = "none"; e.target.nextSibling && (e.target.nextSibling.style.display = "flex"); }} />
          ) : null}
          <div style={{ ...S.thumbFallback, display: image ? "none" : "flex" }}>—</div>
        </div>

        <div style={S.info}>
          <div style={S.name}>{name}</div>
          <div style={S.meta}>
            <Badge status={item.processing_status} />
            {item.latest_job_status && item.latest_job_status !== item.processing_status && (
              <span style={S.dim}>job: {item.latest_job_status}</span>
            )}
            {item.latest_job_started_at && (
              <span style={S.dim}>{relativeTime(item.latest_job_started_at)}</span>
            )}
          </div>
          {isFailed && item.latest_job_error && (
            <div style={S.errorText}>{item.latest_job_error}</div>
          )}
          {actionError && (
            <div style={S.actionError}>{actionError}</div>
          )}
        </div>

        <div style={S.actions}>
          {isFailed && (
            <>
              <button
                style={{ ...S.btn, ...S.primaryBtn }}
                disabled={acting !== null}
                onClick={(e) => handleAction(e, "retry", onRetry)}
              >
                {acting === "retry" ? "Retrying…" : "Retry"}
              </button>
              <button
                style={{ ...S.btn, ...S.secondaryBtn }}
                disabled={acting !== null}
                onClick={(e) => handleAction(e, "return", onReturn)}
              >
                {acting === "return" ? "Returning…" : "Return to Staging"}
              </button>
            </>
          )}
          <span style={S.caret}>{expanded ? "▾" : "▸"}</span>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={S.detail}>
          {loadingDetail && <div style={S.dim}>Loading details…</div>}
          {detailError && <div style={S.errorText}>{detailError}</div>}
          {!loadingDetail && !detailError && detail && (
            detail.processing_jobs?.length > 0 ? (
              <div>
                <div style={S.detailLabel}>Job History ({detail.processing_jobs.length})</div>
                {detail.processing_jobs.map((job, i) => (
                  <div key={job.id || i} style={{ ...S.job, ...(i === 0 ? S.latestJob : {}) }}>
                    <div style={S.jobRow}>
                      <Badge status={job.status} />
                      <span style={S.dim}>
                        {job.created_at ? new Date(job.created_at).toLocaleString() : ""}
                      </span>
                      {job.started_at && <span style={S.dim}>→ started {new Date(job.started_at).toLocaleString()}</span>}
                      {job.completed_at && <span style={S.dim}>→ done {new Date(job.completed_at).toLocaleString()}</span>}
                    </div>
                    {job.error_message && <div style={S.errorText}>{job.error_message}</div>}
                    {(job.stage_1_result || job.stage_2_result || job.stage_3_result) && (
                      <div style={S.stages}>
                        {job.stage_1_result && <div style={S.stageRow}>Stage 1: {job.stage_1_result}</div>}
                        {job.stage_2_result && <div style={S.stageRow}>Stage 2: {job.stage_2_result}</div>}
                        {job.stage_3_result && <div style={S.stageRow}>Stage 3: {job.stage_3_result}</div>}
                      </div>
                    )}
                    {job.cloudinary_url && (
                      <div style={S.stageRow}>
                        Output:{" "}
                        <a href={job.cloudinary_url} target="_blank" rel="noopener noreferrer" style={S.link}>
                          {job.cloudinary_url}
                        </a>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={S.dim}>No job history available.</div>
            )
          )}
        </div>
      )}
    </div>
  );
}

const S = {
  row: {
    background: "#fff",
    borderRadius: 8,
    marginBottom: 10,
    borderLeft: "3px solid #ccc",
    overflow: "hidden",
    boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
    transition: "box-shadow 0.15s",
  },
  main: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "14px 18px",
    cursor: "pointer",
  },
  thumb: {
    width: 52,
    height: 52,
    borderRadius: 6,
    overflow: "hidden",
    flexShrink: 0,
    background: "#f0ede8",
    position: "relative",
  },
  thumbImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  thumbFallback: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    color: "#ccc",
    fontSize: 16,
    position: "absolute",
    top: 0,
    left: 0,
  },
  info: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontSize: 13,
    fontWeight: 500,
    color: "#1A1A1A",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    marginBottom: 5,
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  dim: {
    fontSize: 11,
    color: "#999",
  },
  errorText: {
    fontSize: 11,
    color: "#D4644A",
    marginTop: 5,
    lineHeight: 1.4,
  },
  actionError: {
    fontSize: 11,
    color: "#D4644A",
    marginTop: 5,
    fontWeight: 500,
    background: "#fdf0ed",
    padding: "4px 8px",
    borderRadius: 3,
    display: "inline-block",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  btn: {
    border: "none",
    borderRadius: 5,
    padding: "7px 16px",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
    transition: "opacity 0.15s",
  },
  primaryBtn: {
    background: "#1A1A1A",
    color: "#F5F2ED",
  },
  secondaryBtn: {
    background: "#e8e4de",
    color: "#6B6B6B",
  },
  caret: {
    fontSize: 12,
    color: "#bbb",
    marginLeft: 4,
    userSelect: "none",
  },
  detail: {
    padding: "12px 18px 16px 84px",
    borderTop: "1px solid #f0ede8",
    background: "#fcfbf9",
  },
  detailLabel: {
    fontSize: 10,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 1,
    color: "#6B6B6B",
    marginBottom: 10,
  },
  job: {
    padding: "10px 0",
    borderBottom: "1px solid #f0ede8",
  },
  latestJob: {
    background: "rgba(245,242,237,0.5)",
    margin: "0 -12px",
    padding: "10px 12px",
    borderRadius: 6,
    borderBottom: "1px solid #e8e4de",
  },
  jobRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  stages: {
    marginTop: 6,
    paddingLeft: 6,
    borderLeft: "2px solid #e8e4de",
  },
  stageRow: {
    fontSize: 11,
    color: "#6B6B6B",
    marginTop: 3,
    lineHeight: 1.4,
  },
  link: {
    color: "#5B7FD4",
    textDecoration: "none",
    wordBreak: "break-all",
  },
};
