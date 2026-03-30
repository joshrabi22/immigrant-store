// Shared API helper — canonical endpoints only.
// All methods throw on non-OK responses with status + body info.

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `API error ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

// Counts
export const getCounts = () => api("/api/counts");

// Intake
export const getIntake = (source) => api(`/api/intake/${source}`);
export const approveIntake = (id) => api(`/api/intake/${id}/approve`, { method: "POST" });
export const rejectIntake = (id) => api(`/api/intake/${id}/reject`, { method: "POST" });

// Staging
export const getStaging = () => api("/api/staging");
export const getStagingItem = (id) => api(`/api/staging/${id}`);
export const updateStagingGallery = (id, images) =>
  api(`/api/staging/${id}/gallery`, { method: "PUT", body: JSON.stringify({ images }) });
export const updateStagingMetadata = (id, data) =>
  api(`/api/staging/${id}/metadata`, { method: "PUT", body: JSON.stringify(data) });
export const removeFromStaging = (id) => api(`/api/staging/${id}/remove`, { method: "POST" });
export const splitStagingItem = (id, data) =>
  api(`/api/staging/${id}/split`, { method: "POST", body: JSON.stringify(data) });
export const processItem = (id) => api(`/api/staging/${id}/process`, { method: "POST" });

// Processing
export const getProcessing = () => api("/api/processing");
export const getProcessingItem = (id) => api(`/api/processing/${id}`);
export const retryProcessing = (id) => api(`/api/processing/${id}/retry`, { method: "POST" });
export const returnProcessing = (id) => api(`/api/processing/${id}/return`, { method: "POST" });

// Photo Suite
export const getPhotoSuiteReadyCount = () => api("/api/photo-suite/ready-count");
export const startFlow = () => api("/api/photo-suite/start-flow", { method: "POST" });
export const startSession = (batch_size) =>
  api("/api/photo-suite/start-session", { method: "POST", body: JSON.stringify({ batch_size }) });
export const getNextReview = () => api("/api/photo-suite/next");
export const acceptReview = (id) => api(`/api/photo-suite/${id}/accept`, { method: "POST" });
export const rejectReview = (id) => api(`/api/photo-suite/${id}/reject`, { method: "POST" });
export const discardReview = (id) => api(`/api/photo-suite/${id}/discard`, { method: "POST" });
export const abandonSession = () => api("/api/photo-suite/abandon", { method: "POST" });

// Approved
export const getApproved = () => api("/api/approved");
export const updateApproved = (id, data) =>
  api(`/api/approved/${id}`, { method: "PUT", body: JSON.stringify(data) });
export const moveToLaunch = (id) => api(`/api/approved/${id}/to-launch`, { method: "POST" });
export const removeApproved = (id) => api(`/api/approved/${id}/remove`, { method: "POST" });

// Launch
export const getLaunch = () => api("/api/launch");
export const returnFromLaunch = (id) => api(`/api/launch/${id}/return`, { method: "POST" });
export const publishItem = (id) => api(`/api/launch/${id}/publish`, { method: "POST" });

// Live
export const getLive = () => api("/api/live");
export const unpublishItem = (id) => api(`/api/live/${id}/unpublish`, { method: "POST" });
