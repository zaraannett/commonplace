# Commonplace

Personal catch-all system for Zara. Full spec: `../Downloads/commonplace-spec.md` (copy it into
this repo if `Downloads` isn't reliably present for future sessions). Visual source of truth for
styling: `../Downloads/commonplace-mockup-v3.html`.

## Status: Phase 1 + pulled-forward drag reorder, habits, custom tabs

Everything board + capture + manual tags + checkboxes + habits + drag reorder + user-created tabs,
persisted to `localStorage`. No build step — open `index.html` directly or serve the folder
statically. Next up is wiring this to Supabase so it's a real live app instead of per-browser
localStorage (see "Live database" below) — deploy target is GitHub Pages (user already has a
GitHub account and has deployed static sites before).

- `index.html` — markup + capture modal
- `style.css` — all styling, ported 1:1 from the mockup's design tokens/materials, plus paper-tab
  and drag-handle styles added for the features below
- `app.js` — data model, rendering, interactions (single file, no framework, no dependencies)

### What's implemented
- Entries stored in `localStorage` under `cp_entries`, shaped like the spec's future Supabase
  `entries` table (id, createdAt, type, title, body, tags[], dueAt, done, doneAt, pinned, source),
  plus `weeklyTarget`/`checkins[]` on habit-type entries.
- Global `+` button and inline per-card `+ add…` rows both create entries.
- Manual tagging: free-text tags on capture, `+ tag` chip to pre-register a tag/color, click a
  chip to filter the board, search box filters by text+tags.
- Checkboxes toggle `done` on the shared entry — since Big List / Owe a Reply / pinned cards all
  render the *same* entry objects, checking one clears it everywhere (per spec).
- The board is fully computed from `entries`, not hardcoded: Big List, Owe a Reply, Scratchpad,
  Habits, Coming Up widget, and the month calendar's due-date dots are all derived live.
- **Habits card is back**: `type: "habit"` entries track a `weeklyTarget` and a `checkins[]` array
  of ISO dates; clicking a habit row toggles today's checkin (not a permanent `done`); the counter
  shows "{checked-in this week}/{target}".
- **Custom tabs**: `+ tab` in the nav prompts for a label + a tag, and creates a saved
  filtered view (stored in `localStorage` under `cp_views`), styled as a dog-eared paper tab
  (not a filing-cabinet drawer tab) to match the card materials system. Hover a custom tab to see
  its ✕ to remove it. Fixed tabs (Everything, Notes, etc.) are unaffected/unfiltered, same as
  before.
- **Drag reorder**: both the nav tabs and the board cards can be reordered by dragging (grab the
  small `⠿` grip in a card's corner, or drag any nav tab). Implemented as a small custom
  pointer-events utility (`enableDragReorder` in `app.js`) rather than a library — works for mouse
  and touch uniformly, since HTML5 drag-and-drop has poor mobile support. Order is persisted to
  `localStorage` (`cp_board_order`, `cp_nav_order`) and re-applied on every render.
- Seed data matches the mockup's sample content so first run looks populated.

### Deliberate simplifications vs. the mockup
- Day/Week views are static placeholders (real timeline wiring is Phase 3 in the spec).
- Notes/Big List/Diary/People/Month fixed nav items fall back to the unfiltered Everything board —
  custom tabs are how filtered views work for now.
- The mockup's "This week" pinned card (a curated multi-item list) is simplified to: any single
  todo/reply entry with `pinned: true` gets its own small pinned card.

## Live database (in progress)

Zara wants this to be a real app she can add to from her phone, not just a local file — i.e.
Phase 2 (Supabase persistence) pulled forward, deployed live rather than iterated on locally only.
Plan: keep the same `entries` shape, swap `localStorage` reads/writes in `app.js` for Supabase
client calls, add lightweight single-user auth since the deployed URL will be public. Needs Zara to
create the Supabase project herself (Claude can't create accounts on her behalf) and hand over the
project URL + anon key; Claude does the rest of the wiring.

## Later phases (see spec)
3. Gemini-based auto-tagging Edge Function + real Day/Week/Month views.
4. Google Calendar sync, PWA installability.
