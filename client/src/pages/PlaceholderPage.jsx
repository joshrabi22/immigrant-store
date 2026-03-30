// Reusable empty-state placeholder for routes not yet implemented.

export default function PlaceholderPage({ title, subtitle }) {
  return (
    <div style={S.wrap}>
      <h1 style={S.title}>{title}</h1>
      <p style={S.subtitle}>{subtitle || "No items yet."}</p>
    </div>
  );
}

const S = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "60vh",
    color: "#6B6B6B",
  },
  title: {
    fontFamily: "'Cormorant Garamond', serif",
    fontWeight: 300,
    fontSize: 28,
    color: "#1A1A1A",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    margin: 0,
  },
};
