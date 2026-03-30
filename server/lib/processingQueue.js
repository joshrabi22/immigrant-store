// server/lib/processingQueue.js — BullMQ queue for Ghost Logic processing
//
// Shared by server.js (enqueue) and ghostLogicWorker.js (consume).
// If REDIS_URL is not set, enqueue is a silent no-op (jobs stay in DB
// as 'pending' and can be picked up via --direct mode or when Redis appears).

const QUEUE_NAME = "ghost-logic-tasks";
const REDIS_URL = process.env.REDIS_URL;

let queue = null;
let queueReady = false;

function getQueue() {
  if (queue) return queue;
  if (!REDIS_URL) {
    console.warn("[queue] REDIS_URL not set — job enqueue disabled (jobs stored in DB only)");
    return null;
  }

  try {
    const { Queue } = require("bullmq");
    const IORedis = require("ioredis");
    const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

    connection.on("connect", () => {
      queueReady = true;
      console.log("[queue] Connected to Redis");
    });
    connection.on("error", (err) => {
      console.error("[queue] Redis error:", err.message);
    });

    queue = new Queue(QUEUE_NAME, { connection });
    return queue;
  } catch (err) {
    console.error("[queue] Failed to initialize BullMQ:", err.message);
    return null;
  }
}

/**
 * Enqueue a Ghost Logic processing job.
 * @param {number} jobId - processing_jobs row ID
 * @param {number} candidateId - candidates row ID
 * @returns {Promise<boolean>} true if enqueued, false if skipped
 */
async function enqueueProcessingJob(jobId, candidateId) {
  const q = getQueue();
  if (!q) return false;

  try {
    await q.add(
      `ghost-${candidateId}`,
      { candidateId, processingJobId: jobId },
      { jobId: `pj-${jobId}` }
    );
    console.log(`[queue] Job enqueued: jobId=${jobId} candidateId=${candidateId}`);
    return true;
  } catch (err) {
    console.error(`[queue] Failed to enqueue job ${jobId}:`, err.message);
    return false;
  }
}

module.exports = { enqueueProcessingJob, getQueue, QUEUE_NAME };
