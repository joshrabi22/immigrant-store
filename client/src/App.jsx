import React, { useState } from "react";
import TabNav from "./components/TabNav";
import SwipeTab from "./components/SwipeTab";
import PicksTab from "./components/PicksTab";

export default function App() {
  const [tab, setTab] = useState("swipe");

  return (
    <div style={{
      fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
      background: "#F5F2ED",
      color: "#1A1A1A",
      minHeight: "100vh",
    }}>
      <TabNav active={tab} onChange={setTab} />
      {tab === "swipe" && <SwipeTab />}
      {tab === "picks" && <PicksTab />}
    </div>
  );
}
