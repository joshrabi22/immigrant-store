import React, { useState, useEffect, useCallback } from "react";
import { getSwipeBatch, postDecision, postUndo, getStats, updateGender, updateCategory } from "../api";
import imgUrl from "../imgUrl";

const GENDER_COLORS = { mens: "#1A1A1A", womens: "#C4A882", unisex: "#6B6B6B" };
const GENDER_LABELS = { mens: "M", womens: "W", unisex: "U" };
const CATEGORIES = ["tops", "bottoms", "outerwear", "footwear", "jewelry", "belts", "accessories"];
const CAT_SHORT = { tops: "TOP", bottoms: "BTM", outerwear: "OUT", footwear: "FTW", jewelry: "JWL", belts: "BLT", accessories: "ACC" };
const GENDER_CYCLE = ["mens", "womens", "unisex"];
const FILTERS = [
  { key: null, label: "ALL" },
  { key: "mens", label: "M" },
  { key: "womens", label: "W" },
  { key: "unisex", label: "U" },
];

export default function SwipeTab() {
  const [batch, setBatch] = useState([]);
  const [queueCount, setQueueCount] = useState(0);
  const [index, setIndex] = useState(0);
  const [saved, setSaved] = useState(0);
  const [loading, setLoading] = useState(true);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [startX, setStartX] = useState(0);
  const [undoToast, setUndoToast] = useState(null);
  const [history, setHistory] = useState([]);
  const [genderFilter, setGenderFilter] = useState(null); // null = all

  const loadBatch = useCallback(async () => {
    setLoading(true);
    const data = await getSwipeBatch(genderFilter);
    setBatch(data.candidates);
    setQueueCount(data.total_remaining);
    setIndex(0);
    setSaved(0);
    setHistory([]);
    setLoading(false);
  }, [genderFilter]);

  useEffect(() => { loadBatch(); }, [loadBatch]);

  // Poll queue count
  useEffect(() => {
    const interval = setInterval(async () => {
      try { const s = await getStats(); setQueueCount(s.unswiped); } catch (_) {}
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const decide = useCallback(async (decision) => {
    if (index >= batch.length) return;
    const c = batch[index];
    await postDecision(c.id, decision);
    setHistory((h) => [...h.slice(-9), { candidate: c, decision, index }]);
    if (decision === "approve") setSaved((s) => s + 1);
    setIndex((i) => i + 1);
  }, [batch, index]);

  const undo = useCallback(async () => {
    if (history.length === 0) return;
    try {
      const result = await postUndo();
      if (!result.ok) return;
      const lastEntry = history[history.length - 1];
      setHistory((h) => h.slice(0, -1));
      setIndex((i) => Math.max(0, i - 1));
      if (lastEntry.decision === "approve") setSaved((s) => Math.max(0, s - 1));
      setBatch((b) => {
        const newBatch = [...b];
        if (result.restored && newBatch[lastEntry.index]?.id !== result.restored.id) {
          newBatch.splice(lastEntry.index, 0, result.restored);
        }
        return newBatch;
      });
      setUndoToast("undone");
      setTimeout(() => setUndoToast(null), 1200);
    } catch (_) {}
  }, [history]);

  const cycleGender = useCallback(async (candidateId, currentGender) => {
    const nextIdx = (GENDER_CYCLE.indexOf(currentGender) + 1) % GENDER_CYCLE.length;
    const newGender = GENDER_CYCLE[nextIdx];
    await updateGender(candidateId, newGender);
    setBatch((b) => b.map((c) => c.id === candidateId ? { ...c, gender: newGender } : c));
  }, []);

  const cycleCat = useCallback(async (candidateId, currentCat) => {
    const nextIdx = (CATEGORIES.indexOf(currentCat) + 1) % CATEGORIES.length;
    const newCat = CATEGORIES[nextIdx];
    await updateCategory(candidateId, newCat);
    setBatch((b) => b.map((c) => c.id === candidateId ? { ...c, detected_category: newCat } : c));
  }, []);

  // Keyboard
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "y" || e.key === "Y" || e.key === "ArrowRight") decide("approve");
      if (e.key === "n" || e.key === "N" || e.key === "ArrowLeft") decide("reject");
      if (e.key === "z" || e.key === "Z") undo();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [decide, undo]);

  // Swipe gesture
  const onDown = (e) => { setDragging(true); setStartX(e.clientX); setDragX(0); };
  const onMove = (e) => { if (dragging) setDragX(e.clientX - startX); };
  const onUp = () => {
    if (Math.abs(dragX) > 80) decide(dragX > 0 ? "approve" : "reject");
    setDragging(false);
    setDragX(0);
  };

  // --- Render ---

  if (loading) return <Center><Muted>Loading...</Muted></Center>;

  // Gender filter bar (always visible)
  const filterBar = (
    <div style={{ display: "flex", gap: 8, marginBottom: 16, justifyContent: "center" }}>
      {FILTERS.map((f) => (
        <button
          key={f.label}
          onClick={() => setGenderFilter(f.key)}
          style={{
            padding: "6px 16px", fontSize: 12, fontWeight: 600, letterSpacing: "0.06em",
            border: genderFilter === f.key ? "2px solid #1A1A1A" : "1px solid #D9D4CE",
            background: genderFilter === f.key ? "#1A1A1A" : "#fff",
            color: genderFilter === f.key ? "#F5F2ED" : "#6B6B6B",
            borderRadius: 4, cursor: "pointer",
          }}
        >
          {f.label}
        </button>
      ))}
    </div>
  );

  if (batch.length === 0) {
    return (
      <Center>
        {filterBar}
        <BigText>no candidates</BigText>
        <Muted>Run alistream.js to pull products from AliExpress</Muted>
        {queueCount > 0 && (
          <button onClick={loadBatch} style={btnStyle("#C4A882", "#fff")}>
            {queueCount} new products arrived — Load
          </button>
        )}
      </Center>
    );
  }

  if (index >= batch.length) {
    return (
      <Center>
        {filterBar}
        <BigText>batch complete</BigText>
        <Muted>{saved} saved out of {batch.length}</Muted>
        <Muted>{queueCount} products waiting in queue</Muted>
        {history.length > 0 && (
          <button onClick={undo} style={btnStyle("#fff", "#1A1A1A", "1px solid #D9D4CE")}>← undo last</button>
        )}
        <button onClick={loadBatch} style={btnStyle("#C4A882", "#fff")}>
          {queueCount > 0 ? "Load Next Batch" : "Waiting for products..."}
        </button>
      </Center>
    );
  }

  const c = batch[index];
  const imgSrc = imgUrl(c);
  const gender = c.gender || "unisex";
  const cat = c.detected_category || "accessories";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "12px 12px", position: "relative", minHeight: "calc(100vh - 52px)", touchAction: "pan-y" }}>
      {undoToast && (
        <div style={{
          position: "fixed", top: 80, left: "50%", transform: "translateX(-50%)",
          background: "#1A1A1A", color: "#F5F2ED", padding: "8px 20px", borderRadius: 6,
          fontSize: 13, fontWeight: 500, zIndex: 200, animation: "fadeOut 1.2s forwards",
        }}>
          {undoToast}
        </div>
      )}

      {filterBar}

      <p style={{ fontSize: 13, color: "#8A8580", letterSpacing: "0.05em", marginBottom: 12 }}>
        {index + 1} of {batch.length} — {saved} saved — {queueCount} in queue
      </p>

      <div
        style={{
          width: "100%", maxWidth: 400, background: "#fff", borderRadius: 8,
          overflow: "hidden", boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
          transform: dragging ? `translateX(${dragX}px) rotate(${dragX * 0.04}deg)` : "",
          opacity: dragging ? Math.max(0.5, 1 - Math.abs(dragX) / 300) : 1,
          transition: dragging ? "none" : "transform 0.2s, opacity 0.2s",
          cursor: "grab", position: "relative",
        }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      >
        {/* Gender badge — tappable to cycle */}
        <button
          onClick={(e) => { e.stopPropagation(); cycleGender(c.id, gender); }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute", top: 12, right: 12, zIndex: 10,
            width: 32, height: 32, borderRadius: "50%",
            background: GENDER_COLORS[gender], color: "#fff",
            border: "2px solid rgba(255,255,255,0.8)",
            fontSize: 12, fontWeight: 700, letterSpacing: "0.05em",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", boxShadow: "0 1px 4px rgba(0,0,0,0.2)",
          }}
          title={`${gender} — click to change`}
        >
          {GENDER_LABELS[gender]}
        </button>

        {/* Category badge — tappable to cycle */}
        <button
          onClick={(e) => { e.stopPropagation(); cycleCat(c.id, cat); }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute", top: 12, right: 50, zIndex: 10,
            height: 28, padding: "0 8px", borderRadius: 4,
            background: "rgba(0,0,0,0.55)", color: "#fff",
            border: "none", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", backdropFilter: "blur(4px)",
          }}
          title={`${cat} — click to change`}
        >
          {CAT_SHORT[cat] || "—"}
        </button>

        {imgSrc && (
          <img
            src={imgSrc} alt={c.title}
            style={{ width: "100%", aspectRatio: "4/5", objectFit: "cover", display: "block", background: "#E8E4DF" }}
            draggable={false}
            onError={(e) => { e.target.style.display = "none"; }}
          />
        )}
        <div style={{ padding: "14px 18px" }}>
          <h2 style={{
            fontFamily: "'Cormorant Garamond', Georgia, serif",
            fontSize: 20, fontWeight: 300, margin: "0 0 6px", lineHeight: 1.3,
          }}>
            {c.title}
          </h2>
          <div style={{ fontSize: 12, color: "#8A8580", display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{
              fontSize: 10, fontWeight: 600, letterSpacing: "0.06em",
              padding: "2px 7px", borderRadius: 3, background: "#E8E4DF", color: "#6B6B6B",
            }}>
              {c.source || "aliexpress"}
            </span>
            {c.price && <span>${c.price}</span>}
            {c.product_url && (
              <a href={c.product_url} target="_blank" rel="noopener"
                style={{ color: "#C4A882", textDecoration: "none" }}
                onClick={(e) => e.stopPropagation()}
              >view →</a>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 14, marginTop: 20 }}>
        <button onClick={() => decide("reject")} style={btnStyle("#fff", "#1A1A1A", "1px solid #D9D4CE")}>N — Pass</button>
        <button onClick={() => decide("approve")} style={btnStyle("#C4A882", "#fff")}>Y — Save</button>
      </div>

      {history.length > 0 && (
        <button onClick={undo} style={{
          marginTop: 10, fontSize: 12, color: "#A8A4A0", background: "none",
          border: "none", cursor: "pointer", padding: "4px 8px",
        }}>← undo (Z)</button>
      )}

      <p style={{ fontSize: 12, color: "#A8A4A0", marginTop: 8 }}>Y / N keys · Z undo · tap badge to change gender</p>

      <style>{`@keyframes fadeOut { 0% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }`}</style>
    </div>
  );
}

function Center({ children }) {
  return <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: 60, gap: 8 }}>{children}</div>;
}
function BigText({ children }) {
  return <p style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 28, fontWeight: 300 }}>{children}</p>;
}
function Muted({ children }) {
  return <p style={{ fontSize: 13, color: "#8A8580" }}>{children}</p>;
}
function btnStyle(bg, color, border) {
  return {
    padding: "14px 40px", fontSize: 15, fontWeight: 500, letterSpacing: "0.04em",
    background: bg, color, border: border || "none", borderRadius: 8, cursor: "pointer",
    minHeight: 48, touchAction: "manipulation",
  };
}
