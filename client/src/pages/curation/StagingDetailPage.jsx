import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  getStagingItem,
  updateStagingGallery,
  updateStagingMetadata,
  removeFromStaging,
  processItem,
  splitStagingItem,
} from "../../lib/api";
import { useCounts } from "../../lib/CountsContext";
import { resolveName, resolvePrice } from "../../lib/resolveContent";
import imgUrl from "../../imgUrl";
import { getFilteredGallery } from "../../lib/galleryFilter";
import GalleryEditor from "../../components/GalleryEditor";
import MetadataForm from "../../components/MetadataForm";
import Toast from "../../components/Toast";

export default function StagingDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { refresh } = useCounts();

  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [gallerySaving, setGallerySaving] = useState(false);
  const [metaSaving, setMetaSaving] = useState(false);
  const [acting, setActing] = useState(null);
  const [toast, setToast] = useState(null);
  const [splitStatus, setSplitStatus] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getStagingItem(id)
      .then(setItem)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Build gallery from item — deduplicate and filter junk (shared utility)
  const getGallery = (itm) => getFilteredGallery(itm);

  const handleGallerySave = async (images) => {
    setGallerySaving(true);
    try {
      const updated = await updateStagingGallery(id, images);
      setItem(updated);
      setToast({ message: "Gallery saved", type: "success" });
      refresh();
    } catch (err) {
      setToast({ message: err.message || "Gallery save failed", type: "error" });
    } finally {
      setGallerySaving(false);
    }
  };

  const handleMetaSave = async (data) => {
    setMetaSaving(true);
    try {
      const updated = await updateStagingMetadata(id, data);
      setItem(updated);
      setToast({ message: "Metadata saved", type: "success" });
      refresh();
    } catch (err) {
      setToast({ message: err.message || "Metadata save failed", type: "error" });
    } finally {
      setMetaSaving(false);
    }
  };

  const handleSplit = async (imageUrl) => {
    setSplitStatus(null);
    try {
      const result = await splitStagingItem(id, {
        image_url: imageUrl,
        variant_id: null,
        variant_name: null,
        available_sizes: null,
      });
      const childId = result.child?.id;
      setSplitStatus({
        type: "success",
        message: `Split created${childId ? ` (new item #${childId})` : ""}. Gallery updated.`,
      });
      // Reload the full item to get updated all_images, image_url, etc.
      load();
      refresh();
    } catch (err) {
      setSplitStatus({
        type: "error",
        message: err.message || "Split failed",
      });
    }
  };

  const handleProcess = async () => {
    setActing("process");
    try {
      await processItem(id);
      refresh();
      navigate("/curation/staging");
    } catch (err) {
      setToast({ message: err.message || "Process failed", type: "error" });
      setActing(null);
    }
  };

  const handleRemove = async () => {
    setActing("remove");
    try {
      await removeFromStaging(id);
      refresh();
      navigate("/curation/staging");
    } catch (err) {
      setToast({ message: err.message || "Remove failed", type: "error" });
      setActing(null);
    }
  };

  if (loading) {
    return <div style={S.center}><p style={S.muted}>Loading item...</p></div>;
  }

  if (error) {
    return (
      <div style={S.center}>
        <p style={S.error}>{error}</p>
        <Link to="/curation/staging" style={S.backLink}>&larr; Back to Staging</Link>
      </div>
    );
  }

  if (!item) return null;

  const name = resolveName(item);
  const price = resolvePrice(item);
  const heroImage = item.processed_image_url || imgUrl(item);
  const gallery = getGallery(item);
  const hasProcessedImage = !!item.processed_image_url;

  return (
    <div>
      <Link to="/curation/staging" style={S.backLink}>&larr; Back to Staging</Link>

      {item.review_status === "revision_needed" && (
        <div style={S.revisionBanner}>Revision needed &mdash; returned from Photo Suite</div>
      )}

      {/* Hero section — image-first curation layout */}
      <div style={S.heroSection}>
        <div style={S.heroImageWrap}>
          {heroImage ? (
            <img src={heroImage} alt={name} style={S.heroImage} />
          ) : (
            <div style={S.heroEmpty}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#bbb" strokeWidth="1.2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="M21 15l-5-5L5 21" />
              </svg>
              <span style={{ fontSize: 12, color: "#bbb", marginTop: 8 }}>No image</span>
            </div>
          )}
          {hasProcessedImage && <span style={S.processedBadge}>Processed</span>}
        </div>

        <div style={S.heroInfo}>
          <h1 style={S.title}>{name}</h1>
          {item.title && item.title !== name && (
            <div style={S.rawTitleHint}>{item.title.slice(0, 80)}{item.title.length > 80 ? "..." : ""}</div>
          )}
          {price != null && <span style={S.price}>${Number(price).toFixed(2)}</span>}
          <div style={S.metaRow}>
            {item.gender && <span style={S.metaTag}>{item.gender}</span>}
            {item.detected_category && <span style={S.metaTag}>{item.detected_category}</span>}
            {item.is_split_child === 1 && <span style={{ ...S.metaTag, color: "#7B68EE" }}>split child</span>}
            {item.source && <span style={{ ...S.metaTag, color: "#999" }}>{item.source}</span>}
            {item.processing_status === "ready" && <span style={S.readyBadge}>READY</span>}
          </div>

          {/* Inline actions at the top for fast decisions */}
          <div style={S.quickActions}>
            <button
              style={S.processBtn}
              onClick={handleProcess}
              disabled={acting !== null}
            >
              {acting === "process" ? "Sending..." : "Send to Processing"}
            </button>
            <button
              style={S.removeBtn}
              onClick={handleRemove}
              disabled={acting !== null}
            >
              {acting === "remove" ? "Removing..." : "Remove"}
            </button>
          </div>
        </div>
      </div>

      {/* Gallery + Metadata — gallery is primary, metadata secondary */}
      <div style={S.columns}>
        <div style={S.galleryCol}>
          <h2 style={S.sectionTitle}>Gallery</h2>
          <GalleryEditor
            images={gallery}
            onSave={handleGallerySave}
            onSplit={handleSplit}
            saving={gallerySaving}
            splitStatus={splitStatus}
          />
        </div>
        <div style={S.metaCol}>
          <h2 style={S.sectionTitle}>Details</h2>
          <MetadataForm
            item={item}
            onSave={handleMetaSave}
            saving={metaSaving}
            nameDescSupported={true}
          />
        </div>
      </div>

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDone={() => setToast(null)}
        />
      )}
    </div>
  );
}

const S = {
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "50vh",
  },
  muted: { color: "#999", fontSize: 14 },
  error: { color: "#c44", fontSize: 14 },
  backLink: {
    display: "inline-block",
    color: "#999",
    textDecoration: "none",
    fontSize: 13,
    marginBottom: 16,
  },
  revisionBanner: {
    background: "#D4644A",
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    padding: "8px 16px",
    borderRadius: 4,
    marginBottom: 20,
  },

  /* Hero section — large image + info side by side */
  heroSection: {
    display: "flex",
    gap: 32,
    alignItems: "flex-start",
    marginBottom: 32,
  },
  heroImageWrap: {
    position: "relative",
    width: 280,
    aspectRatio: "4/5",
    borderRadius: 8,
    overflow: "hidden",
    background: "#F5F2ED",
    flexShrink: 0,
  },
  heroImage: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    display: "block",
  },
  heroEmpty: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  },
  processedBadge: {
    position: "absolute",
    top: 10,
    right: 10,
    background: "rgba(45,134,89,0.85)",
    color: "#fff",
    fontSize: 9,
    fontWeight: 600,
    letterSpacing: 1,
    textTransform: "uppercase",
    padding: "3px 8px",
    borderRadius: 4,
  },
  heroInfo: {
    flex: 1,
    minWidth: 0,
    paddingTop: 4,
  },
  title: {
    fontFamily: "'Cormorant Garamond', serif",
    fontWeight: 300,
    fontSize: 28,
    color: "#1A1A1A",
    margin: "0 0 4px",
    lineHeight: 1.2,
  },
  rawTitleHint: {
    fontSize: 11,
    color: "#bbb",
    lineHeight: 1.4,
    marginBottom: 8,
  },
  price: {
    display: "block",
    fontSize: 18,
    fontWeight: 600,
    color: "#1A1A1A",
    marginBottom: 10,
  },
  metaRow: {
    display: "flex",
    gap: 8,
    marginBottom: 16,
    flexWrap: "wrap",
    alignItems: "center",
  },
  metaTag: {
    fontSize: 10,
    color: "#6B6B6B",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    background: "#f0ede8",
    padding: "2px 8px",
    borderRadius: 3,
  },
  readyBadge: {
    fontSize: 9,
    fontWeight: 700,
    color: "#2D8659",
    letterSpacing: 1,
    textTransform: "uppercase",
    background: "#edf4ed",
    padding: "2px 8px",
    borderRadius: 3,
  },

  /* Quick actions — prominent, above the fold */
  quickActions: {
    display: "flex",
    gap: 10,
    marginTop: 8,
  },
  processBtn: {
    background: "#1A1A1A",
    color: "#F5F2ED",
    border: "none",
    borderRadius: 4,
    padding: "10px 24px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
  removeBtn: {
    background: "#e8e4de",
    color: "#6B6B6B",
    border: "none",
    borderRadius: 4,
    padding: "10px 20px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },

  /* Gallery + metadata columns */
  columns: {
    display: "flex",
    gap: 32,
    flexWrap: "wrap",
  },
  galleryCol: {
    flex: 3,
    minWidth: 320,
  },
  metaCol: {
    flex: 1,
    minWidth: 240,
  },
  sectionTitle: {
    fontFamily: "'Cormorant Garamond', serif",
    fontWeight: 400,
    fontSize: 18,
    color: "#1A1A1A",
    margin: "0 0 12px",
    paddingBottom: 8,
    borderBottom: "1px solid #e8e4de",
  },
};
