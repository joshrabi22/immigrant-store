import { NavLink } from "react-router-dom";
import { useCounts } from "../lib/CountsContext";

const GROUPS = [
  {
    label: "INTAKE",
    items: [
      { to: "/intake/suggested", label: "Initial Suggestions", countKey: "suggested" },
      { to: "/intake/wishlist", label: "Wishlist", countKey: "wishlist" },
      { to: "/intake/watched", label: "Watched", countKey: "watched" },
      { to: "/intake/ordered", label: "Previously Ordered", countKey: "previously_ordered" },
      { to: "/intake/reverse-image", label: "Reverse Image", countKey: "reverse_image" },
    ],
  },
  {
    label: "CURATION",
    items: [
      { to: "/curation/staging", label: "Staging", countKey: "staging" },
      { to: "/curation/processing", label: "Processing", countKey: "processing" },
    ],
  },
  {
    label: "REVIEW",
    items: [
      { to: "/review/photo-suite", label: "Photo Suite", countKey: "photo_suite" },
      { to: "/review/approved", label: "Approved", countKey: "approved" },
    ],
  },
  {
    label: "PUBLISH",
    items: [
      { to: "/publish/launch", label: "Launch", countKey: "launch" },
      { to: "/publish/live", label: "Live", countKey: "live" },
    ],
  },
];

export default function Sidebar() {
  const { counts } = useCounts();

  return (
    <nav style={S.nav}>
      <div style={S.logo}>IMMIGRANT</div>
      {GROUPS.map((g) => (
        <div key={g.label} style={S.group}>
          <div style={S.groupLabel}>{g.label}</div>
          {g.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              style={({ isActive }) => ({
                ...S.link,
                ...(isActive ? S.linkActive : {}),
              })}
            >
              <span>{item.label}</span>
              {counts[item.countKey] > 0 && (
                <span style={S.badge}>{counts[item.countKey]}</span>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}

const S = {
  nav: {
    width: 220,
    minHeight: "100vh",
    background: "#1A1A1A",
    color: "#F5F2ED",
    padding: "20px 0",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    fontSize: 13,
    overflowY: "auto",
  },
  logo: {
    fontFamily: "'Cormorant Garamond', serif",
    fontSize: 18,
    fontWeight: 300,
    letterSpacing: 4,
    padding: "0 20px 24px",
    borderBottom: "1px solid #333",
    marginBottom: 8,
  },
  group: {
    padding: "12px 0 4px",
  },
  groupLabel: {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 2,
    color: "#6B6B6B",
    padding: "0 20px 6px",
  },
  link: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "7px 20px",
    color: "#999",
    textDecoration: "none",
    transition: "color 0.15s, background 0.15s",
  },
  linkActive: {
    color: "#F5F2ED",
    background: "rgba(196,168,130,0.12)",
    borderRight: "2px solid #C4A882",
  },
  badge: {
    background: "#C4A882",
    color: "#1A1A1A",
    fontSize: 10,
    fontWeight: 700,
    borderRadius: 8,
    padding: "1px 7px",
    minWidth: 18,
    textAlign: "center",
  },
};
