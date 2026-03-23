// test-turso.js — Minimal Turso connection test
// Usage: node test-turso.js

require("dotenv").config();
const { createClient } = require("@libsql/client");

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;

  console.log("=== Turso Connection Test ===\n");
  console.log("URL:", url);
  console.log("URL protocol:", url ? url.split("://")[0] : "NOT SET");
  console.log("Token length:", token ? token.length : "NOT SET");
  console.log("Token starts:", token ? token.substring(0, 30) + "..." : "NOT SET");
  try { console.log("@libsql/client version:", require("@libsql/client/package.json").version); } catch (_) { console.log("@libsql/client version: (can't read package.json)"); }
  console.log("");

  if (!url || !token) {
    console.error("ERROR: TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set");
    process.exit(1);
  }

  // Test 1: Create client
  console.log("Test 1: Creating client...");
  let client;
  try {
    client = createClient({ url, authToken: token });
    console.log("  OK — client created");
  } catch (err) {
    console.error("  FAIL:", err.message);
    process.exit(1);
  }

  // Test 2: SELECT 1
  console.log("\nTest 2: SELECT 1...");
  try {
    const result = await client.execute("SELECT 1 as test");
    console.log("  OK — result:", JSON.stringify(result.rows));
  } catch (err) {
    console.error("  FAIL:", err.message);
    console.error("  Full error:", JSON.stringify(err, Object.getOwnPropertyNames(err)));
  }

  // Test 3: List tables
  console.log("\nTest 3: SELECT name FROM sqlite_master WHERE type='table'...");
  try {
    const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table'");
    console.log("  OK — tables:", result.rows.map(r => r.name).join(", "));
  } catch (err) {
    console.error("  FAIL:", err.message);
  }

  // Test 4: Count candidates
  console.log("\nTest 4: SELECT COUNT(*) FROM candidates...");
  try {
    const result = await client.execute("SELECT COUNT(*) as c FROM candidates");
    console.log("  OK — count:", result.rows[0]?.c);
  } catch (err) {
    console.error("  FAIL:", err.message);
  }

  // Test 5: Sample row
  console.log("\nTest 5: SELECT id, title FROM candidates LIMIT 1...");
  try {
    const result = await client.execute("SELECT id, title FROM candidates LIMIT 1");
    console.log("  OK — row:", JSON.stringify(result.rows[0]));
  } catch (err) {
    console.error("  FAIL:", err.message);
  }

  console.log("\n=== Done ===");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
