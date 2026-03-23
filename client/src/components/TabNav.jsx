import React from "react";

const tabs = [
  { key: "swipe", label: "SWIPE" },
  { key: "picks", label: "MY PICKS" },
  { key: "live", label: "LIVE" },
];

export default function TabNav({ active, onChange }) {
  return (
    <nav style={{
      display: "flex", borderBottom: "1px solid #D9D4CE", padding: "0 24px",
      background: "#F5F2ED", position: "sticky", top: 0, zIndex: 100,
    }}>
      {tabs.map((t) => (
        <button key={t.key} onClick={() => onChange(t.key)} style={{
          padding: "16px 24px", fontSize: 13, fontWeight: 500, letterSpacing: "0.08em",
          cursor: "pointer", border: "none", background: "none",
          color: active === t.key ? "#1A1A1A" : "#8A8580",
          borderBottom: active === t.key ? "2px solid #C4A882" : "2px solid transparent",
        }}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
