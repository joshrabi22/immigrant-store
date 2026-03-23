import React, { useState } from "react";
import TabNav from "./components/TabNav";
import SwipeTab from "./components/SwipeTab";
import PicksTab from "./components/PicksTab";
import LiveTab from "./components/LiveTab";
import EditSuite from "./components/EditSuite";

export default function App() {
  const [tab, setTab] = useState("swipe");
  const [editMode, setEditMode] = useState(false); // true = show Edit Suite
  const [editStartId, setEditStartId] = useState(null);

  const enterEdit = (startId) => { setEditStartId(startId || null); setEditMode(true); };
  const exitEdit = () => { setEditMode(false); setEditStartId(null); setTab("picks"); };

  if (editMode) {
    return <EditSuite startId={editStartId} onExit={exitEdit} />;
  }

  return (
    <div style={{
      fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      background: "#F5F2ED", color: "#1A1A1A", minHeight: "100vh",
    }}>
      <TabNav active={tab} onChange={setTab} />
      {tab === "swipe" && <SwipeTab />}
      {tab === "picks" && <PicksTab onStartEdit={enterEdit} />}
      {tab === "live" && <LiveTab />}
    </div>
  );
}
