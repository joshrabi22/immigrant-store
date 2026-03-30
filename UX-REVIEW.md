# IMMIGRANT Internal Tool — UX/Design Review
_Reviewed: 2026-03-29_

---

## 1. Overall Verdict

The internal tool currently feels like **a functional pipeline manager wearing a luxury skin**. The bone canvas, dark sidebar, Cormorant Garamond headers, and gold accent (#C4A882) establish a real identity — this is not a generic admin panel. But the moment you interact with the actual working surfaces — the intake grids, the staging cards, the detail page — the experience drops from "editorial curation console" to "database browser with nice fonts."

The gap is not in aesthetics. The gap is in **operator experience design**. The tool doesn't yet help you make taste decisions — it presents data and asks you to act on it. The difference between those two things is the entire product.

---

## 2. What Already Works

**Sidebar navigation** is genuinely strong. The INTAKE → CURATION → REVIEW → PUBLISH grouping maps perfectly to the pipeline, and the gold active-state indicator + count badges make system state legible at a glance. The section labels (INTAKE, CURATION, REVIEW, PUBLISH) read like a workflow, not a menu. This is the right structure — don't change it.

**Photo Suite idle state** is well-composed. The quality checklist, flow/session options, and centered vertical layout feel calm and intentional. This is the closest surface to the target editorial tone. The review criteria display (Background, Lighting, Shadow, Fidelity, Framing) gives the operator a clear mental model before they begin.

**Approved page** shows what the downstream editorial layer could feel like. The horizontal cards with processed Cloudinary images, generated names ("court reverie", "coral drift"), descriptions in brand voice, and clean MENS/PAST_ORDER tags demonstrate that the pipeline output works. When Ghost Logic succeeds, the product is visible.

**Processing page** is honest and functional. The list layout with small thumbnails and PENDING badges is appropriate for a monitoring surface. It doesn't try to be editorial — it's a queue, and it reads like one.

**The state machine** is well-represented in the UI. Revision banners, READY badges, source badges (SUGGESTED, WISHLIST, PAST_ORDER), and image count indicators give the operator real information. The system doesn't hide its own state.

---

## 3. What Feels Weak or Breaks Trust

### 3a. Intake cards are decision-hostile

The intake grid (Initial Suggestions, Wishlist) is the highest-volume surface — 702 items in Suggested alone. This is where you spend the most time. And the card gives you almost nothing to decide with:

- **Title is raw AliExpress garbage.** "Cake Tools Danish Dough Whisk Stainless Steel Dutch Bread Dough..." is not a product title — it's SEO spam. The operator has to mentally filter this to extract meaning. Every card requires cognitive work that the system should be doing.
- **Image is 1:1 square with `object-fit: cover`**, which crops fashion products (which are portrait-oriented) aggressively. The FoundCo spec says 4:5 — intake cards should use it too. (Note: staging cards were recently fixed to 4:5, but intake cards still use 1:1.)
- **No category, no gender, no detected quality signal.** You're looking at a blank card with a price and a title. You can't tell if it's mens or womens, outerwear or accessories, without opening the AliExpress link. That defeats the purpose of a grid-level swipe flow.
- **The "View source" link opens AliExpress** in a new tab. If the operator needs to leave the tool to make a decision, the tool has failed its primary job.

### 3b. Empty image states dominate the experience

In a fashion curation tool, the image IS the decision. When images fail to load (AliExpress CDN issues, protocol-relative URLs, .avif wrappers), the card becomes a blank rectangle with text below it. The intake grid currently shows rows of blank cream cards — this is not a usable working state for a visual product.

The `resolveImage()` function in IntakeCard uses raw AliExpress URLs without cleaning (the `imgUrl()` helper exists but isn't used in intake). This is the same bug that was fixed in StagingCard but hasn't propagated.

### 3c. Staging detail page is a split-screen form, not a curation surface

The staging detail view (deep edit) shows a two-column layout: gallery editor on the left, metadata form on the right. The gallery section currently showed "No images in gallery" (for a revision item with cleared images). The metadata form is standard form controls: text inputs, dropdowns, save buttons.

This is functional but it doesn't support the operator's actual task. In staging, the operator is asking: "Is this product worth processing? Should I split this into variants? Does the gallery look clean?" The current layout asks them to fill out a form.

### 3d. Staging grid has no filtering, sorting, or status overview

7 items in staging right now. That's manageable. But when the pipeline scales, the operator needs to answer: "How many items need processing? How many are revision items? What sources are represented?" The staging page offers no filtering by source, no sorting by status, no summary bar — just a flat grid.

### 3e. Approved page layout breaks the editorial promise

The Approved surface should be the merchandising tier — "editorial, image-led, spacious" per DECISIONS.md. Instead, it uses horizontal row cards with a small square thumbnail (~80px) alongside text. The processed image that Ghost Logic worked to create (Photoroom extraction → Gemini compositing → Cloudinary hosting) is displayed at roughly the size of a desktop icon. This is the opposite of image-led.

---

## 4. Workflow Friction

### 4a. Intake approve/reject has no batch mode

702 items. Two buttons per card. No keyboard shortcuts. No swipe gesture. No "reject all visible" or "select multiple." The operator must individually click Approve or Reject on every single card. At 702 items with even 2 seconds per decision, that's 23 minutes of pure clicking — with no undo.

### 4b. No undo on approve or reject

Both intake approve and reject are immediate, irreversible mutations. There's no toast with undo, no "recently acted" history, no way to recover from a mis-click. On a surface with 702 nearly-identical-looking cards, mis-clicks are inevitable.

### 4c. Processing queue has no automatic retry or progress indicator

28 items show PENDING in the processing queue. They will stay PENDING forever unless someone runs `ghostLogicWorker.js --direct <id>` manually or Redis is available for BullMQ. There's no indication of whether the worker is running, when items were submitted, how long they've been waiting, or what to do about it.

### 4d. Photo Suite requires manual session start

The Photo Suite idle state is clean, but it requires the operator to explicitly start a flow or session before reviewing anything. If there are 0 items ready (as shown), the operator sees "No items are ready for review yet" — but they're told that 28 items are in processing. There's no connection between these states. The operator has to mentally track: "I processed some items → they went to processing → when processing finishes they'll appear here." The tool should make this pipeline progression visible.

### 4e. Gallery editor has no image preview or zoom

The gallery editor in staging detail shows thumbnails at ~130px in a grid. For fashion products where texture, drape, and detail matter, these thumbnails are insufficient for quality assessment. There's no lightbox, no zoom, no click-to-enlarge.

### 4f. Split workflow is buried inside gallery editor

The split (variant creation) button (✂) is a small icon in the bottom action bar of each gallery thumbnail. It's undiscoverable, unlabeled, and visually identical in weight to the move/delete actions. Splitting is a significant structural operation (creates a new database row, modifies parent gallery) disguised as a thumbnail action.

---

## 5. Visual/Design Improvements

### 5a. Intake cards need the FoundCo treatment

The grid spec in DECISIONS.md says: 3-column, 40px gap, 4:5 aspect ratio, `object-fit: contain` on `#F5F2ED`. The intake grid currently uses 4 columns, minimal gap, 1:1 aspect ratio, and `object-fit: cover`. This is the highest-volume surface and it doesn't follow the design system. The staging grid was partially fixed (4:5, contain) but intake was missed.

Switching intake to 3-column / 4:5 / contain would immediately make the grid feel more editorial and give products room to breathe. The wider cards also give more room for useful metadata below the image.

### 5b. Card hierarchy needs levels

Right now, intake cards and staging cards look almost identical — white card, image, text, two buttons. But they serve fundamentally different purposes: intake is fast triage (yes/no), staging is considered curation (process/edit/split/remove). The cards should visually signal this difference.

Intake cards should be lighter, simpler, optimized for speed — closer to a stack of photos you're flipping through. Staging cards should feel more substantive — these are products you've already said yes to.

### 5c. The bone canvas needs breathing room

The main content area background is `#F5F2ED` (correct per brand), but cards sit on `#fff` with very thin shadows. The contrast between card and canvas is almost invisible. This creates a flat, wallpaper-like effect rather than the "items floating on a studio surface" feel that the brand targets. Slightly increasing card shadow or introducing subtle card borders would give the grid depth without adding visual noise.

### 5d. Typography is underused

Cormorant Garamond appears in page titles and item names, but the rest of the UI uses system sans-serif at small sizes. The metadata, badges, button labels, and helper text all feel utilitarian. A second typeface tier (a clean sans like Inter or the existing Helvetica Neue at slightly larger sizes) would give the operational text more presence without competing with the editorial headers.

### 5e. Button styling is too uniform

Every surface uses the same button pattern: dark-fill primary, light-fill secondary. Approve, Process, Remove, Move to Launch, Accept, Reject, Discard — they all look roughly the same. The operator has to read button labels to understand the action hierarchy. Color-coding by consequence (destructive = muted red, progressive = dark fill, neutral = outline) would reduce cognitive load.

---

## 6. Workflow/Interaction Improvements

### 6a. Add keyboard shortcuts to intake

The most impactful single improvement: arrow-key or J/K navigation through intake items, with A to approve and R to reject. The Photo Suite already has keyboard shortcuts (→ Accept, ← Revision, ↓ Discard). The intake surface needs the same treatment. This turns a 23-minute clicking marathon into a fast-flowing triage session.

### 6b. Add a pipeline status bar

A thin, persistent bar above the main content showing: "702 intake → 7 staging → 28 processing → 0 ready → 2 approved → 0 launch → 0 live" would give the operator constant awareness of where products are in the pipeline. Right now this information is scattered across sidebar badges.

### 6c. Show gender/category chips on intake cards

The scraper and AI already detect gender. The data exists in the database. Displaying it on the intake card (even as a small chip) eliminates the need to open AliExpress to understand what you're looking at. Category would help too when available.

### 6d. Add a "processing status" indicator to the pipeline

When items are in processing and the worker isn't running, nothing happens and nothing communicates this. A simple "Worker: idle / active" indicator, or "Last processed: 2 hours ago," would tell the operator whether the pipeline is actually moving.

### 6e. Add toast + undo to approve/reject

After approve or reject, show a toast at the bottom: "Item approved → Staging" with an Undo link, auto-dismissing after 5 seconds. This single pattern would eliminate the anxiety of irreversible decisions on high-volume screens.

### 6f. Approved page should use large image cards

The Approved surface is the merchandising tier. Switch from horizontal list cards to the FoundCo grid (3-column, 4:5, large processed images). This is where the Ghost Logic output should shine — big, clean, studio-processed images with generated names and descriptions below. The current small-thumbnail layout wastes the pipeline's best output.

---

## 7. Future-Alignment Improvements

### 7a. The intake swipe could become the customer swipe

The intake approve/reject flow is structurally identical to the future customer swipe (right = pull, left = pass). Building keyboard-driven, card-focused intake review now — with smooth transitions between items — establishes the interaction vocabulary that the customer-facing product will use. Don't build the customer swipe yet, but make the internal swipe feel like one.

### 7b. Processed image presentation should preview the storefront

The Approved and Launch surfaces should show products roughly as customers will see them: FoundCo grid, bone background, generated name, brand-voice description, consistent image treatment. This gives the operator a "storefront preview" during the final review stage, catching presentation issues before Shopify publish.

### 7c. Gallery handling should anticipate the product page

When the operator edits the gallery in staging detail, they're essentially building the product page image set. The gallery editor should reflect this: hero image prominent, supporting images as thumbnails below, clear visual distinction between "this is what the customer sees first" and "these are detail shots."

### 7d. Brand-voice naming should surface earlier

Stage 3 (Claude naming) generates names like "dust revival" and "coral drift." These are good. But they only appear after processing. In staging, you still see raw AliExpress titles ("CMF mountain functional waterproof outdoor color matching jacket vest..."). Showing the generated name prominently (and the AliExpress title dimmed underneath for reference) would make staging feel like a brand workspace, not a database viewer.

---

## 8. Top 10 Recommendations in Priority Order

1. **Add keyboard shortcuts to intake** (A/R keys for approve/reject, J/K for navigation). This is the highest-volume surface and the biggest operator bottleneck.

2. **Fix intake cards: 3-column grid, 4:5 aspect ratio, `object-fit: contain`, cleaned image URLs via `imgUrl()`**. Bring intake in line with the FoundCo spec and the staging card fix.

3. **Show gender + category chips on intake cards.** The data exists — surface it. Eliminates the need to open AliExpress links.

4. **Add toast + undo to intake approve/reject.** Prevents irreversible mistakes on the highest-volume surface.

5. **Redesign Approved page to use FoundCo grid with large processed images.** This is the merchandising tier — the processed images should be displayed at full editorial scale.

6. **Add a pipeline status summary bar** (persistent, above main content). Makes the full system state visible without checking individual pages.

7. **Add lightbox/zoom to gallery editor.** Fashion curation requires seeing texture and detail. 130px thumbnails aren't enough.

8. **Surface generated names in staging cards** (show the brand name prominently, AliExpress title in small muted text below). Makes staging feel like a curation workspace.

9. **Add empty-state guidance to intake** when images fail to load. Show a message or attempt URL repair rather than displaying blank cream rectangles.

10. **Add elapsed-time indicators to processing queue** ("Pending for 2h 14m") and a worker status signal. The operator needs to know if the pipeline is actually moving.

---

## 9. Immediate Next Design Move

**Add keyboard shortcuts to intake approve/reject.**

This is the single change that would most improve operator velocity and make the tool feel purposeful rather than passive. It requires no visual redesign, no backend changes, no architectural decisions. It's purely a frontend interaction upgrade on the existing IntakeGrid/IntakeCard components, and the pattern already exists in PhotoSuiteReviewCard (which uses ArrowRight, ArrowLeft, ArrowDown + C). Apply the same approach: focus the current card, use A to approve, R to reject, J/K or arrow keys to navigate. Add a focused-card highlight so the operator knows which item has keyboard focus.

This turns intake from a clicking exercise into a rhythm. And it establishes the gestural vocabulary for the future customer swipe.
