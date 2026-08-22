# Commonplace

Personal catch-all system for Zara. Full spec: `../Downloads/commonplace-spec.md` (copy it into
this repo if `Downloads` isn't reliably present for future sessions). Visual source of truth for
styling: `../Downloads/commonplace-mockup-v3.html`.

## Status: live, deployed, Supabase-backed

Deployed at **https://zaraannett.github.io/commonplace/** (public repo, private data). No build
step — static files served as-is by GitHub Pages.

- `index.html` — markup, capture modal, login gate
- `style.css` — all styling, ported from the mockup's design tokens/materials, plus paper-tab,
  drag-handle, week-grid, and auth-gate styles added on top
- `app.js` — data model, rendering, interactions, Supabase client (single file, no framework, no
  build tooling — just `<script>` tags plus the supabase-js UMD build from a CDN)
- `config.js` — Supabase project URL + anon/publishable key (safe to be public; access is enforced
  by RLS policies, not by hiding this key)
- `supabase-schema.sql` — the `entries` + `settings` table definitions and RLS policies; already
  run once against the live project, kept here for reference/rebuilding

### What's implemented
- **Backend**: Supabase Postgres, not localStorage. `entries` table shaped like the spec's sketch
  (id, createdAt, type, title, body, tags[], dueAt, done, doneAt, pinned, source) plus
  `weeklyTarget`/`checkins[]` for habits. A `settings` table holds tag colors, custom tab defs, and
  nav/board drag-order as jsonb, one row per user. Both tables have row-level security scoped to
  `auth.uid()` — verified via direct REST calls that unauthenticated requests return zero rows.
- **Auth**: single-user, email/password via Supabase Auth (`Authentication → Users → Add user` in
  the dashboard — no public sign-up flow exists in the app). Session persists across reloads/
  restarts by default (supabase-js handles this; no extra work needed for "stay logged in").
- **Realtime sync**: a `postgres_changes` subscription on `entries` refetches and re-renders on any
  change, so edits on one device show up on another without a manual refresh.
- Global `+` button and inline per-card `+ add…` rows both create entries (optimistic local update
  + async Supabase write).
- Manual tagging: free-text tags on capture, `+ tag` chip to pre-register a tag/color, click a chip
  to filter the board, search box filters by text+tags.
- Checkboxes toggle `done` on the shared entry — since Big List / Owe a Reply / pinned cards all
  render the *same* entry objects, checking one clears it everywhere (per spec).
- The Everything board is fully computed from `entries`: Big List (pinned — pushpin fastener),
  Owe a Reply, Scratchpad, Habits, Coming Up widget, and the month calendar's due-date dots are all
  derived live, not hardcoded.
- **Habits**: `type: "habit"` entries track a `weeklyTarget` and a `checkins[]` array of ISO dates;
  clicking a habit row toggles *today's* checkin (not a permanent `done`); counter shows
  "{checked-in this week}/{target}".
- **Custom tabs**: `+ tab` prompts for a label + a tag, creates a saved filtered view (in
  `settings.views`), styled as a dog-eared paper tab (not a filing-cabinet drawer tab). Hover to
  see its ✕ to remove it.
- **Fixed tabs are real filtered views now**, not just fallbacks to the full board: Notes shows
  only notes, Diary only diary entries, People shows the Owe-a-Reply list, Big List shows just the
  checkable items, Month shows just the calendar. The week-strip ribbon is Everything-tab-only
  (per spec), hidden on every other tab.
- **Week view**: real, data-driven 7-column graph-paper grid (ported from the mockup's static
  design). Each day column lists that day's due entries as colored blocks by tag; todo/reply blocks
  are clickable to toggle done. No time-of-day field exists in the schema, so blocks aren't
  time-sorted within a day — just grouped by due date.
- **Drag reorder**: nav tabs and board cards both reorder by dragging (grab a card's `⠿` grip, or
  drag any nav tab). Custom pointer-events utility (`enableDragReorder` in `app.js`), not a
  library — works for mouse and touch uniformly since HTML5 drag-and-drop has poor mobile support.
  Order persists in `settings.nav_order` / `settings.board_order`.
- Masthead gradient band: ordered-dither (Bayer 4×4), 2px cells, 32px tall (exact multiple of the
  4-row tile, no seam). Density *and* opacity both taper left→right so the sparse end fades out
  rather than staying full-saturation (which read as "heavier" on the cool-colored right side even
  with fewer dots — a contrast illusion, not a density bug).
- No seed/demo data — first login is a blank slate, since this is Zara's real data now, not a demo.

### Deliberate simplifications vs. the mockup
- Day view is still a static placeholder (needs a time-of-day field on entries to do properly).
- The mockup's "This week" pinned card (a curated multi-item list) is simplified to: any single
  todo/reply entry with `pinned: true` gets its own small pinned card.

## Next phases (see spec + conversation)
- AI auto-tagging (Gemini) so capture doesn't require picking type/tags by hand.
- Real Day view (needs a time field added to the schema).
- Google Calendar sync — **decided to start read-only** (pull gcal events in) before adding
  two-way push, to avoid risk of writing bad data into Zara's real calendar. Needs a Google Cloud
  Console project + OAuth credentials (Zara's own setup, like Supabase was).
- Possible Phase 5: Gmail triage (auto-surface emails that need a reply) — floated as an option,
  not committed to yet. Texts/SMS are a dead end (Apple doesn't allow third-party Messages access);
  the iOS share-sheet capture flow (still not built) is the intended path for "share one important
  text in when it's worth tracking."
- PWA installability (manifest, add-to-homescreen) not yet done.
