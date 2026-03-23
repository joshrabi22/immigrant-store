// taste-builder.js — Analyze order images with Claude vision to build a taste profile
// Usage: node taste-builder.js

require("dotenv").config();
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const { getDb, initSchema } = require("./db");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
const OUTPUT_PATH = path.join(__dirname, "taste_profile.json");

// ---------------------------------------------------------------------------
// Claude vision analysis
// ---------------------------------------------------------------------------

const ANALYSIS_PROMPT = `Analyze this clothing product image and extract the following as JSON:

{
  "dominant_colors": ["#hex1", "#hex2", "#hex3"],
  "garment_type": "e.g. hoodie, t-shirt, jacket, pants, sneakers, bag, accessory",
  "silhouette": "e.g. oversized, slim, relaxed, cropped, boxy",
  "material": "e.g. cotton, polyester, leather, nylon, denim, knit",
  "style_tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "aesthetic": "streetwear | minimal | tailored | utility | other"
}

Be specific with hex colors. Limit style_tags to max 5. Return ONLY valid JSON, no extra text.`;

async function analyzeImage(client, imagePath) {
  const fullPath = path.resolve(__dirname, imagePath);
  if (!fs.existsSync(fullPath)) {
    console.log(`  Skipping (file not found): ${imagePath}`);
    return null;
  }

  const imageData = fs.readFileSync(fullPath);
  const base64 = imageData.toString("base64");

  // Detect media type from file magic bytes, not extension
  // AliExpress often serves webp/png with .jpg extensions
  let mediaType = "image/jpeg";
  if (imageData[0] === 0x89 && imageData[1] === 0x50) {
    mediaType = "image/png";
  } else if (imageData[0] === 0x52 && imageData[1] === 0x49 && imageData[2] === 0x46 && imageData[3] === 0x46) {
    mediaType = "image/webp";
  } else if (imageData[0] === 0x47 && imageData[1] === 0x49 && imageData[2] === 0x46) {
    mediaType = "image/gif";
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: ANALYSIS_PROMPT },
        ],
      },
    ],
  });

  const text = response.content[0].text.trim();

  // Parse JSON from response (handle markdown code fences if present)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.log(`  Warning: could not parse JSON from response`);
    return null;
  }

  return JSON.parse(jsonMatch[0]);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

// Non-clothing keywords — items with garment_type "accessory" whose title
// matches any of these are excluded from the taste profile entirely.
const NON_CLOTHING_KEYWORDS = [
  "kitchen", "electronic", "cable", "tool", "case", "phone", "plug",
  "charger", "lamp", "bag", "pillow", "printer", "drone", "vacuum",
  "grinder", "spatula", "spoon", "knife", "grater", "basket", "rack",
  "tracker", "projector", "strip light", "led", "rubber band", "sanding",
  "cleaning", "stationery", "game", "speaker", "pistol", "gun",
  "insole", "storage", "cooker", "cupping", "massager", "nail file",
  "cutlery", "dinnerware", "plate", "bowl", "towel", "ink", "fabric",
  "heat gun", "recorder", "patch", "film", "dryer sheet", "cigarette",
];

function isNonClothing(title, garmentType) {
  const g = (garmentType || "").toLowerCase();
  const t = (title || "").toLowerCase();
  // Filter out non-clothing "accessory" items and other non-garment types
  const nonGarmentTypes = ["accessory", "cookware", "appliance", "tableware",
    "dinnerware", "bedding", "pillow", "household product", "closet organizer"];
  if (nonGarmentTypes.includes(g)) {
    return NON_CLOTHING_KEYWORDS.some((kw) => t.includes(kw));
  }
  return false;
}

function aggregate(perItem) {
  const colorCounts = {};
  const garmentCounts = {};
  const silhouetteCounts = {};
  const materialCounts = {};
  const tagCounts = {};
  const aestheticCounts = {};
  let skipped = 0;

  for (const item of perItem) {
    const a = item.analysis;
    const garmentType = (a.garment_type || "").toLowerCase();

    // Skip non-clothing items
    if (isNonClothing(item.title, garmentType)) {
      skipped++;
      continue;
    }

    // Colors
    for (const color of a.dominant_colors || []) {
      colorCounts[color] = (colorCounts[color] || 0) + 1;
    }

    // Garment type
    if (garmentType) garmentCounts[garmentType] = (garmentCounts[garmentType] || 0) + 1;

    // Silhouette
    const s = (a.silhouette || "").toLowerCase();
    if (s) silhouetteCounts[s] = (silhouetteCounts[s] || 0) + 1;

    // Material
    const m = (a.material || "").toLowerCase();
    if (m) materialCounts[m] = (materialCounts[m] || 0) + 1;

    // Style tags
    for (const tag of a.style_tags || []) {
      const t = tag.toLowerCase();
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }

    // Aesthetic
    const ae = (a.aesthetic || "").toLowerCase();
    if (ae) aestheticCounts[ae] = (aestheticCounts[ae] || 0) + 1;
  }

  const clothingCount = perItem.length - skipped;

  // Sort by frequency, return top entries
  const topN = (obj, n = 10) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, count]) => ({ name, count }));

  return {
    total_items_analyzed: perItem.length,
    clothing_items_used: clothingCount,
    non_clothing_filtered: skipped,
    top_colors: topN(colorCounts, 15),
    top_garment_types: topN(garmentCounts),
    top_silhouettes: topN(silhouetteCounts),
    top_materials: topN(materialCounts),
    top_style_tags: topN(tagCounts, 15),
    aesthetic_breakdown: topN(aestheticCounts),
    dominant_aesthetic:
      Object.entries(aestheticCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown",
  };
}

// ---------------------------------------------------------------------------
// Console summary
// ---------------------------------------------------------------------------

function printSummary(profile) {
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║     IMMIGRANT — Taste Profile Summary    ║");
  console.log("╚══════════════════════════════════════════╝\n");

  console.log(`Items analyzed: ${profile.total_items_analyzed}`);
  console.log(`Clothing items used: ${profile.clothing_items_used} (${profile.non_clothing_filtered} non-clothing filtered out)\n`);

  console.log("Dominant aesthetic:", profile.dominant_aesthetic.toUpperCase());

  console.log("\nAesthetic breakdown:");
  for (const { name, count } of profile.aesthetic_breakdown) {
    const pct = ((count / profile.clothing_items_used) * 100).toFixed(0);
    console.log(`  ${name.padEnd(15)} ${"█".repeat(Math.round(pct / 3))} ${pct}%`);
  }

  console.log("\nTop colors:");
  for (const { name, count } of profile.top_colors.slice(0, 8)) {
    console.log(`  ${name}  (${count}x)`);
  }

  console.log("\nTop garment types:");
  for (const { name, count } of profile.top_garment_types.slice(0, 6)) {
    console.log(`  ${name.padEnd(20)} ${count}x`);
  }

  console.log("\nTop style tags:");
  for (const { name, count } of profile.top_style_tags.slice(0, 8)) {
    console.log(`  ${name.padEnd(20)} ${count}x`);
  }

  console.log("\nTop silhouettes:");
  for (const { name, count } of profile.top_silhouettes.slice(0, 5)) {
    console.log(`  ${name.padEnd(20)} ${count}x`);
  }

  console.log("\nTop materials:");
  for (const { name, count } of profile.top_materials.slice(0, 5)) {
    console.log(`  ${name.padEnd(20)} ${count}x`);
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== IMMIGRANT Store — Taste Profile Builder ===\n");

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY not set. Copy .env.example to .env and add your key.");
    process.exit(1);
  }

  const client = new Anthropic();
  const db = getDb();
  initSchema(db);

  // Fetch all orders with images
  const orders = db.prepare("SELECT id, product_title, image_path FROM orders WHERE image_path IS NOT NULL").all();

  if (orders.length === 0) {
    console.log("No orders with images found. Run the scraper first: node scraper.js");
    db.close();
    return;
  }

  // Load existing results from previous run to avoid re-analyzing
  let existingPerItem = [];
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf-8"));
      existingPerItem = prev.per_item || [];
      console.log(`Loaded ${existingPerItem.length} existing analyses from previous run.`);
    } catch (_) {}
  }

  // Build set of order IDs already analyzed
  const analyzedIds = new Set(existingPerItem.map((item) => item.order_id));
  const pendingOrders = orders.filter((o) => !analyzedIds.has(o.id));

  console.log(`Found ${orders.length} orders with images.`);
  console.log(`Already analyzed: ${analyzedIds.size}, remaining: ${pendingOrders.length}\n`);

  if (pendingOrders.length === 0) {
    console.log("All images already analyzed. Regenerating profile from cached results.\n");
  }

  // Start with existing results
  const perItem = [...existingPerItem];
  const analyses = existingPerItem.map((item) => item.analysis);

  // Analyze only the pending orders
  for (let i = 0; i < pendingOrders.length; i++) {
    const order = pendingOrders[i];
    console.log(`[${i + 1}/${pendingOrders.length}] ${order.product_title.substring(0, 60)}...`);

    try {
      const result = await analyzeImage(client, order.image_path);
      if (result) {
        analyses.push(result);
        perItem.push({ order_id: order.id, title: order.product_title, analysis: result });
        console.log(`  -> ${result.aesthetic} | ${result.garment_type} | ${result.dominant_colors.join(", ")}`);
      }
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }

    // Small delay to respect rate limits
    if (i < pendingOrders.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (analyses.length === 0) {
    console.log("\nNo images could be analyzed. Check your API key and image files.");
    db.close();
    return;
  }

  // Aggregate into taste profile (filters out non-clothing items)
  const profile = aggregate(perItem);

  // Full output object
  const output = {
    generated_at: new Date().toISOString(),
    profile,
    per_item: perItem,
  };

  // Save to JSON file
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nTaste profile saved to ${OUTPUT_PATH}`);

  // Save to database
  const deleteStmt = db.prepare("DELETE FROM taste_profile");
  const insertStmt = db.prepare("INSERT INTO taste_profile (key, value) VALUES (?, ?)");

  const saveToDb = db.transaction(() => {
    deleteStmt.run(); // Clear old profile data
    insertStmt.run("dominant_aesthetic", profile.dominant_aesthetic);
    insertStmt.run("total_items_analyzed", String(profile.total_items_analyzed));
    insertStmt.run("top_colors", JSON.stringify(profile.top_colors));
    insertStmt.run("top_garment_types", JSON.stringify(profile.top_garment_types));
    insertStmt.run("top_silhouettes", JSON.stringify(profile.top_silhouettes));
    insertStmt.run("top_materials", JSON.stringify(profile.top_materials));
    insertStmt.run("top_style_tags", JSON.stringify(profile.top_style_tags));
    insertStmt.run("aesthetic_breakdown", JSON.stringify(profile.aesthetic_breakdown));
    insertStmt.run("full_profile", JSON.stringify(output));
  });

  saveToDb();
  console.log("Taste profile saved to database (taste_profile table)");

  // Print summary
  printSummary(profile);

  db.close();
}

main();
