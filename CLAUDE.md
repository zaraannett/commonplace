# Commonplace

Personal catch-all system. Full spec: `../Downloads/commonplace-spec.md` (copy it into
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
- `manifest.json`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `sw.js` — PWA
  installability. Icons are a plain italic serif "C" (Georgia, since a blank canvas can't load
  Newsreader) on the paper color, generated via a throwaway `<canvas>` script, not authored in a
  design tool — regenerate the same way if they ever need to change. `sw.js` caches only the
  same-origin app-shell files (index.html/style.css/app.js/config.js/manifest.json) via
  stale-while-revalidate; it explicitly bails on any cross-origin request (`url.origin !==
  self.location.origin`) so it never touches Supabase or the CDN script — live data and realtime
  sync are unaffected by it.

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
  Owe a Reply, Scratchpad, Habits, Tasks, Coming Up widget, and the month calendar's due-date dots
  are all derived live, not hardcoded.
- **Tasks**: `type: "task"` entries, a plain checkable list separate from Big List — for random
  one-off to-dos that don't need the tracking/aging Big List gives real todos. Deliberately kept
  out of Big List's aggregation (which only pulls `todo`/`reply`) rather than reusing `todo` with a
  flag, since the whole point was "a different bucket," not a filtered view of the same one.
  Has its own fixed nav tab, same pattern as Big List/Notes/etc.
- **Task boxes** (the Tasks tab specifically, not the Everything card): a "mood board" style view —
  several manually-named boxes (`settings.task_boxes`, `{id, title}`), each a mini checklist you
  add rows to directly. A task's `boxId` (db column `box_id`, migration 2 in
  `supabase-schema.sql`) places it in a box; unboxed tasks land in an always-present "Unsorted"
  box that can't be deleted. Boxes get varied tints (plain/butter/sage/lilac/peri cycling by
  position) via the existing masonry pack for visual variety — this is the "packed shuffled grid"
  choice, not true freeform drag-anywhere placement, which was considered and deliberately deferred
  as a much bigger build (position storage, drag-anywhere vs. reorder, resize handles). Click a
  task's text (not its checkbox) to expand a Caveat-handwriting post-it-styled panel underneath it
  for a longer note — this reuses the entry's existing `title` field (otherwise unused on tasks) so
  it needed zero new entry columns, just the `box_id` one. The Everything board's Tasks card is
  untouched by any of this — same flat, all-boxes-merged checklist as before, by design ("simplify
  the full detail down for Everything, don't change Everything's look").
- Tags shown *on* cards (not just the header chips) are clickable and filter the board the same
  way — `tagSpan()` helper + one delegated click listener on `#board` for any `[data-tag]`.
  Header chips intentionally list every registered tag color even before it's used on an entry
  (so the color's ready the moment you tag something with it) — that's expected, not a bug; if a
  chip filters to "nothing but Coming Up/Calendar" it means no entry is tagged that way *yet*, not
  that filtering is broken.
- **Habits**: `type: "habit"` entries track a `weeklyTarget` and a `checkins[]` array of ISO dates;
  clicking a habit row toggles *today's* checkin (not a permanent `done`); counter shows
  "{checked-in this week}/{target}".
- **Tabs — "drawer logic"**: every tab (fixed and custom alike) is one continuous folder-edge
  shape with the content panel below it, not a separate nav-link style. Idle tabs are outlined
  cream cards with curved fillet "feet" (`::before`/`::after` radial-gradients) that interlock with
  their neighbors; the active tab and the panel's 7px top border are both solid `--grey`
  (`#8B8375`) with no border between them, so they read as one shape — literally the open folder's
  top edge. No box-shadows, no transforms anywhere in the tab bar; depth comes entirely from that
  shared grey continuation. This went through several rounds of visual iteration (see conversation)
  before landing on an exact spec that was implemented verbatim — if this ever needs to change,
  treat the shape/geometry as deliberate and load-bearing, not incidental.
  `+ tab` prompts for a label + a tag and creates a saved filtered view (`settings.views`); custom
  tabs show a hover ✕ to remove them. Tab row scrolls horizontally on narrow viewports (added
  beyond the literal spec, which assumed one row fits — needed for 8+ tabs on mobile) rather than
  wrapping, so the active tab always stays adjacent to the folder panel and the illusion holds at
  any width.
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
- No seed/demo data — first login is a blank slate, since this is real data now, not a demo.

### Deliberate simplifications vs. the mockup
- Day view is still a static placeholder (needs a time-of-day field on entries to do properly).
- The mockup's "This week" pinned card (a curated multi-item list) is simplified to: any single
  todo/reply entry with `pinned: true` gets its own small pinned card.

### PWA (done)
`manifest.json` + `icon-*.png` + `sw.js` — see the earlier note near the file list. Installable
on the home screen, opens standalone (no browser chrome).

### Share-sheet capture (done)
iOS can't register a PWA as a native Share Sheet target (that's Android-only, via the Web Share
Target API), so this is a small **iOS Shortcut + Supabase Edge Function** pair instead:
- `supabase/functions/capture/index.ts` — deployed via the Supabase dashboard's function editor
  (pasted in directly, not the CLI). Single-user auth model: the Shortcut sends a long random
  `CAPTURE_SECRET` in the JSON body that only it and this function know; that secret is the only
  gate on the insert, which then runs with the service-role key (auto-injected into every Edge
  Function by Supabase, never exposed to the client/Shortcut). `OWNER_USER_ID` (a hardcoded UUID,
  since there's only ever one user) and the secret are both set as Function Secrets in the
  dashboard, not in code.
- When the shared text is a URL, the function fetches the page server-side and pulls `og:title`/
  `<title>` and `og:image` (falling back to `twitter:title`/`twitter:image`) to populate the
  entry's `title` and new `image_url` column — so a shared link lands looking like a real link
  preview card (thumbnail + heading), not a bare URL. Tagged `#shared` always, plus `#link` when
  it's a URL. Some sites (Google search results, anything behind bot protection) will fail the
  server-side fetch and fall back to a bare link — that's the site blocking it, not a bug here.
- The iOS Shortcut itself ("Add to Commonplace") lives only on the phone, not in this repo —
  it's a **Get Contents of URL** action (POST, JSON body with `text` = the Shortcut Input
  variable and `secret` = the same secret, header `Authorization: Bearer <anon key>`), with
  "Show in Share Sheet" enabled in its Details.
- Client-side (`app.js`/`style.css`): any note whose `body` is a URL renders as an actual
  clickable link (`.note-link`); any note with `image_url` set shows a thumbnail above the title
  (`.note-thumb`, filtered `saturate(.82) sepia(.06)` to sit better against the app's desaturated
  paper palette rather than a jarring full-color photo — worth revisiting if that reads as muddy
  rather than harmonious).

### Handwriting / Apple Pencil (done)
Diary entries and task post-its can be hand-drawn instead of typed — a "separate sketch mode"
per entry (draw OR type, not a layer on top of text), per explicit choice over annotating-on-top.
- **[perfect-freehand](https://github.com/steveruizok/perfect-freehand)** (loaded via a dynamic
  `import("https://esm.sh/perfect-freehand")` inside `app.js` — works fine from a plain script,
  no `type="module"` needed) turns raw pointer points into smoothed, pressure-tapered ink
  outlines. `svgPathFromOutline()` is its standard documented helper for turning that outline into
  an SVG path string. If the import hasn't resolved yet, strokes fall back to a plain polyline so
  drawing still works immediately.
- Ink is stored as **vector strokes**, not a photo: `entries.drawing` (jsonb, migration 4) =
  `{ w, h, strokes: [[ [x,y,pressure], ... ], ...] }`, coordinates in CSS pixels relative to the
  canvas at draw time. Cheap to store/sync, stays crisp at any zoom when replayed as an `<svg>`.
- `initSketchpad(canvas, drawing, onChange)` wires Pointer Events onto a blank canvas — real
  pressure only comes from `pointerType === "pen"` (Apple Pencil); mouse/touch points are recorded
  at a constant pressure so `getStroke` simulates a natural taper for those instead of a
  uniform-width line. **Palm rejection** is simple but effective: while one pointer is actively
  drawing, a second pointer (a resting palm) is ignored outright, and a stray touch within 500ms of
  the pencil lifting is also ignored.
- Autosaves after every completed stroke (a canvas has no "blur" to hook like the task-note
  textarea does) via `updateEntryDrawing()`, debounced 500ms — deliberately does **not** call
  `render()`, so the live canvas isn't torn down mid-drawing-session. The realtime subscription
  (which would otherwise refetch-and-render on our own autosave, too) is guarded by
  `anySketchEditingOpen()` to skip the rebuild while any sketch is actively open; `entries[]` stays
  fresh underneath, the final ink just doesn't render until editing is closed.
- Diary: pencil icon on each card toggles sketch mode; a "+ new sketch" tile (Diary tab only,
  same pattern as Tasks' "+ new box") creates a blank sketch entry and opens it immediately.
  Task post-its: a "✎ draw instead" / "Aa type instead" toggle switches that task's detail between
  the existing bullet-textarea and a canvas; `hasTaskDetail()` (which decides whether a task has
  "graduated" out of its box onto its own postit) now also checks for ink, not just title text.
- Known simplification: resizing the window/rotating the device does **not** rescale existing
  strokes to the new canvas size (they're stored in the original canvas's pixel coordinates) —
  same class of deliberate scope-limit as the Day view placeholder. Not expected to matter much in
  practice since orientation is normally settled before you start drawing.

## Next phases (see spec + conversation)
- AI auto-tagging (Gemini) so capture doesn't require picking type/tags by hand.
- Real Day view (needs a time field added to the schema).
- Google Calendar sync — **decided to start read-only** (pull gcal events in) before adding
  two-way push, to avoid risk of writing bad data into the real calendar. Needs a Google Cloud
  Console project + OAuth credentials (same kind of one-time setup as Supabase was).
- Possible later phase: Gmail triage (auto-surface emails that need a reply) — floated as an
  option, not committed to yet.
