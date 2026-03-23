async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export const getSwipeBatch = (gender) =>
  api(gender ? `/api/swipe/batch?gender=${gender}` : "/api/swipe/batch");
export const postDecision = (candidate_id, decision) =>
  api("/api/swipe/decide", { method: "POST", body: JSON.stringify({ candidate_id, decision }) });
export const postUndo = () => api("/api/swipe/undo", { method: "POST" });
export const getPicks = () => api("/api/picks");
export const deletePick = (id) => api(`/api/picks/${id}`, { method: "DELETE" });
export const getStats = () => api("/api/stats");
export const updateGender = (id, gender) =>
  api(`/api/candidates/${id}/gender`, { method: "PATCH", body: JSON.stringify({ gender }) });
export const updateCategory = (id, category) =>
  api(`/api/candidates/${id}/category`, { method: "PATCH", body: JSON.stringify({ category }) });
