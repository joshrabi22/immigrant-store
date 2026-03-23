import React, { useState, useEffect, useCallback } from "react";
import { getEditQueue, getEditSkipped, unskipItem, getStats, deletePick } from "../api";
import imgUrl from "../imgUrl";
import ProductEditor from "./ProductEditor";

export default function EditSuite({ startId, onExit }) {
  const [tab, setTab] = useState("queue");
  const [queue, setQueue] = useState([]);
  const [skipped, setSkipped] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [editingId, setEditingId] = useState(startId);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [allDone, setAllDone] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [q, s, st] = await Promise.all([getEditQueue(), getEditSkipped(), getStats()]);
    setQueue(q.items);
    setSkipped(s.items);
    setStats(st);
    if (!editingId && q.items.length > 0) {
      setEditingId(q.items[0].id);
      setCurrentIdx(0);
    }
    setLoading(false);
  }, [editingId]);

  useEffect(() => { load(); }, []);

  const handleNext = async () => {
    // Reload queue to get fresh data
    const q = await getEditQueue();
    const s = await getEditSkipped();
    const st = await getStats();
    setQueue(q.items);
    setSkipped(s.items);
    setStats(st);

    if (q.items.length === 0) {
      setAllDone(true);
      setEditingId(null);
      return;
    }
    setEditingId(q.items[0].id);
    setCurrentIdx(0);
  };

  const handlePrev = () => {
    if (currentIdx > 0 && queue.length > 0) {
      const prevIdx = currentIdx - 1;
      setCurrentIdx(prevIdx);
      setEditingId(queue[prevIdx].id);
    }
  };

  const handleResume = async (id) => {
    await unskipItem(id);
    setEditingId(id);
    setTab("queue");
    load();
  };

  const handleRemove = async (id) => {
    await deletePick(id);
    load();
  };

  if (loading) return <FullScreen><Muted>Loading...</Muted></FullScreen>;

  // All done screen
  if (allDone || (!editingId && queue.length === 0)) {
    return (
      <FullScreen>
        <p style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 28, fontWeight: 300 }}>all done</p>
        <Muted>{stats.published || 0} published · {skipped.length} skipped</Muted>
        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          {skipped.length > 0 && (
            <Btn bg="#fff" color="#1A1A1A" border="1px solid #D9D4CE" onClick={() => { setAllDone(false); setTab("skipped"); }}>
              Review Skipped
            </Btn>
          )}
          <Btn bg="#C4A882" color="#fff" onClick={onExit}>Back to My Picks</Btn>
        </div>
      </FullScreen>
    );
  }

  // Editing a product
  if (editingId && tab === "queue") {
    return (
      <ProductEditor
        id={editingId}
        queuePosition={currentIdx + 1}
        queueTotal={queue.length}
        onNext={handleNext}
        onPrev={handlePrev}
        onExit={onExit}
        hasPrev={currentIdx > 0}
      />
    );
  }

  // Skipped tab
  return (
    <div style={{ minHeight: "100vh", background: "#F5F2ED" }}>
      {/* Top bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: "1px solid #D9D4CE" }}>
        <button onClick={onExit} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer" }}>←</button>
        <span style={{ fontSize: 14, fontWeight: 500 }}>Edit Suite</span>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, padding: "0 16px", borderBottom: "1px solid #D9D4CE" }}>
        {[["queue", `Queue (${queue.length})`], ["skipped", `Skipped (${skipped.length})`]].map(([k, label]) => (
          <button key={k} onClick={() => { setTab(k); if (k === "queue" && queue.length > 0) { setEditingId(queue[0].id); } }}
            style={{
              padding: "12px 20px", fontSize: 13, fontWeight: 500, letterSpacing: "0.06em",
              border: "none", background: "none", cursor: "pointer",
              color: tab === k ? "#1A1A1A" : "#8A8580",
              borderBottom: tab === k ? "2px solid #C4A882" : "2px solid transparent",
            }}>{label}</button>
        ))}
      </div>

      {/* Progress bar */}
      <div style={{ padding: "12px 16px", fontSize: 12, color: "#8A8580" }}>
        {queue.length} in queue · {skipped.length} skipped · {stats.published || 0} published
      </div>

      {/* Skipped grid */}
      <div style={{ padding: "0 16px 80px", display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
        {skipped.map((item) => {
          const img = imgUrl(item);
          return (
            <div key={item.id} style={{ background: "#fff", borderRadius: 6, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
              {img && <img src={img} alt="" style={{ width: "100%", aspectRatio: "4/5", objectFit: "cover" }} />}
              <div style={{ padding: "10px 12px" }}>
                <p style={{ fontSize: 13, fontFamily: "'Cormorant Garamond', serif", fontWeight: 300, margin: "0 0 8px" }}>
                  {item.edited_name || item.immigrant_name || item.title?.substring(0, 30)}
                </p>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={() => handleResume(item.id)} style={smallBtn("#C4A882", "#fff")}>Resume</button>
                  <button onClick={() => handleRemove(item.id)} style={smallBtn("#fff", "#cc6666", "1px solid #cc6666")}>Remove</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FullScreen({ children }) {
  return <div style={{ minHeight: "100vh", background: "#F5F2ED", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>{children}</div>;
}
function Muted({ children }) { return <p style={{ fontSize: 13, color: "#8A8580" }}>{children}</p>; }
function Btn({ children, bg, color, border, onClick }) {
  return <button onClick={onClick} style={{ padding: "12px 28px", fontSize: 14, fontWeight: 500, background: bg, color, border: border || "none", borderRadius: 6, cursor: "pointer", minHeight: 48 }}>{children}</button>;
}
function smallBtn(bg, color, border) {
  return { padding: "6px 12px", fontSize: 11, background: bg, color, border: border || "none", borderRadius: 4, cursor: "pointer" };
}
