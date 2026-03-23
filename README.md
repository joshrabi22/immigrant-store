# IMMIGRANT Store — Phase 1

AliExpress order scraping and AI-powered taste profile builder for the IMMIGRANT luxury streetwear brand.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

## Initialize the database

```bash
node db.js
```

## Step 1: Scrape AliExpress orders

First, close Chrome completely, then relaunch with remote debugging:

```bash
# Mac
open -a "Google Chrome" --args --remote-debugging-port=9222

# Windows
start chrome --remote-debugging-port=9222
```

Log in to AliExpress in that Chrome window, then run the scraper:

```bash
node scraper.js
```

- Connects to your real Chrome via DevTools Protocol (no bot detection)
- Opens a new tab, navigates to orders, and scrapes all pages
- Downloads product images to `images/orders/`
- Saves everything to `data.db`
- Saves `debug-page.html` on every run for selector inspection

## Step 2: Build taste profile

```bash
node taste-builder.js
```

- Sends each order image to Claude vision for analysis
- Extracts colors, garment types, silhouettes, materials, style tags, aesthetics
- Aggregates into a master taste profile
- Outputs `taste_profile.json` and saves to database
- Prints a visual summary to console

## Project structure

```
├── db.js              # Database setup and shared connection
├── scraper.js         # AliExpress Playwright scraper
├── taste-builder.js   # Claude vision taste profile builder
├── data.db            # SQLite database (generated)
├── cookies.json       # AliExpress session (generated)
├── taste_profile.json # Output taste profile (generated)
└── images/orders/     # Downloaded product images (generated)
```
