# MASTER BRIEFING — IMMIGRANT

## Brand Overview

**IMMIGRANT** is a luxury streetwear brand sold via Shopify dropshipping. The brand curates high-quality pieces from global suppliers, applying a cohesive aesthetic identity that elevates sourced products into a branded collection.

The business model: source products (primarily via AliExpress and similar platforms), curate based on a defined taste profile, publish to Shopify with branded presentation, and promote through automated Instagram content.

## System Architecture

The IMMIGRANT automation system is built in four phases, each adding a layer of capability:

```
┌─────────────────────────────────────────────────────────┐
│                    IMMIGRANT System                      │
│                                                          │
│  Phase 1: TASTE PROFILING                                │
│  ├── AliExpress order scraper (Playwright)               │
│  ├── Claude vision image analysis                        │
│  └── Aggregated taste profile (colors, styles, types)    │
│                                                          │
│  Phase 2: PRODUCT SOURCING & CURATION                    │
│  ├── AliExpress product search/discovery                 │
│  ├── Candidate scoring against taste profile             │
│  ├── Price/shipping/quality filtering                    │
│  └── Curated candidate pipeline                          │
│                                                          │
│  Phase 3: SHOPIFY PUBLISHING                             │
│  ├── Product listing creation via Shopify API            │
│  ├── Branded descriptions and imagery                    │
│  ├── Pricing strategy automation                         │
│  └── Inventory/fulfillment sync                          │
│                                                          │
│  Phase 4: INSTAGRAM CONTENT AUTOMATION                   │
│  ├── Product photography processing                      │
│  ├── Caption and hashtag generation                      │
│  ├── Content calendar and scheduling                     │
│  └── Engagement analytics                                │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js |
| Database | SQLite (better-sqlite3) |
| Scraping | Playwright (Chromium) |
| AI/Vision | Claude API (@anthropic-ai/sdk) |
| Storefront | Shopify (future) |
| Social | Instagram API (future) |
| Config | dotenv, .env files |

## Database Schema

**orders** — Scraped AliExpress purchase history
- id, product_title, image_url, image_path, category, price, seller_id, order_date, created_at

**candidates** — Products discovered for potential curation (Phase 2)
- id, title, image_url, image_path, source, ali_product_id, price, shipping_cost, score, status, created_at

**taste_profile** — Key-value store for aggregated style analysis
- id, key, value, created_at

## Phase 1 — Build Status

| Component | Status |
|-----------|--------|
| SQLite schema (all 3 tables) | Done |
| AliExpress order scraper | Done |
| Cookie-based session persistence | Done |
| Order image downloading | Done |
| Claude vision taste analysis | Done |
| Taste profile aggregation | Done |
| JSON + DB output | Done |
| Console summary display | Done |

### What Phase 1 produces

The taste profile captures:
- **Dominant colors** — hex values ranked by frequency
- **Garment types** — what categories appear most (hoodies, tees, jackets, etc.)
- **Silhouettes** — oversized vs slim vs relaxed vs cropped
- **Materials** — cotton, nylon, leather, etc.
- **Style tags** — specific aesthetic descriptors (up to 5 per item)
- **Aesthetic category** — streetwear / minimal / tailored / utility / other
- **Overall aesthetic direction** — the dominant category across all purchases

This profile becomes the scoring rubric for Phase 2 candidate evaluation.

## Phase 2 — Next Up

Product sourcing: discover new products on AliExpress, score them against the taste profile, and build a curated candidate pipeline. The `candidates` table is already scaffolded and ready.

## Running the System

```bash
# Setup
npm install
npx playwright install chromium
cp .env.example .env   # Add ANTHROPIC_API_KEY

# Phase 1
node db.js             # Initialize database
node scraper.js        # Scrape AliExpress orders (manual login on first run)
node taste-builder.js  # Build taste profile from order images
```
