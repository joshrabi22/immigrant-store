// server/workers/ghostLogicWorker.js — Ghost Logic image processing worker
//
// 3-stage pipeline:
//   Stage 1: Extraction — Photoroom / remove.bg → upload to Cloudinary
//   Stage 2: Compositing — Gemini 3 Flash (lighting + shadows on #F5F2ED)
//   Stage 3: Naming/Copy — Claude (2-word name + 1-sentence description)
//
// All processed images hosted on Cloudinary. Final URL saved to Turso.
//
// Run with Redis:  node server/workers/ghostLogicWorker.js
// Run direct:      node server/workers/ghostLogicWorker.js --direct <id>

require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const { getDb, initSchema, queryOne, run, closeDb } = require("../../db");
const { uploadBuffer, uploadFromUrl } = require("../lib/cloudinary");
const { filterGallery } = require("../lib/galleryFilter");

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const QUEUE_NAME = "ghost-logic-tasks";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanImageUrl(url) {
  if (!url) return null;
  if (url.startsWith("//")) url = "https:" + url;
  const jpgMatch = url.match(/^(.*?\.(?:jpg|jpeg|png))/i);
  return jpgMatch ? jpgMatch[1] : url.replace(/_?\.avif$/i, "");
}

// Returns true for AliExpress CDN URLs that encode a small size in the filename
// (e.g. _220x220.jpg, _300x300.jpg). Either dimension below 400px = thumbnail.
function isCdnThumbnail(url) {
  const match = url.match(/_(\d+)x(\d+)\.(jpg|jpeg|png|webp)/i);
  if (!match) return false;
  return parseInt(match[1], 10) < 400 || parseInt(match[2], 10) < 400;
}

async function fetchImageBuffer(url) {
  url = cleanImageUrl(url);
  if (!url) throw new Error("No image URL");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Stage 1 — Extraction (Photoroom → remove.bg → passthrough)
// Returns a Cloudinary URL of the extracted image.
// ---------------------------------------------------------------------------

async function extractProduct(imageUrl, candidateId, suffix = "") {
  console.log(`[ghost][${candidateId}${suffix}] Stage 1: Extraction...`);

  const photoroomKey = process.env.PHOTOROOM_API_KEY;
  const removebgKey = process.env.REMOVEBG_API_KEY;
  const imageBuffer = await fetchImageBuffer(imageUrl);
  const pid = `ghost_${candidateId}${suffix}`;

  // Try Photoroom
  if (photoroomKey) {
    try {
      const form = new FormData();
      form.append("image_file", new Blob([imageBuffer]), "product.jpg");
      form.append("bg_color", "#F5F2ED");

      const res = await fetch("https://sdk.photoroom.com/v1/segment", {
        method: "POST",
        headers: { "x-api-key": photoroomKey },
        body: form,
      });

      if (res.ok) {
        const resultBuffer = Buffer.from(await res.arrayBuffer());
        const cloudUrl = await uploadBuffer(resultBuffer, { public_id: `${pid}_extracted` });
        console.log(`[ghost][${candidateId}${suffix}]   Photoroom → Cloudinary: ${cloudUrl}`);
        return cloudUrl;
      }
      const errBody = await res.text().catch(() => "");
      console.log(`[ghost][${candidateId}${suffix}]   Photoroom failed: ${res.status} — ${errBody.substring(0, 200)}`);
    } catch (err) {
      console.log(`[ghost][${candidateId}${suffix}]   Photoroom error: ${err.message}`);
    }
  }

  // Try remove.bg
  if (removebgKey) {
    try {
      const form = new FormData();
      form.append("image_file", new Blob([imageBuffer]), "product.jpg");
      form.append("size", "auto");
      form.append("bg_color", "F5F2ED");

      const res = await fetch("https://api.remove.bg/v1.0/removebg", {
        method: "POST",
        headers: { "X-Api-Key": removebgKey },
        body: form,
      });

      if (res.ok) {
        const resultBuffer = Buffer.from(await res.arrayBuffer());
        const cloudUrl = await uploadBuffer(resultBuffer, { public_id: `${pid}_extracted` });
        console.log(`[ghost][${candidateId}${suffix}]   remove.bg → Cloudinary: ${cloudUrl}`);
        return cloudUrl;
      }
      console.log(`[ghost][${candidateId}${suffix}]   remove.bg failed: ${res.status}`);
    } catch (err) {
      console.log(`[ghost][${candidateId}${suffix}]   remove.bg error: ${err.message}`);
    }
  }

  throw new Error(`Stage 1 extraction failed — no API succeeded (Photoroom key: ${!!photoroomKey}, remove.bg key: ${!!removebgKey})`);
}

// ---------------------------------------------------------------------------
// Stage 2 — Compositing (Gemini 3 Flash)
// Takes Cloudinary URL from Stage 1, composites, uploads result.
// ---------------------------------------------------------------------------

async function compositeSet(extractedUrl, candidateId, suffix = "", _retryCount = 0) {
  console.log(`[ghost][${candidateId}${suffix}] Stage 2: Compositing...${_retryCount > 0 ? ` (retry ${_retryCount})` : ""}`);

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    console.log(`[ghost][${candidateId}${suffix}]   No GEMINI_API_KEY — passthrough`);
    return extractedUrl;
  }

  const MAX_RETRIES = 2; // up to 2 retries (3 total attempts) for 429 or text-only responses

  try {
    const imageBuffer = await fetchImageBuffer(extractedUrl);
    const base64 = imageBuffer.toString("base64");

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: "You MUST return an edited version of this image. Place this garment on a flat, infinite #F5F2ED background. If the image contains multiple separate items, keep ONLY the single most prominent garment and remove everything else. Lighting: Soft, high-key studio light from the top-left. Shadow: Generate a subtle, realistic contact shadow beneath the item where it touches the ground. The shadow should be soft and diffuse. Ensure the garment's texture and color remain 100% true to the original. Crop: Center the single item with 10% breathing room on all sides. Return ONLY the image, no text." },
              { inline_data: { mime_type: "image/jpeg", data: base64 } },
            ],
          }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
          },
        }),
      }
    );

    if (res.ok) {
      const data = await res.json();
      // Check if Gemini returned an image (API may use camelCase inlineData or snake_case inline_data)
      const parts = data.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p) => p.inline_data || p.inlineData);
      if (imagePart) {
        const imageData = imagePart.inline_data || imagePart.inlineData;
        const composited = Buffer.from(imageData.data, "base64");
        const cloudUrl = await uploadBuffer(composited, {
          public_id: `ghost_${candidateId}${suffix}_composited`,
        });
        console.log(`[ghost][${candidateId}${suffix}]   Gemini → Cloudinary: ${cloudUrl}`);
        return cloudUrl;
      }
      // Gemini returned 200 but text-only (no image) — retry if we haven't exhausted attempts
      const textParts = parts.filter((p) => p.text).map((p) => p.text.substring(0, 100));
      if (_retryCount < MAX_RETRIES) {
        console.log(`[ghost][${candidateId}${suffix}]   Gemini returned text-only — retrying in 5s (attempt ${_retryCount + 1}/${MAX_RETRIES}, text: ${JSON.stringify(textParts)})`);
        await new Promise((r) => setTimeout(r, 5000));
        return compositeSet(extractedUrl, candidateId, suffix, _retryCount + 1);
      }
      console.log(`[ghost][${candidateId}${suffix}]   Gemini returned no image after ${_retryCount + 1} attempts — passthrough (parts: ${parts.length}, text: ${JSON.stringify(textParts)})`);
    } else if (res.status === 429 && _retryCount < MAX_RETRIES) {
      console.log(`[ghost][${candidateId}${suffix}]   Gemini 429 — waiting 20s then retrying (attempt ${_retryCount + 1}/${MAX_RETRIES})...`);
      await new Promise((r) => setTimeout(r, 20_000));
      return compositeSet(extractedUrl, candidateId, suffix, _retryCount + 1);
    } else {
      const errBody = await res.text().catch(() => "");
      console.log(`[ghost][${candidateId}${suffix}]   Gemini failed: ${res.status} — ${errBody.substring(0, 200)}`);
    }
  } catch (err) {
    console.log(`[ghost][${candidateId}${suffix}]   Gemini error: ${err.message}`);
  }

  return extractedUrl;
}

// ---------------------------------------------------------------------------
// Stage 3 — Naming + Copy (Claude)
// ---------------------------------------------------------------------------

async function generateNameAndCopy(imageUrl, candidateId) {
  console.log(`[ghost][${candidateId}] Stage 3: Naming + Copy...`);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`[ghost][${candidateId}]   No ANTHROPIC_API_KEY — skipping`);
    return { name: null, description: null };
  }

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic();
    const imageBuffer = await fetchImageBuffer(imageUrl);
    const base64 = imageBuffer.toString("base64");

    let mediaType = "image/jpeg";
    if (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50) mediaType = "image/png";
    else if (imageBuffer[0] === 0x52 && imageBuffer[1] === 0x49) mediaType = "image/webp";

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 256,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: `You are naming products for IMMIGRANT, a minimal luxury streetwear brand.

Return ONLY valid JSON:
{
  "name": "two word name, lowercase",
  "description": "one sentence, present tense, declarative"
}

Name rules: 2 words, lowercase. Color vocabulary: bone, slate, moss, faded black, earth, dust, clay, fog, ink, rust. Never generic.
Description rules: one sentence. Physical garment only: weight, fit, construction. No marketing. Unbothered.` },
        ],
      }],
    });

    const text = response.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      console.log(`[ghost][${candidateId}]   → "${parsed.name}" | "${parsed.description}"`);
      return { name: parsed.name, description: parsed.description };
    }
  } catch (err) {
    console.log(`[ghost][${candidateId}]   Claude error: ${err.message}`);
  }

  return { name: null, description: null };
}

// ---------------------------------------------------------------------------
// Product membership gate — Claude vision classifier
// Compares a candidate image to the hero after Stage 1 extraction.
// Returns true if the image is the same product type, false if foreign.
// Uses the ANTHROPIC_API_KEY already required for Stage 3 naming.
// ---------------------------------------------------------------------------

async function isSameProduct(heroExtractedUrl, candidateExtractedUrl, candidateId, suffix) {
  if (!process.env.ANTHROPIC_API_KEY) {
    // No API key — can't classify, assume same product (fail open)
    console.log(`[ghost][${candidateId}${suffix}] Product gate: no ANTHROPIC_API_KEY — skipping (assume same)`);
    return true;
  }

  try {
    const Anthropic = require("@anthropic-ai/sdk");
    const client = new Anthropic();

    const [heroBuf, candBuf] = await Promise.all([
      fetchImageBuffer(heroExtractedUrl),
      fetchImageBuffer(candidateExtractedUrl),
    ]);

    function detectMediaType(buf) {
      if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
      if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
      return "image/jpeg";
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 32,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Image 1 is the HERO product. Image 2 is a CANDIDATE. Are they the same type of product (e.g. both sunglasses, both jackets, both pants)? Answer with ONLY the word SAME or DIFFERENT." },
          { type: "image", source: { type: "base64", media_type: detectMediaType(heroBuf), data: heroBuf.toString("base64") } },
          { type: "image", source: { type: "base64", media_type: detectMediaType(candBuf), data: candBuf.toString("base64") } },
        ],
      }],
    });

    const answer = (response.content[0]?.text || "").trim().toUpperCase();
    const isSame = answer.startsWith("SAME");
    console.log(`[ghost][${candidateId}${suffix}] Product gate: ${isSame ? "SAME" : "DIFFERENT"} (raw: "${answer}")`);
    return isSame;
  } catch (err) {
    // Classification failed — fail open (keep the image rather than silently dropping)
    console.log(`[ghost][${candidateId}${suffix}] Product gate error: ${err.message} — keeping image (fail open)`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

async function processCandidate(candidateId, db) {
  // Outer try/catch: ANY error in the entire function body sets processing_status='failed'.
  // Without this, errors in the setup phase (lines before the inner pipeline try/catch)
  // would propagate to the caller without updating DB status, leaving items stuck at 'pending'.
  try {
  const candidate = await queryOne(db, "SELECT * FROM candidates WHERE id = ?", [candidateId]);
  if (!candidate) throw new Error(`Candidate ${candidateId} not found`);
  if (!candidate.image_url) throw new Error(`Candidate ${candidateId} has no image_url`);

  // Build image list: prefer all_images gallery, fall back to hero
  let imageUrls = [];
  try {
    const gallery = JSON.parse(candidate.all_images || "[]");
    if (Array.isArray(gallery) && gallery.length > 0) imageUrls = gallery;
  } catch (_) {}
  if (imageUrls.length === 0) imageUrls = [candidate.image_url];

  // Gallery junk filter: remove page chrome, structural junk, non-CDN URLs.
  // Raw all_images from AliExpress contains 40-65 URLs per product — mostly page
  // chrome (service badges, recommendation thumbnails, shipping icons) that Photoroom
  // + Gemini would process into hallucinated/foreign garment images.
  const preFilterCount = imageUrls.length;
  imageUrls = filterGallery(imageUrls);
  if (imageUrls.length < preFilterCount) {
    console.log(`[ghost][${candidateId}] Gallery filter: ${preFilterCount} raw → ${imageUrls.length} product images (${preFilterCount - imageUrls.length} junk removed)`);
  }
  if (imageUrls.length === 0) {
    // All gallery images were filtered — fall back to hero
    imageUrls = [candidate.image_url];
    console.log(`[ghost][${candidateId}] Gallery filter removed all images — falling back to image_url hero`);
  }

  // Deduplicate and clean URLs.
  // Two-layer dedup: (1) exact cleaned URL strings, (2) CDN file hash — same image
  // can appear on different CDN domains (ae01.alicdn.com vs ae-pic-a1.aliexpress-media.com).
  {
    const cleaned = imageUrls.map(cleanImageUrl).filter(Boolean);
    const seenUrls = new Set();
    const seenHashes = new Set();
    imageUrls = [];
    for (const url of cleaned) {
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const hashMatch = url.match(/\/kf\/([A-Za-z0-9_]+)/);
      const hash = hashMatch ? hashMatch[1] : null;
      if (hash) {
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);
      }
      imageUrls.push(url);
    }
  }

  // Photo Suite quality rule 1: promote the curator-approved image_url to index 0.
  // The card hero was explicitly validated by the curator — it should always lead the premium set.
  // Uses hash-aware matching — same image can appear on different CDN domains.
  const cleanedHero = cleanImageUrl(candidate.image_url);
  if (cleanedHero) {
    let heroIdx = imageUrls.indexOf(cleanedHero);
    // If exact URL not found, try hash match (same image on different CDN domain)
    if (heroIdx === -1) {
      const heroHashMatch = cleanedHero.match(/\/kf\/([A-Za-z0-9_]+)/);
      if (heroHashMatch) {
        heroIdx = imageUrls.findIndex(u => {
          const m = u.match(/\/kf\/([A-Za-z0-9_]+)/);
          return m && m[1] === heroHashMatch[1];
        });
      }
    }
    if (heroIdx > 0) {
      const heroUrl = imageUrls[heroIdx]; // use the URL already in the list
      imageUrls = [heroUrl, ...imageUrls.filter((_, i) => i !== heroIdx)];
      console.log(`[ghost][${candidateId}] Hero promoted: image_url moved from index ${heroIdx} to 0`);
    } else if (heroIdx === -1) {
      imageUrls = [cleanedHero, ...imageUrls];
      console.log(`[ghost][${candidateId}] Hero inserted: image_url not in gallery, prepended at index 0`);
    }
  }

  // Photo Suite quality rule 2: deprioritize color-variant shots to back of gallery.
  // Non-variant images (front/back/side of same product) fill premium slots before
  // images that only show a different colorway. Uses already-scraped variant_specifics.
  if (candidate.variant_specifics) {
    try {
      const variantMap = JSON.parse(candidate.variant_specifics);
      const variantUrls = new Set(
        Object.keys(variantMap).map(cleanImageUrl).filter(Boolean)
      );
      if (variantUrls.size > 0) {
        const hero = imageUrls[0];
        const rest = imageUrls.slice(1);
        const nonVariant = rest.filter(u => !variantUrls.has(u));
        const variant = rest.filter(u => variantUrls.has(u));
        if (variant.length > 0) {
          imageUrls = [hero, ...nonVariant, ...variant];
          console.log(`[ghost][${candidateId}] Variants deprioritized: ${variant.length} color-variant image${variant.length > 1 ? "s" : ""} moved after ${nonVariant.length} non-variant alternate${nonVariant.length !== 1 ? "s" : ""}`);
        }
      }
    } catch (_) {}
  }

  // Photo Suite quality rule 3: remove CDN size-suffix thumbnails from non-hero slots.
  // AliExpress DOM scraping picks up both full-size gallery images and their small
  // thumbnail-strip versions (_220x220, _300x300 etc.) as distinct URLs. Keep only
  // images with both dimensions ≥400px in the alternates. Hero (index 0) is untouched.
  {
    const hero = imageUrls[0];
    const filteredAlts = imageUrls.slice(1).filter(u => !isCdnThumbnail(u));
    if (filteredAlts.length < imageUrls.length - 1) {
      const removed = (imageUrls.length - 1) - filteredAlts.length;
      imageUrls = [hero, ...filteredAlts];
      console.log(`[ghost][${candidateId}] Thumbnails filtered: ${removed} CDN size-suffix image${removed > 1 ? "s" : ""} removed from premium set candidates`);
    }
  }

  console.log(`[ghost][${candidateId}] Pipeline start: "${candidate.title?.substring(0, 40)}..." (${imageUrls.length} image${imageUrls.length > 1 ? "s" : ""})`);
  const startTimestamp = new Date().toISOString();
  const startResult = await run(db, "UPDATE candidates SET processing_status = 'processing', processing_started_at = ?, updated_at = ? WHERE id = ?", [startTimestamp, startTimestamp, candidateId]);
  const startAffected = startResult?.changes ?? 0;
  if (startAffected === 0) {
    console.warn(`[ghost][${candidateId}] ⚠ processing_status='processing' UPDATE affected 0 rows — check DB write path`);
  } else {
    console.log(`[ghost][${candidateId}] processing_status → processing (rows updated: ${startAffected})`);
  }

  // Safety caps for Stage 1 (extraction) and Stage 2 (Gemini compositing).
  // After gallery filtering + dedup + product gate, typical count is 3-8 real images.
  // Default 12 covers generous multi-angle + color-specific shots while preventing
  // runaway API spend on malformed galleries. Override via env vars if needed.
  const MAX_STAGE1 = parseInt(process.env.MAX_STAGE1_IMAGES || "12", 10);
  const MAX_STAGE2 = parseInt(process.env.MAX_STAGE2_IMAGES || "12", 10);

  try {
    // Two-pass pipeline:
    //   Pass 1: Stage 1 extraction for up to MAX_STAGE1 images
    //   Product gate: Claude vision classifies each non-hero as SAME/DIFFERENT
    //   Pass 2: Stage 2 compositing only for hero + SAME-product images

    // --- Pass 1: Extract all images through Stage 1 ---
    const extractedImages = []; // { index, suffix, extractedUrl }
    for (let i = 0; i < imageUrls.length; i++) {
      const suffix = imageUrls.length > 1 ? `_img${i}` : "";
      if (i >= MAX_STAGE1) {
        console.log(`[ghost][${candidateId}${suffix}] Stage 1 skipped (index ${i} >= MAX_STAGE1_IMAGES ${MAX_STAGE1}) — dropping overflow image`);
        continue;
      }
      try {
        const extracted = await extractProduct(imageUrls[i], candidateId, suffix);
        extractedImages.push({ index: i, suffix, extractedUrl: extracted });
      } catch (imgErr) {
        console.warn(`[ghost][${candidateId}${suffix}] Image failed, skipping: ${imgErr.message}`);
      }
    }

    if (extractedImages.length === 0) {
      // All gallery images failed — fall back to hero image_url
      console.warn(`[ghost][${candidateId}] All gallery images failed, falling back to image_url`);
      const heroFallbackUrl = cleanImageUrl(candidate.image_url);
      try {
        const extracted = await extractProduct(heroFallbackUrl, candidateId, "");
        extractedImages.push({ index: 0, suffix: "", extractedUrl: extracted });
      } catch (fallbackErr) {
        throw new Error(`Hero fallback also failed: ${fallbackErr.message}`);
      }
    }

    // --- Product membership gate: compare non-hero images to hero ---
    // Hero (index 0 in extractedImages) is always kept. Each subsequent image
    // is classified by Claude vision as SAME product or DIFFERENT (foreign).
    // Foreign images are dropped before Stage 2, saving Gemini API calls and
    // preventing contaminated processed_images from reaching Photo Suite.
    const heroExtracted = extractedImages[0];
    let gatedImages = [heroExtracted];
    let foreignCount = 0;
    for (let j = 1; j < extractedImages.length; j++) {
      const img = extractedImages[j];
      const same = await isSameProduct(heroExtracted.extractedUrl, img.extractedUrl, candidateId, img.suffix);
      if (same) {
        gatedImages.push(img);
      } else {
        foreignCount++;
      }
    }
    if (foreignCount > 0) {
      console.log(`[ghost][${candidateId}] Product gate: ${foreignCount} foreign image${foreignCount > 1 ? "s" : ""} removed, ${gatedImages.length} kept`);
    }

    // --- Pass 2: Stage 2 compositing on surviving images ---
    const processedUrls = [];
    let stage2Count = 0;
    for (const img of gatedImages) {
      try {
        let composited;
        if (img.index < MAX_STAGE2) {
          composited = await compositeSet(img.extractedUrl, candidateId, img.suffix);
          if (composited !== img.extractedUrl) stage2Count++;
        } else {
          console.log(`[ghost][${candidateId}${img.suffix}] Stage 2 skipped (index ${img.index} >= MAX_STAGE2_IMAGES ${MAX_STAGE2}) — using Stage 1 output`);
          composited = img.extractedUrl;
        }
        processedUrls.push(composited);
      } catch (imgErr) {
        console.warn(`[ghost][${candidateId}${img.suffix}] Stage 2 failed, using extraction: ${imgErr.message}`);
        processedUrls.push(img.extractedUrl);
      }
    }

    if (processedUrls.length === 0) {
      // Shouldn't happen since hero is always kept, but safety net
      throw new Error("No images survived pipeline — hero extraction must have failed");
    }

    // Stage 3: naming runs once on the hero (first processed image)
    const heroUrl = processedUrls[0];
    const { name, description } = await generateNameAndCopy(heroUrl, candidateId);

    // Determine baseline: whether the hero is a processed Cloudinary URL or the raw AliExpress URL.
    // Stage 1 success produces a Cloudinary URL — valid baseline even without Stage 2.
    // heroIsRaw means Stage 1 itself failed and the raw source URL slipped through (should not happen
    // since extractProduct() throws, but guarded here for safety).
    const rawHero = cleanImageUrl(candidate.image_url);
    const heroIsRaw = heroUrl === rawHero || heroUrl === candidate.image_url;

    let baseline;
    if (heroIsRaw) {
      baseline = "degraded";
      console.warn(`[ghost][${candidateId}] ⚠ Hero is raw AliExpress URL — Stage 1 did not produce a Cloudinary URL. Check PHOTOROOM_API_KEY / REMOVEBG_API_KEY / CLOUDINARY_URL.`);
    } else if (stage2Count === 0) {
      baseline = "stage1_only";
      console.log(`[ghost][${candidateId}] Baseline: Stage 1 only — ${processedUrls.length} Photoroom cutout${processedUrls.length > 1 ? "s" : ""} on #F5F2ED (Stage 2 skipped or fell back)`);
    } else {
      baseline = "stage2_composited";
      console.log(`[ghost][${candidateId}] Baseline: Stage 2 composited — ${stage2Count}/${processedUrls.length} image${processedUrls.length > 1 ? "s" : ""} received Gemini lighting pass`);
    }

    // Save: processed_image_url = hero (backward compat), processed_images = full JSON array
    const timestamp = new Date().toISOString();
    const updates = [
      "processing_status = 'ready'",
      "processed_image_url = ?",
      "processed_images = ?",
      "processing_completed_at = ?",
      "updated_at = ?",
    ];
    const params = [heroUrl, JSON.stringify(processedUrls), timestamp, timestamp];

    if (name) { updates.push("generated_name = ?"); params.push(name); }
    if (description) { updates.push("generated_description = ?"); params.push(description); }

    params.push(candidateId);
    const finalSql = `UPDATE candidates SET ${updates.join(", ")} WHERE id = ?`;

    // === TEMPORARY DEBUG: log exact SQL and param mapping ===
    console.log(`[ghost][${candidateId}] === DEBUG: Final success UPDATE ===`);
    console.log(`[ghost][${candidateId}] SQL: ${finalSql}`);
    const placeholderCols = updates.filter(u => u.includes("?")).map(u => u.split(" = ")[0].trim());
    placeholderCols.push("WHERE id");
    params.forEach((val, i) => {
      const label = placeholderCols[i] || `unknown_${i}`;
      const display = typeof val === "string" && val.length > 80 ? val.substring(0, 80) + "..." : val;
      console.log(`[ghost][${candidateId}]   [${i}] ${label}=${display}`);
    });
    console.log(`[ghost][${candidateId}] === END DEBUG ===`);

    const updateResult = await run(db, finalSql, params);
    const affected = updateResult?.changes ?? 0;
    if (affected === 0) {
      console.error(`[ghost][${candidateId}] ⚠ SUCCESS UPDATE affected 0 rows — candidate may have been deleted or moved during processing`);
    }

    console.log(`[ghost][${candidateId}] Pipeline complete ✓ ${processedUrls.length}/${imageUrls.length} images processed — baseline: ${baseline} (rows updated: ${affected})`);
    return { candidateId, processed_image_url: heroUrl, processed_images: processedUrls, name, description, baseline };
  } catch (err) {
    // Inner catch: pipeline stage failures (Stage 1/2/3)
    await run(db, "UPDATE candidates SET processing_status = 'failed', updated_at = ? WHERE id = ?", [new Date().toISOString(), candidateId]);
    console.error(`[ghost][${candidateId}] PIPELINE FAILED: ${err.message}`);
    throw err;
  }
  } catch (outerErr) {
    // Outer catch: ANY error including setup phase (gallery parsing, filtering, hero promotion).
    // The inner catch already sets 'failed' for pipeline errors and re-throws, so this
    // catches both inner re-throws (where 'failed' is already set — harmless double-write)
    // and setup errors (where 'failed' was never set — the actual bug fix).
    try {
      await run(db, "UPDATE candidates SET processing_status = 'failed', updated_at = ? WHERE id = ?", [new Date().toISOString(), candidateId]);
    } catch (_) {
      // If even this DB write fails, we can't do more — the error still propagates
    }
    console.error(`[ghost][${candidateId}] FAILED: ${outerErr.message}`);
    throw outerErr;
  }
}

// ---------------------------------------------------------------------------
// BullMQ Worker
// ---------------------------------------------------------------------------

function validateKey(name, val) {
  if (!val) return "NOT SET";
  if (val.includes("<") || val.includes("%3C") || val.includes("your_")) return "PLACEHOLDER ⚠";
  return "OK";
}

async function startWorker() {
  console.log("=== Ghost Logic Worker ===");
  console.log(`Queue: ${QUEUE_NAME}`);
  console.log(`Redis: ${REDIS_URL}`);

  const keyStatus = {
    CLOUDINARY_URL: validateKey("CLOUDINARY_URL", process.env.CLOUDINARY_URL),
    REMOVEBG_API_KEY: validateKey("REMOVEBG_API_KEY", process.env.REMOVEBG_API_KEY),
    PHOTOROOM_API_KEY: validateKey("PHOTOROOM_API_KEY", process.env.PHOTOROOM_API_KEY),
    GEMINI_API_KEY: validateKey("GEMINI_API_KEY", process.env.GEMINI_API_KEY),
    ANTHROPIC_API_KEY: validateKey("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY),
  };
  console.log("API keys:", JSON.stringify(keyStatus));
  const placeholders = Object.entries(keyStatus).filter(([, v]) => v === "PLACEHOLDER ⚠");
  if (placeholders.length > 0) {
    console.warn(`\n⚠ WARNING: ${placeholders.map(([k]) => k).join(", ")} contain placeholder values.`);
    console.warn("  Pipeline will degrade — processed images will be unchanged.\n");
  }

  const db = getDb();
  await initSchema(db);

  const IORedis = require("ioredis");
  const { Worker } = require("bullmq");
  const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

  connection.on("connect", () => console.log("[ghost] Redis connected"));
  connection.on("error", (err) => console.error("[ghost] Redis error:", err.message));

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      console.log(`[ghost] Job picked up: ${job.id} candidateId=${job.data.candidateId}`);
      const { candidateId } = job.data;
      return processCandidate(candidateId, db);
    },
    { connection, concurrency: 2, limiter: { max: 10, duration: 60000 } }
  );

  worker.on("completed", (job, result) => console.log(`[ghost] Job ${job.id} ✓ "${result?.name || "unnamed"}"`));
  worker.on("failed", (job, err) => console.error(`[ghost] Job ${job?.id} ✗ ${err.message}`));
  worker.on("error", (err) => console.error("[ghost] Worker error:", err.message));

  await worker.waitUntilReady();
  console.log("[ghost] Worker ready — listening for jobs\n");

  process.on("SIGINT", async () => { await worker.close(); await connection.quit(); closeDb(); process.exit(0); });
  process.on("unhandledRejection", (err) => console.error("[ghost] Unhandled rejection:", err));
}

// ---------------------------------------------------------------------------
// Direct mode (no Redis)
// ---------------------------------------------------------------------------

async function directProcess(candidateId) {
  console.log("=== Ghost Logic — Direct ===\n");
  const db = getDb();
  await initSchema(db);
  try {
    const result = await processCandidate(candidateId, db);
    console.log("\nResult:", JSON.stringify(result, null, 2));

    // Verify persistence: read back ALL critical fields to detect corruption
    const verify = await queryOne(db, `SELECT id, stage, processing_status, processed_image_url, processed_images,
      generated_name, generated_description, staged_at, processing_started_at, processing_completed_at,
      updated_at, all_images FROM candidates WHERE id = ?`, [candidateId]);
    if (verify) {
      console.log("\n=== DB VERIFICATION (post-pipeline) ===");
      console.log(`  id:                      ${verify.id}`);
      console.log(`  stage:                   ${verify.stage}`);
      console.log(`  processing_status:       ${verify.processing_status}`);
      console.log(`  processed_image_url:     ${verify.processed_image_url ? verify.processed_image_url.substring(0, 80) : "NULL"}`);
      console.log(`  processed_images:        ${verify.processed_images ? verify.processed_images.substring(0, 80) : "NULL"}`);
      console.log(`  generated_name:          ${verify.generated_name || "NULL"}`);
      console.log(`  generated_description:   ${verify.generated_description ? verify.generated_description.substring(0, 80) : "NULL"}`);
      console.log(`  staged_at:               ${verify.staged_at || "NULL"}`);
      console.log(`  processing_started_at:   ${verify.processing_started_at || "NULL"}`);
      console.log(`  processing_completed_at: ${verify.processing_completed_at || "NULL"}`);
      console.log(`  updated_at:              ${verify.updated_at || "NULL"}`);
      console.log(`  all_images:              ${verify.all_images ? verify.all_images.substring(0, 80) : "NULL"}`);
      console.log("=== END VERIFICATION ===\n");
      // Corruption checks
      if (!verify.processed_image_url) {
        console.error("⚠ PERSISTENCE FAILURE: processed_image_url is NULL after successful pipeline run");
      }
      if (verify.stage !== "staged") {
        console.error(`⚠ CORRUPTION: stage should be 'staged' but is '${verify.stage}'`);
      }
      if (verify.staged_at && !verify.staged_at.match(/^\d{4}-\d{2}-\d{2}T/)) {
        console.error(`⚠ CORRUPTION: staged_at is not an ISO timestamp: '${verify.staged_at}'`);
      }
      if (verify.processing_completed_at && !verify.processing_completed_at.match(/^\d{4}-\d{2}-\d{2}T/)) {
        console.error(`⚠ CORRUPTION: processing_completed_at is not an ISO timestamp: '${verify.processing_completed_at}'`);
      }
    }
  } finally {
    closeDb();
    console.log("[ghost] DB connections closed");
  }
}

module.exports = { extractProduct, compositeSet, generateNameAndCopy, processCandidate };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === "--direct" && args[1]) {
    directProcess(parseInt(args[1])).catch((e) => { console.error("Fatal:", e); process.exit(1); });
  } else {
    startWorker().catch((e) => { console.error("Fatal:", e); process.exit(1); });
  }
}
