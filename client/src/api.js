async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

// Swipe
export const getSwipeBatch = (gender) => api(gender ? `/api/swipe/batch?gender=${gender}` : "/api/swipe/batch");
export const postDecision = (id, decision) => api("/api/swipe/decide", { method: "POST", body: JSON.stringify({ candidate_id: id, decision }) });
export const postUndo = () => api("/api/swipe/undo", { method: "POST" });

// Picks
export const getPicks = () => api("/api/picks");
export const deletePick = (id) => api(`/api/picks/${id}`, { method: "DELETE" });

// Edit Suite
export const getEditQueue = () => api("/api/edit/queue");
export const getEditSkipped = () => api("/api/edit/skipped");
export const getEditItem = (id) => api(`/api/edit/${id}`);
export const saveEdit = (id, data) => api(`/api/edit/${id}/save`, { method: "POST", body: JSON.stringify(data) });
export const skipItem = (id) => api(`/api/edit/${id}/skip`, { method: "POST" });
export const unskipItem = (id) => api(`/api/edit/${id}/unskip`, { method: "POST" });
export const generateName = (id) => api(`/api/edit/${id}/generate-name`, { method: "POST" });
export const generateDescription = (id) => api(`/api/edit/${id}/generate-description`, { method: "POST" });
export const removeBg = (id) => api(`/api/edit/${id}/remove-bg`, { method: "POST" });
export const enhanceImage = (id) => api(`/api/edit/${id}/enhance`, { method: "POST" });
export const applyEnhanced = (id, enhanced_path) => api(`/api/edit/${id}/apply-enhanced`, { method: "POST", body: JSON.stringify({ enhanced_path }) });
export const revertImage = (id) => api(`/api/edit/${id}/revert-image`, { method: "POST" });
export const publishItem = (id) => api(`/api/edit/${id}/publish`, { method: "POST" });
export const unpublishItem = (id) => api(`/api/edit/${id}/unpublish`, { method: "POST" });

// Live
export const getLive = () => api("/api/live");

// Stats + meta
export const getStats = () => api("/api/stats");
export const updateGender = (id, gender) => api(`/api/candidates/${id}/gender`, { method: "PATCH", body: JSON.stringify({ gender }) });
export const updateCategory = (id, category) => api(`/api/candidates/${id}/category`, { method: "PATCH", body: JSON.stringify({ category }) });
