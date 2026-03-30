import { Outlet } from "react-router-dom";
import { CountsProvider } from "../lib/CountsContext";
import Sidebar from "./Sidebar";

export default function AppLayout() {
  return (
    <CountsProvider>
      <div style={S.wrap}>
        <Sidebar />
        <main style={S.main}>
          <Outlet />
        </main>
      </div>
    </CountsProvider>
  );
}

const S = {
  wrap: {
    display: "flex",
    minHeight: "100vh",
    background: "#F5F2ED",
  },
  main: {
    flex: 1,
    padding: "32px 40px",
    overflowY: "auto",
    fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
};
