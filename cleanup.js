// cleanup.js — Deep cleanup of existing candidates
// Usage: node cleanup.js
//
// Re-checks ALL candidates with status='new' against:
// 1. Title keyword filter
// 2. Image file exists and is >5kb
// 3. Red banner pixel detection
// 4. Claude vision product check
// Rejects anything that fails. Does NOT delete — sets status='rejected'.

require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const { getDb, initSchema } = require("./db");
const { readImageForApi } = require("./lib/image-utils");

const JUNK_TITLE_KEYWORDS = [
  "sale", "% off", "discount", "coupon", "deal", "free shipping",
  "wholesale", "lot of", "pack of", "pcs", "pieces", "clearance",
  "flash deal", "limited time", "buy 1 get", "bundle",
];

const VISION_PROMPT = `Is this a product image for a clothing, fashion, or accessory item? This includes: shirts, jackets, pants, shoes, bags, hats, dresses, hoodies, jewelry, sunglasses, watches — shown on a model, mannequin, flat lay, or plain background.
Answer NO only if the image is: a sale/discount banner, a promotional graphic with percentage signs or large text, a collage of many tiny products, a size chart, or not a product at all.
Answer yes or no.`;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

function isTitleJunk(title) {
  if (!title || title.length < 5) return true;
  const lower = title.toLowerCase();
  return JUNK_TITLE_KEYWORDS.some((kw) => lower.includes(kw));
}

function looksLikeRedBanner(imageBuffer) {
  if (!imageBuffer || imageBuffer.length < 1000) return false;

  const start = Math.floor(imageBuffer.length * 0.3);
  const end = Math.floor(imageBuffer.length * 0.7);
  const sampleSize = Math.min(end - start, 10000);

  let redCount = 0;
  let whiteCount = 0;
  let totalSamples = 0;

  for (let i = start; i < start + sampleSize - 2; i += 3) {
    const r = imageBuffer[i];
    const g = imageBuffer[i + 1];
    const b = imageBuffer[i + 2];
    totalSamples++;
    if (r > 180 && g < 80 && b < 80) redCount++;
    if (r > 230 && g > 230 && b > 230) whiteCount++;
  }

  if (totalSamples === 0) return false;
  return (redCount / totalSamples) > 0.15 && (whiteCount / totalSamples) > 0.15;
}

async function main() {
  console.log("=== IMMIGRANT — Deep Candidate Cleanup ===\n");

  const db = getDb();
  initSchema(db);

  const candidates = db.prepare("SELECT id, title, image_path FROM candidates WHERE status = 'new'").all();
  console.log(`Checking ${candidates.length} candidates...\n`);

  const reject = db.prepare("UPDATE candidates SET status = 'rejected' WHERE id = ?");

  let rejTitle = 0;
  let rejImage = 0;
  let rejBanner = 0;
  let rejVision = 0;
  let kept = 0;

  // Pass 1: title + image file checks (instant, no API)
  const passedPass1 = [];

  for (const c of candidates) {
    // Title filter
    if (isTitleJunk(c.title)) {
      reject.run(c.id);
      rejTitle++;
      console.log(`  rejected (title): "${c.title.substring(0, 55)}"`);
      continue;
    }

    // Image file check: exists and >5kb
    if (!c.image_path) {
      reject.run(c.id);
      rejImage++;
      continue;
    }
    const fullPath = path.resolve(__dirname, c.image_path);
    if (!fs.existsSync(fullPath)) {
      reject.run(c.id);
      rejImage++;
      continue;
    }
    const stat = fs.statSync(fullPath);
    if (stat.size < 5000) {
      reject.run(c.id);
      rejImage++;
      console.log(`  rejected (image <5kb): "${c.title.substring(0, 55)}"`);
      continue;
    }

    // Red banner check
    const imageBuffer = fs.readFileSync(fullPath);
    if (looksLikeRedBanner(imageBuffer)) {
      reject.run(c.id);
      rejBanner++;
      console.log(`  rejected (red banner): "${c.title.substring(0, 55)}"`);
      continue;
    }

    passedPass1.push(c);
  }

  console.log(`\nPass 1 complete: ${rejTitle} title, ${rejImage} image, ${rejBanner} banner`);
  console.log(`${passedPass1.length} candidates remain for vision check.\n`);

  // Pass 2: Claude vision check
  const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

  if (!client) {
    console.log("No ANTHROPIC_API_KEY — skipping vision check. All remaining candidates kept.");
    kept = passedPass1.length;
  } else {
    console.log("Running Claude vision check on remaining candidates...\n");

    for (let i = 0; i < passedPass1.length; i++) {
      const c = passedPass1[i];
      const fullPath = path.resolve(__dirname, c.image_path);
      const img = readImageForApi(fullPath);

      if (!img) {
        reject.run(c.id);
        rejImage++;
        continue;
      }

      try {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 8,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: img.mediaType, data: img.base64 } },
              { type: "text", text: VISION_PROMPT },
            ],
          }],
        });

        const answer = response.content[0].text.trim().toLowerCase();
        if (!answer.startsWith("yes")) {
          reject.run(c.id);
          rejVision++;
          console.log(`  [${i + 1}/${passedPass1.length}] rejected (vision): "${c.title.substring(0, 45)}..."`);
        } else {
          kept++;
          if (kept % 20 === 0) {
            console.log(`  [${i + 1}/${passedPass1.length}] ... ${kept} kept so far`);
          }
        }
      } catch (err) {
        // API error — keep it
        kept++;
      }

      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const totalRejected = rejTitle + rejImage + rejBanner + rejVision;
  const remaining = db.prepare("SELECT COUNT(*) as c FROM candidates WHERE status = 'new'").get().c;

  console.log(`\n=== Cleanup complete ===`);
  console.log(`Rejected: ${totalRejected} total`);
  console.log(`  Title filter:  ${rejTitle}`);
  console.log(`  Bad/no image:  ${rejImage}`);
  console.log(`  Red banner:    ${rejBanner}`);
  console.log(`  Vision check:  ${rejVision}`);
  console.log(`Kept: ${kept}`);
  console.log(`Swipe queue: ${remaining} candidates`);

  db.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
