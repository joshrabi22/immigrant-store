import { useState, useEffect } from "react";

// Lightweight inline toast for success/error feedback.
// Usage: <Toast message={msg} type="success|error" onDone={() => setMsg(null)} />

export default function Toast({ message, type = "success", onDone, duration = 3000 }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    const t = setTimeout(() => { setVisible(false); onDone?.(); }, duration);
    return () => clearTimeout(t);
  }, [message, duration, onDone]);

  if (!visible || !message) return null;

  const bg = type === "error" ? "#D4644A" : "#2D8659";

  return (
    <div style={{ ...S.toast, background: bg }}>
      {message}
    </div>
  );
}

const S = {
  toast: {
    position: "fixed",
    bottom: 24,
    right: 24,
    color: "#fff",
    fontSize: 13,
    fontWeight: 500,
    padding: "10px 20px",
    borderRadius: 6,
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    zIndex: 9999,
    maxWidth: 360,
  },
};
