// seed-orders.js — Copy clothing items from orders table into candidates
// Usage: node seed-orders.js
//
// Copies the 76 clothing items (those that were analyzed and not filtered
// as non-clothing) from the orders table into the candidates table with
// source='past_order'. Skips items already seeded.

const fs = require("fs");
const path = require("path");
const { getDb, initSchema } = require("./db");
const { loadTasteProfile } = require("./lib/taste");

function main() {
  console.log("=== IMMIGRANT Store — Seed Past Orders into Candidates ===\n");

  const db = getDb();
  initSchema(db);

  // Load taste profile to get the list of analyzed clothing items
  const tasteData = loadTasteProfile();
  const analyzedOrderIds = new Set(
    tasteData.per_item
      .filter((item) => item.analysis) // only successfully analyzed
      .map((item) => item.order_id)
  );

  // Get orders that were analyzed
  const orders = db.prepare("SELECT * FROM orders WHERE id IN (" +
    [...analyzedOrderIds].join(",") + ")"
  ).all();

  console.log(`Found ${orders.length} analyzed orders to seed.\n`);

  // Check which are already seeded
  const existingTitles = new Set(
    db.prepare("SELECT title FROM candidates WHERE source = 'past_order'").all()
      .map((r) => r.title)
  );

  const insert = db.prepare(`
    INSERT INTO candidates (title, image_url, image_path, source, ali_product_id, price, status)
    VALUES (@title, @image_url, @image_path, 'past_order', @ali_product_id, @price, 'new')
  `);

  let added = 0;
  let skipped = 0;

  for (const order of orders) {
    if (existingTitles.has(order.product_title)) {
      skipped++;
      continue;
    }

    insert.run({
      title: order.product_title,
      image_url: order.image_url,
      image_path: order.image_path,
      ali_product_id: null,
      price: order.price,
    });
    added++;
  }

  console.log(`Seeded ${added} past orders into candidates (${skipped} already existed).`);
  console.log(`Total candidates: ${db.prepare("SELECT COUNT(*) as c FROM candidates").get().c}`);

  db.close();
}

main();
