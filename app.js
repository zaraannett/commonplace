/* ── Commonplace ──────────────────────────────────────────────────────
   Everything board + capture + manual tags + checkboxes + habits + drag
   reorder + custom tabs, persisted to Supabase (see config.js for the
   project URL/key). Single-user, gated behind Supabase Auth email/password.
   Entries table: id, createdAt, type, title, body, tags[], dueAt, done,
   doneAt, pinned, source, weeklyTarget, checkins[] (see supabase-schema.sql).
   ──────────────────────────────────────────────────────────────────── */

const COLOR_ROTATION = ["butter", "sage", "peri", "lilac", "rose", "cyan"];
const DAY = 86400000;
// Coarse pointer (touch/pen) vs fine pointer (mouse/trackpad) — not a screen-width breakpoint,
// since an iPad can be just as wide as a laptop. Used to keep the diary's drawing option off of
// plain desktop/laptop browsers, where there's no pen to draw with anyway.
const isTouchCapable = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;

// ── date helpers ──────────────────────────────────────────────────────
function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function parseDate(s) {
  if (!s) return null;
  const d = new Date(s + "T00:00:00");
  return isNaN(d) ? null : d;
}
function daysBetween(a, b) {
  return Math.round((b - a) / DAY);
}
function fmtDue(entry) {
  if (entry.done) return "";
  if (entry.dueAt) {
    const diff = daysBetween(todayStart(), parseDate(entry.dueAt));
    if (diff < 0) return { text: "overdue", cls: "due soon" };
    if (diff === 0) return { text: "today", cls: "due soon" };
    if (diff === 1) return { text: "1d left", cls: "due soon" };
    const cls = diff <= 2 ? "due soon" : "due";
    return { text: diff + "d left", cls };
  }
  const sitting = daysBetween(parseDate(entry.createdAt.slice(0, 10)), todayStart());
  if (sitting > 2) return { text: sitting + "d sitting", cls: "due age" };
  return null;
}
function fmtNag(entry) {
  const sitting = Math.max(0, daysBetween(parseDate(entry.createdAt.slice(0, 10)), todayStart()));
  return sitting + (sitting <= 3 && sitting > 0 ? " days!!" : " days");
}
function mondayOf(d) {
  const dow = (d.getDay() + 6) % 7;
  const m = new Date(d);
  m.setDate(m.getDate() - dow);
  m.setHours(0, 0, 0, 0);
  return m;
}
function weekIsoDates() {
  const mon = mondayOf(new Date());
  const arr = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon);
    d.setDate(d.getDate() + i);
    arr.push(d.toISOString().slice(0, 10));
  }
  return arr;
}
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ── supabase ─────────────────────────────────────────────────────────
const db = window.supabase.createClient(window.CP_CONFIG.supabaseUrl, window.CP_CONFIG.supabaseAnonKey);
let currentUser = null;
let realtimeChannel = null;

function defaultTagColors() {
  return { todo: "butter", tax: "sage", jackson: "peri", design: "lilac", respond: "rose", diary: "sage", loose: "lilac", link: "cyan", habit: "sage" };
}
function toDbRow(e) {
  return {
    id: e.id, user_id: currentUser.id, created_at: e.createdAt, type: e.type,
    title: e.title, body: e.body, tags: e.tags, due_at: e.dueAt,
    done: e.done, done_at: e.doneAt, pinned: e.pinned, source: e.source,
    weekly_target: e.weeklyTarget ?? null, checkins: e.checkins ?? null,
    box_id: e.boxId ?? null, image_url: e.imageUrl ?? null, drawing: e.drawing ?? null,
    font: e.font ?? null, underline: e.underline ?? false, highlight: e.highlight ?? false,
    in_progress: e.inProgress ?? false,
  };
}
function fromDbRow(r) {
  const e = {
    id: r.id, createdAt: r.created_at, type: r.type, title: r.title || "", body: r.body || "",
    tags: r.tags || [], dueAt: r.due_at, done: r.done, doneAt: r.done_at, pinned: r.pinned,
    boxId: r.box_id || null, imageUrl: r.image_url || null, drawing: r.drawing || null,
    font: r.font || null, underline: !!r.underline, highlight: !!r.highlight,
    inProgress: !!r.in_progress,
    source: r.source || "manual",
  };
  if (r.weekly_target != null) e.weeklyTarget = r.weekly_target;
  if (r.checkins != null) e.checkins = r.checkins;
  return e;
}

let tagColors = defaultTagColors();
let customViews = [];
let taskBoxes = [];
let cachedNavOrder = [];
let cachedBoardOrder = [];
let pushSettingsTimer = null;
function pushSettings() {
  clearTimeout(pushSettingsTimer);
  pushSettingsTimer = setTimeout(() => {
    if (!currentUser) return;
    db.from("settings").upsert({
      user_id: currentUser.id,
      tag_colors: tagColors,
      views: customViews,
      nav_order: cachedNavOrder,
      board_order: cachedBoardOrder,
      task_boxes: taskBoxes,
    }).then(({ error }) => { if (error) console.error("settings save failed", error); });
  }, 400);
}
function saveTagColors(map) { tagColors = map; pushSettings(); }
function saveViews(v) { customViews = v; pushSettings(); }
function saveTaskBoxes(v) { taskBoxes = v; pushSettings(); }
function loadNavOrder() { return cachedNavOrder; }
function saveNavOrder(order) { cachedNavOrder = order; pushSettings(); }
function loadBoardOrder() { return cachedBoardOrder; }
function saveBoardOrder(order) { cachedBoardOrder = order; pushSettings(); }
function colorFor(tag) {
  if (tagColors[tag]) return tagColors[tag];
  const used = Object.values(tagColors);
  const next = COLOR_ROTATION.find((c) => !used.includes(c)) || COLOR_ROTATION[used.length % COLOR_ROTATION.length];
  tagColors[tag] = next;
  saveTagColors(tagColors);
  return next;
}

let idCounter = Date.now();
function newId() {
  return "e" + (idCounter++);
}
let entries = [];
let activeTag = null;
let searchQuery = "";

function addEntry(partial) {
  const e = Object.assign({
    id: newId(),
    createdAt: new Date().toISOString(),
    type: "note",
    title: "",
    body: "",
    tags: [],
    dueAt: null,
    done: false,
    doneAt: null,
    pinned: false,
    source: "manual",
  }, partial);
  entries.unshift(e);
  db.from("entries").insert(toDbRow(e)).then(({ error }) => { if (error) console.error("insert failed", error); });
  return e;
}
function toggleDone(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  e.done = !e.done;
  e.doneAt = e.done ? new Date().toISOString() : null;
  render();
  db.from("entries").update({ done: e.done, done_at: e.doneAt }).eq("id", id).then(({ error }) => { if (error) console.error("update failed", error); });
}
// Tasks specifically get a third state — not started -> in progress -> done -> back to not
// started — cycled by clicking the same checkbox, rather than a separate control. "In progress"
// tints the checkbox and gives the text a highlight-style wash (a distinct blue, not the same
// yellow as the manual highlighter, so the two don't read as the same thing).
function cycleTaskStatus(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  if (!e.done && !e.inProgress) {
    e.inProgress = true;
  } else if (e.inProgress) {
    e.inProgress = false; e.done = true; e.doneAt = new Date().toISOString();
  } else {
    e.done = false; e.doneAt = null; e.inProgress = false;
  }
  render();
  db.from("entries").update({ in_progress: e.inProgress, done: e.done, done_at: e.doneAt }).eq("id", id).then(({ error }) => { if (error) console.error("update failed", error); });
}
function toggleHabitCheckin(id) {
  toggleHabitCheckinDate(id, todayIso());
}
// Same as toggleHabitCheckin but for an arbitrary day — the star chart lets you tap any cell in
// the week, not just today (catching up a missed day, or undoing one).
function toggleHabitCheckinDate(id, iso) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  e.checkins = e.checkins || [];
  const i = e.checkins.indexOf(iso);
  if (i >= 0) e.checkins.splice(i, 1);
  else e.checkins.push(iso);
  render();
  db.from("entries").update({ checkins: e.checkins }).eq("id", id).then(({ error }) => { if (error) console.error("update failed", error); });
}
function deleteEntry(id) {
  entries = entries.filter((e) => e.id !== id);
  render();
  db.from("entries").delete().eq("id", id).then(({ error }) => { if (error) console.error("delete failed", error); });
}
function updateTaskDetail(id, detail) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  e.title = detail;
  expandedTaskIds.delete(id);
  render();
  db.from("entries").update({ title: e.title }).eq("id", id).then(({ error }) => { if (error) console.error("update failed", error); });
}

// A sketch autosaves after every completed stroke (not on blur, since a canvas has no blur) —
// deliberately does NOT call render(), so the live canvas element isn't torn down and rebuilt
// mid-drawing-session; see anySketchEditingOpen() for the matching realtime-render guard.
const drawingSaveTimers = {};
function updateEntryDrawing(id, drawing) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  e.drawing = drawing;
  clearTimeout(drawingSaveTimers[id]);
  drawingSaveTimers[id] = setTimeout(() => {
    db.from("entries").update({ drawing: e.drawing }).eq("id", id).then(({ error }) => { if (error) console.error("update failed", error); });
  }, 500);
}

// ── task boxes (mood-board Tasks tab) ─────────────────────────────────
const UNSORTED_BOX = "_unsorted";
let expandedTaskIds = new Set();
// Drawing now always happens in the full-screen #sketchOverlay (see openSketchOverlay below),
// never inline in a card, so there's only ever at most one entry being sketched at a time.
let sketchOverlayEntryId = null;
let sketchOverlayCtl = null;
function anySketchEditingOpen() {
  return sketchOverlayEntryId !== null;
}
function addTaskBox() {
  const title = prompt("New box name:");
  if (!title || !title.trim()) return;
  taskBoxes.push({ id: "box-" + newId(), title: title.trim() });
  saveTaskBoxes(taskBoxes);
  render();
}
function deleteTaskBox(id) {
  taskBoxes = taskBoxes.filter((b) => b.id !== id);
  saveTaskBoxes(taskBoxes);
  entries.filter((e) => e.boxId === id).forEach((e) => {
    e.boxId = null;
    db.from("entries").update({ box_id: null }).eq("id", e.id).then(({ error }) => { if (error) console.error("update failed", error); });
  });
  render();
}

// ── auth / boot data flow ────────────────────────────────────────────
async function loadAllFromServer() {
  const { data: rows, error: entriesErr } = await db.from("entries").select("*").eq("user_id", currentUser.id);
  if (entriesErr) console.error("load entries failed", entriesErr);
  entries = (rows || []).map(fromDbRow);

  const { data: settingsRow, error: settingsErr } = await db.from("settings").select("*").eq("user_id", currentUser.id).maybeSingle();
  if (settingsErr) console.error("load settings failed", settingsErr);
  tagColors = (settingsRow && settingsRow.tag_colors && Object.keys(settingsRow.tag_colors).length) ? settingsRow.tag_colors : defaultTagColors();
  customViews = (settingsRow && settingsRow.views) || [];
  taskBoxes = (settingsRow && settingsRow.task_boxes) || [];
  cachedNavOrder = (settingsRow && settingsRow.nav_order) || [];
  cachedBoardOrder = (settingsRow && settingsRow.board_order) || [];
  if (!settingsRow) pushSettings();
}
function subscribeRealtime() {
  if (realtimeChannel) db.removeChannel(realtimeChannel);
  realtimeChannel = db
    .channel("entries-" + currentUser.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "entries", filter: `user_id=eq.${currentUser.id}` }, async () => {
      const { data: rows } = await db.from("entries").select("*").eq("user_id", currentUser.id);
      entries = (rows || []).map(fromDbRow);
      // Our own drawing autosaves land here too (they're just more writes to this table) — skip
      // the rebuild while a sketch canvas is open so it doesn't get torn down mid-stroke every
      // ~500ms. entries[] is still kept fresh; the final ink shows once editing is closed.
      if (!anySketchEditingOpen()) render();
    })
    .subscribe();
}
async function onAuthed(user) {
  currentUser = user;
  document.getElementById("authgate").classList.add("hidden");
  document.getElementById("signoutBtn").style.display = "block";
  await loadAllFromServer();
  render();
  subscribeRealtime();
}
function showLogin() {
  currentUser = null;
  document.getElementById("authgate").classList.remove("hidden");
  document.getElementById("signoutBtn").style.display = "none";
}

// ── tag helpers ──────────────────────────────────────────────────────
function allTags() {
  const set = new Set();
  entries.forEach((e) => e.tags.forEach((t) => set.add(t)));
  Object.keys(tagColors).forEach((t) => set.add(t));
  return Array.from(set);
}
function tagSpan(tag) {
  return `<span class="tag ${colorFor(tag)}" data-tag="${escapeHtml(tag)}">#${escapeHtml(tag)}</span>`;
}
// Same parsing as the capture modal's tag field (space/comma-separated, # stripped, lowercased)
// so typing "family, trip" in one go adds both — not just a single tag per prompt.
function addTagsToEntry(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  const input = prompt("Add tag(s) — separate with spaces or commas:");
  if (!input || !input.trim()) return;
  const newTags = input.split(/[\s,]+/).map((t) => t.replace(/^#/, "").toLowerCase()).filter(Boolean);
  const before = e.tags.length;
  newTags.forEach((t) => { if (!e.tags.includes(t)) e.tags.push(t); });
  if (e.tags.length === before) return;
  render();
  db.from("entries").update({ tags: e.tags }).eq("id", id).then(({ error }) => { if (error) console.error("update failed", error); });
}
function wireAddTag(card) {
  card.querySelectorAll("[data-addtag]").forEach((x) => x.addEventListener("click", (ev) => {
    ev.stopPropagation();
    addTagsToEntry(x.dataset.addtag);
  }));
}

// ── text font choice (notes, scratchpad) ──────────────────────────────
// A small curated set rather than every Google Font under the sun — "default" is the app's own
// monospace voice, "klee" is a free stand-in for a paid handwritten-serif font she wanted (see
// CLAUDE.md), the other two are fonts already loaded elsewhere in the app so picking them costs
// nothing extra.
const NOTE_FONTS = ["default", "klee", "newsreader", "caveat"];
const NOTE_FONT_CSS = {
  default: "", klee: "'Klee One', serif", newsreader: "'Newsreader', serif", caveat: "'Caveat', cursive",
};
function noteFontOf(e) {
  return (e.font && NOTE_FONTS.includes(e.font)) ? e.font : "default";
}
function noteFontStyle(e) {
  const css = NOTE_FONT_CSS[noteFontOf(e)];
  return css ? ` style="font-family:${css}"` : "";
}
function cycleNoteFont(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  const next = NOTE_FONTS[(NOTE_FONTS.indexOf(noteFontOf(e)) + 1) % NOTE_FONTS.length];
  e.font = next;
  render();
  db.from("entries").update({ font: e.font }).eq("id", id).then(({ error }) => { if (error) console.error("update failed", error); });
}
function wireFontToggle(card) {
  card.querySelectorAll("[data-fonttoggle]").forEach((x) => x.addEventListener("click", (ev) => {
    ev.stopPropagation();
    cycleNoteFont(x.dataset.fonttoggle);
  }));
}

// ── task text decorations (underline / highlight) ─────────────────────
function taskTextStyle(e) {
  const parts = [];
  if (e.underline) parts.push("text-decoration-line:underline;text-decoration-style:wavy;text-decoration-color:var(--rose);text-decoration-thickness:2px;text-underline-offset:2px;");
  if (e.highlight) parts.push("background-image:linear-gradient(rgba(245,226,122,.6),rgba(245,226,122,.6));background-repeat:no-repeat;background-size:100% 55%;background-position:0 68%;");
  return parts.length ? ` style="${parts.join("")}"` : "";
}
function toggleTaskDecoration(id, key) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  e[key] = !e[key];
  render();
  db.from("entries").update({ [key]: e[key] }).eq("id", id).then(({ error }) => { if (error) console.error("update failed", error); });
}
function wireTaskDecorations(card) {
  card.querySelectorAll("[data-underline]").forEach((x) => x.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleTaskDecoration(x.dataset.underline, "underline");
  }));
  card.querySelectorAll("[data-highlight]").forEach((x) => x.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleTaskDecoration(x.dataset.highlight, "highlight");
  }));
}
function matchesFilter(e) {
  if (activeTag && !e.tags.includes(activeTag)) return false;
  if (searchQuery) {
    const hay = (e.title + " " + e.body + " " + e.tags.join(" ")).toLowerCase();
    if (!hay.includes(searchQuery)) return false;
  }
  return true;
}

// ── rendering: chips ─────────────────────────────────────────────────
function renderChips() {
  const el = document.getElementById("chips");
  el.innerHTML = "";
  allTags().forEach((tag) => {
    const c = colorFor(tag);
    const btn = document.createElement("button");
    btn.className = "chip " + c + (activeTag === tag ? " active" : "");
    btn.textContent = "#" + tag;
    btn.addEventListener("click", () => {
      activeTag = activeTag === tag ? null : tag;
      render();
    });
    el.appendChild(btn);
  });
  const addBtn = document.createElement("button");
  addBtn.className = "chip addtag";
  addBtn.textContent = "+ tag";
  addBtn.addEventListener("click", () => {
    const t = prompt("New tag name (no #):");
    if (t && t.trim()) {
      colorFor(t.trim().toLowerCase().replace(/\s+/g, "-"));
      render();
    }
  });
  el.appendChild(addBtn);
}

// ── rendering: week strip ───────────────────────────────────────────
function renderWeekStrip() {
  const el = document.getElementById("week-strip");
  el.innerHTML = "";
  el.style.display = activeNavId === "everything" ? "" : "none";
  if (activeNavId !== "everything") return;
  const today = todayStart();
  const dow = (today.getDay() + 6) % 7; // 0=Mon
  const monday = new Date(today);
  monday.setDate(monday.getDate() - dow);
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const isToday = daysBetween(today, d) === 0;
    const dayEl = document.createElement("div");
    dayEl.className = "ws-day" + (isToday ? " today" : "");
    const items = entries
      .filter((e) => e.dueAt === iso && !e.done)
      .slice(0, 2);
    dayEl.innerHTML =
      `<div class="wsh"><span class="n">${d.getDate()}</span><span class="nm">${names[i]}</span></div>` +
      items.map((e) => {
        const c = colorFor(e.tags[0] || "todo");
        const label = e.title || e.body;
        return `<div class="ws-item"><span class="bu ${c}">·</span> ${escapeHtml(label)}</div>`;
      }).join("");
    el.appendChild(dayEl);
  }
}

// ── mood check-in ("today's vibe") ──────────────────────────────────
// A dedicated entry type, one per calendar day, keyed off createdAt (not dueAt — a mood didn't
// come "due", it just happened that day, same reasoning as diary entries). Keeping it off dueAt
// also matters mechanically: renderWeekView() and calendarCard() both key off e.dueAt for any
// entry type, so a mood row with a dueAt would show up there as a stray due-date block.
const MOODS = [
  { id: "glowing", label: "Glowing", color: "butter" },
  { id: "steady", label: "Steady", color: "sage" },
  { id: "soft", label: "Soft", color: "cyan" },
  { id: "cozy", label: "Cozy", color: "lilac" },
  { id: "sleepy", label: "Sleepy", color: "peri" },
  { id: "foggy", label: "Foggy", color: "grey" },
  { id: "flat", label: "Flat", color: "peri" },
  { id: "heavy", label: "Heavy", color: "grey" },
  { id: "wired", label: "Wired", color: "rust" },
  { id: "spiraling", label: "Spiraling", color: "rose" },
  { id: "simmering", label: "Simmering", color: "rust" },
  { id: "overflowing", label: "Overflowing", color: "peri" },
];
// Small hand-drawn glyphs (viewBox 0 0 64 64) — inner markup only, wrapped by moodIconSvg().
const MOOD_ICON_PATHS = {
  glowing: `<circle cx="32" cy="33" r="8" /><path d="M32 16 L33 6"/><path d="M32 50 L31 59"/><path d="M16 33 L6 32"/><path d="M50 32 L60 33"/><path d="M21 22 L13 14"/><path d="M44 44 L52 51"/><path d="M44 22 L51 14"/><path d="M21 44 L13 52"/>`,
  steady: `<path d="M10 46 L26 18 L34 32 L42 14 L56 46 Z" />`,
  soft: `<path d="M14 38 C10 28 20 20 28 24 C32 14 46 16 48 26 C58 26 58 40 48 40 C46 46 34 48 30 42 C22 46 12 44 14 38 Z" />`,
  cozy: `<path d="M16 28 L16 46 C16 52 40 52 40 46 L40 28 Z" /><path d="M40 32 C48 32 48 42 40 42" /><path d="M22 22 C20 16 26 16 24 10" />`,
  sleepy: `<path d="M42 12 C30 12 21 22 21 34 C21 46 30 54 40 54 C33 49 28 42 28 33 C28 23 34 15 42 12 Z" /><path d="M46 16 L55 16 L46 25 L55 25" />`,
  foggy: `<path d="M8 22 Q16 16 24 22 T40 22 T56 22" /><path d="M12 34 Q20 28 28 34 T44 34 T58 34" /><path d="M8 46 Q16 40 24 46 T40 46 T56 46" />`,
  flat: `<path d="M12 32 Q22 30 32 32 T52 33" />`,
  heavy: `<path d="M10 20 Q32 26 54 20" /><path d="M32 26 L32 40" /><circle cx="32" cy="46" r="6" />`,
  wired: `<path d="M6 32 L16 32 L20 18 L26 46 L32 24 L36 32 L58 32" />`,
  spiraling: `<path d="M34,30 L34.6,32.6 L32,35.4 L27,35 L23.2,30 L24.6,22.6 L32,17.8 L41.8,20.2 L47.6,30 L44.2,42.2 L32,49 L17.4,44.6 L9.6,30 L15,13" />`,
  simmering: `<path d="M14 36 L50 36 L46 48 L18 48 Z" /><path d="M22 30 Q19 24 23 20 Q26 16 22 10" /><path d="M32 30 Q35 22 31 18 Q28 14 33 8" /><path d="M42 30 Q39 24 43 20 Q46 16 42 10" />`,
  overflowing: `<path d="M20 22 L23 50 L41 50 L44 22" /><path d="M20 22 Q26 18 32 22 T44 22" /><path d="M13 30 L11 37" /><path d="M51 28 L53 35" />`,
};
function moodIconSvg(id, cls) {
  return `<svg class="${cls || ""}" viewBox="0 0 64 64">${MOOD_ICON_PATHS[id] || ""}</svg>`;
}
function todayMoodEntry() {
  const today = todayIso();
  return entries.find((e) => e.type === "mood" && (e.createdAt || "").slice(0, 10) === today);
}
let moodPickerOpen = false;
let moodMonthOpen = false;
function setTodayMood(id) {
  const existing = todayMoodEntry();
  if (existing) {
    existing.title = id;
    db.from("entries").update({ title: id }).eq("id", existing.id).then(({ error }) => { if (error) console.error("update failed", error); });
  } else {
    addEntry({ type: "mood", title: id });
  }
  moodPickerOpen = false;
  render();
}
function moodHistoryStrip() {
  const dayLetters = ["S", "M", "T", "W", "T", "F", "S"];
  const today = todayStart();
  const cells = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const found = entries.find((e) => e.type === "mood" && (e.createdAt || "").slice(0, 10) === iso);
    const mood = found && MOODS.find((m) => m.id === found.title);
    cells.push(`<div class="mood-hist-day"><span class="mood-dot${mood ? " " + mood.color : ""}" title="${mood ? mood.label : "no check-in"}"></span><span class="mood-hist-letter">${dayLetters[d.getDay()]}</span></div>`);
  }
  return `<div class="mood-history">${cells.join("")}</div>`;
}
// Same day-grid math as calendarCard() (current month only, no prev/next yet — matches that
// card's existing limits), but each day's dot is colored by that day's mood instead of a due date,
// plus a frequency breakdown underneath so a month of check-ins reads as actual data, not just a
// week of dots.
function moodMonthGrid() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const monthName = now.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const byDay = {};
  entries.forEach((e) => {
    if (e.type !== "mood") return;
    const mood = MOODS.find((mm) => mm.id === e.title);
    if (mood) byDay[(e.createdAt || "").slice(0, 10)] = mood;
  });

  let cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = new Date(y, m, d).toISOString().slice(0, 10);
    cells.push({ d, mood: byDay[iso] });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  let rows = "";
  for (let i = 0; i < cells.length; i += 7) {
    rows += "<tr>" + cells.slice(i, i + 7).map((c) =>
      c ? `<td>${c.d}${c.mood ? `<div class="dot ${c.mood.color}" title="${c.mood.label}"></div>` : ""}</td>` : "<td></td>"
    ).join("") + "</tr>";
  }

  const counts = {};
  Object.values(byDay).forEach((mood) => { counts[mood.id] = (counts[mood.id] || 0) + 1; });
  const freq = MOODS.map((m) => ({ ...m, count: counts[m.id] || 0 })).filter((m) => m.count > 0).sort((a, b) => b.count - a.count);
  const maxCount = freq.length ? freq[0].count : 1;
  const freqHtml = freq.length
    ? `<div class="mood-freq">${freq.map((m) =>
        `<div class="mood-freq-row"><span class="mood-freq-icon ${m.color}">${moodIconSvg(m.id)}</span>` +
        `<span class="mood-freq-label">${m.label}</span>` +
        `<span class="mood-freq-bar-wrap"><span class="mood-freq-bar ${m.color}" style="width:${Math.round((m.count / maxCount) * 100)}%"></span></span>` +
        `<span class="mood-freq-count">${m.count}</span></div>`
      ).join("")}</div>`
    : `<p class="mood-freq-empty">No check-ins yet this month.</p>`;

  return `<div class="mood-month">` +
    `<div class="mood-month-head">${monthName}</div>` +
    `<table class="cal"><tr><th>M</th><th>T</th><th>W</th><th>T</th><th>F</th><th>S</th><th>S</th></tr>${rows}</table>` +
    freqHtml +
    `</div>`;
}
function moodCard() {
  const card = makeCard("mood-card widget wide");
  const todayEntry = todayMoodEntry();
  const todayMood = todayEntry && MOODS.find((m) => m.id === todayEntry.title);
  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  let body;
  if (todayMood && !moodPickerOpen) {
    body =
      `<div class="mood-today" data-mood-change>` +
      `<div class="mood-today-icon ${todayMood.color}">${moodIconSvg(todayMood.id)}</div>` +
      `<div class="mood-today-label">${todayMood.label}</div>` +
      `</div>` +
      `<button type="button" class="sketch-btn mood-change-btn" data-mood-change>change</button>`;
  } else {
    body = `<div class="mood-grid">` + MOODS.map((m) =>
      `<button type="button" class="mood-btn ${m.color}${todayMood && todayMood.id === m.id ? " active" : ""}" data-mood-pick="${m.id}">` +
      moodIconSvg(m.id) +
      `<span class="mood-btn-label">${m.label}</span></button>`
    ).join("") + `</div>`;
  }
  card.innerHTML =
    `<div class="meta"><span>Today's vibe</span><span class="tags"><span class="mood-date">${dateStr}</span></span></div>` +
    body +
    moodHistoryStrip() +
    `<button type="button" class="sketch-btn mood-toggle-month" data-mood-toggle-month>${moodMonthOpen ? "hide month" : "view month ↓"}</button>` +
    (moodMonthOpen ? moodMonthGrid() : "");
  card.querySelectorAll("[data-mood-pick]").forEach((btn) => btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setTodayMood(btn.dataset.moodPick);
  }));
  card.querySelectorAll("[data-mood-change]").forEach((el) => el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    moodPickerOpen = true;
    render();
  }));
  card.querySelectorAll("[data-mood-toggle-month]").forEach((el) => el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    moodMonthOpen = !moodMonthOpen;
    render();
  }));
  return card;
}

// ── rendering: coming up widget ─────────────────────────────────────
function comingUpCard() {
  const now = new Date();
  const upcoming = entries
    .filter((e) => e.type === "event" && e.dueAt && !e.done)
    .filter((e) => new Date(e.dueAt + "T23:59:59") >= now)
    .sort((a, b) => (a.dueAt + (a.createdAt || "")).localeCompare(b.dueAt + (b.createdAt || "")));

  const card = document.createElement("div");
  card.className = "card widget";
  if (!upcoming.length) {
    card.innerHTML = `<div class="cu-label">Coming up</div><div class="cu-empty">Nothing scheduled — capture an event to see it here.</div>`;
    return card;
  }
  const next = upcoming[0];
  const then = upcoming[1];
  const diffMs = new Date(next.dueAt + "T00:00:00") - now;
  const isToday = next.dueAt === now.toISOString().slice(0, 10);
  const whenText = isToday ? "today" : fmtDue(next).text || next.dueAt;
  card.innerHTML =
    `<div class="cu-label">Coming up</div>` +
    `<div class="cu-ev">${escapeHtml(next.title || next.body)}</div>` +
    `<div class="cu-time">${whenText.toUpperCase()}</div>` +
    (then ? `<div class="cu-then">then: ${escapeHtml(then.title || then.body)}</div>` : "");
  return card;
}

// ── rendering: card builders ────────────────────────────────────────
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function rowHtml(e, opts) {
  opts = opts || {};
  const due = fmtDue(e);
  let end = "";
  if (opts.nag) {
    end = e.done ? "" : `<span class="nag">${fmtNag(e)}</span>`;
  } else if (due) {
    end = `<span class="${due.cls}">${due.text}</span>`;
  }
  const dot = opts.showDot ? `<span class="srcdot ${colorFor(e.tags[0] || "todo")}"></span>` : "";
  const label = e.type === "task"
    ? escapeHtml(e.body)
    : (opts.bold && e.title ? `<b>${escapeHtml(e.title)}</b> — ${escapeHtml(e.body)}` : escapeHtml(e.title || e.body));
  return `<div class="row${e.done ? " done" : ""}" data-id="${e.id}">
      <div class="box"></div>${dot}<span class="txt">${label}</span>
      <span class="end">${end}<span class="del" data-del="${e.id}" title="delete">✕</span></span>
    </div>`;
}

function makeCard(className) {
  const div = document.createElement("div");
  div.className = "card " + className;
  return div;
}

function addRowHtml(label) {
  return `<button type="button" class="addrow"><span class="plus">+</span> ${label}</button>`;
}

function bigListCard() {
  const items = entries.filter((e) => (e.type === "todo" || e.type === "reply") && matchesFilter(e))
    .sort((a, b) => (a.done - b.done) || (a.dueAt || "9999").localeCompare(b.dueAt || "9999"));
  if (!items.length && (activeTag || searchQuery)) return null;
  const card = makeCard("butter wide pin");
  card.innerHTML =
    `<div class="meta"><span>The Big List</span><span class="tags"><span class="tag butter">everything open</span></span></div>` +
    items.map((e) => rowHtml(e, { showDot: true })).join("") +
    addRowHtml("add to the big list…");
  wireCardInteractions(card, { type: "todo", tags: ["todo"] });
  return card;
}

function taskListCard() {
  const items = entries.filter((e) => e.type === "task" && matchesFilter(e))
    .sort((a, b) => a.done - b.done);
  if (!items.length && (activeTag || searchQuery)) return null;
  const card = makeCard("");
  card.innerHTML =
    `<div class="meta"><span>Tasks</span><span class="tags">${tagSpan("task")}</span></div>` +
    items.map((e) => rowHtml(e)).join("") +
    addRowHtml("add a task…");
  wireCardInteractions(card, { type: "task", tags: ["task"] });
  return card;
}

function hasTaskDetail(e) {
  return !!(e.title && e.title.trim()) || hasInk(e);
}
function taskRowHtml(e) {
  const due = fmtDue(e);
  const end = due ? `<span class="${due.cls}">${due.text}</span>` : "";
  const expanded = expandedTaskIds.has(e.id);
  return `<div class="taskrow">
      <div class="row${e.done ? " done" : ""}${e.inProgress ? " in-progress" : ""}" data-id="${e.id}">
        <div class="box"></div><span class="txt" data-detail-toggle="${e.id}"${taskTextStyle(e)}>${escapeHtml(e.body)}</span>
        <span class="end">${end}<span class="del" data-del="${e.id}" title="delete">✕</span></span>
      </div>
      ${expanded ? `<div class="task-detail"><textarea data-detail-input="${e.id}" placeholder="add a note — saving pulls this task onto its own card…">${escapeHtml(e.title || "")}</textarea></div>` : ""}
    </div>`;
}

function bulletListHtml(text) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return `<p class="postit-empty">click to jot bullet points…</p>`;
  return `<ul class="postit-bullets">` + lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("") + `</ul>`;
}
function taskDetailCard(e) {
  const editing = expandedTaskIds.has(e.id);
  // A task whose only content is ink (no bullet text yet) stays in its drawing view regardless
  // of expand/collapse — there's no textarea to fall back to, and drawing itself now always
  // happens in the full-screen overlay, never inline here.
  const preferSketch = hasInk(e) && !(e.title && e.title.trim());
  // A sketched task's whole card is paper too — same reasoning as diary, no box-behind-paper.
  const card = makeCard(hasInk(e) ? `sketch-card ${paperClassOf(e.drawing)}` : "postit");
  let detail;
  if (preferSketch) {
    detail = `<div class="postit-bullets-wrap" data-open-sketch="${e.id}">${renderStaticImage(e.drawing, "sketch-view", sketchCanvasHeight(e.type, e.drawing))}</div>`;
  } else if (editing) {
    detail = `<textarea class="postit-editor" data-detail-input="${e.id}" placeholder="– one point per line…">${escapeHtml(e.title || "")}</textarea>
      <button type="button" class="sketch-btn mode-switch" data-open-sketch="${e.id}">✎ draw instead</button>`;
  } else {
    detail = `<div class="postit-bullets-wrap" data-detail-toggle="${e.id}">${bulletListHtml(e.title)}</div>`;
  }
  card.innerHTML =
    `<div class="meta"><span>Task</span><span class="tags">${e.tags.map((t) => tagSpan(t)).join(" ")}` +
    `<span class="boxclose${e.underline ? " active" : ""}" data-underline="${e.id}" title="underline">U</span>` +
    `<span class="boxclose${e.highlight ? " active" : ""}" data-highlight="${e.id}" title="highlight">H</span>` +
    `<span class="boxclose" data-addtag="${e.id}" title="add tag">+</span>` +
    `<span class="boxclose" data-del="${e.id}" title="delete">✕</span></span></div>` +
    `<div class="row${e.done ? " done" : ""}${e.inProgress ? " in-progress" : ""}" data-id="${e.id}"><div class="box"></div><span class="txt"${taskTextStyle(e)}>${escapeHtml(e.body)}</span></div>` +
    detail;
  wireRows(card);
  wireTaskDetailInputs(card);
  wireAddTag(card);
  wireTaskDecorations(card);
  card.querySelectorAll("[data-detail-toggle]").forEach((el) => el.addEventListener("click", () => {
    expandedTaskIds.add(e.id);
    render();
  }));
  card.querySelectorAll("[data-open-sketch]").forEach((el) => el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!e.drawing) e.drawing = { w: 0, h: 0, strokes: [], ...randomDrawingMeta() };
    openSketchOverlay(e);
  }));
  const ta = card.querySelector("textarea[data-detail-input]");
  if (ta) requestAnimationFrame(() => ta.focus());
  return card;
}

function taskBoxCard(box, index) {
  const isUnsorted = box.id === UNSORTED_BOX;
  const items = entries.filter((e) => e.type === "task" && !hasTaskDetail(e) && matchesFilter(e) && (isUnsorted ? !e.boxId : e.boxId === box.id))
    .sort((a, b) => a.done - b.done);
  if (!items.length && (isUnsorted || activeTag || searchQuery)) return null;
  const tints = ["", "butter", "sage", "lilac", "peri"];
  const card = makeCard(tints[index % tints.length]);
  const closeBtn = isUnsorted ? "" : `<span class="boxclose" data-delbox="${box.id}" title="delete box">✕</span>`;
  card.innerHTML =
    `<div class="meta"><span>${escapeHtml(box.title)}</span>${closeBtn}</div>` +
    items.map((e) => taskRowHtml(e)).join("") +
    addRowHtml("add…");
  wireRows(card);
  wireTaskDetailInputs(card);
  wireAddRow(card, { type: "task", tags: ["task"], boxId: isUnsorted ? null : box.id });
  card.querySelectorAll("[data-delbox]").forEach((x) => x.addEventListener("click", (ev) => {
    ev.stopPropagation();
    deleteTaskBox(x.dataset.delbox);
  }));
  return card;
}

function owedReplyCard() {
  const items = entries.filter((e) => e.type === "reply" && matchesFilter(e))
    .sort((a, b) => a.done - b.done);
  if (!items.length && (activeTag || searchQuery)) return null;
  const card = makeCard("postit");
  card.innerHTML =
    `<div class="meta"><span>Owe a reply</span><span class="tags">${tagSpan("respond")}</span></div>` +
    items.map((e) => rowHtml(e, { nag: true, bold: true })).join("") +
    addRowHtml("add…");
  wireCardInteractions(card, { type: "reply", tags: ["respond"] });
  return card;
}

function scratchCard() {
  const items = entries.filter((e) => e.type === "scratch" && matchesFilter(e));
  if (!items.length && (activeTag || searchQuery)) return null;
  const card = makeCard("taped");
  card.innerHTML =
    `<div class="meta"><span>Scratchpad</span><span class="tags">${tagSpan("loose")}</span></div>` +
    `<div class="scribble">` +
    items.map((e) => {
      const fontCss = NOTE_FONT_CSS[noteFontOf(e)];
      const style = `cursor:pointer;${e.done ? "text-decoration:line-through;color:var(--soft);" : ""}${fontCss ? `font-family:${fontCss};` : ""}`;
      return `<span class="scratch-row"><span class="scratch-line${e.done ? " strike" : ""}" data-id="${e.id}" style="${style}">${escapeHtml(e.body)}</span>` +
        `<span class="boxclose" data-fonttoggle="${e.id}" title="change font (${noteFontOf(e)})">Aa</span></span>`;
    }).join("<br>") +
    `</div>` +
    addRowHtml("jot something…");
  card.querySelectorAll(".scratch-line").forEach((line) => {
    line.addEventListener("click", () => toggleDone(line.dataset.id));
  });
  wireFontToggle(card);
  wireAddRow(card, { type: "scratch", tags: ["loose"] });
  return card;
}

function diaryCards() {
  return entries.filter((e) => e.type === "diary" && matchesFilter(e)).map((e) => {
    const date = new Date(e.createdAt);
    const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " + date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    // A sketch's whole card IS the paper — date/tags sit directly on it, no card-behind-paper box.
    // Drawing itself always happens in the full-screen #sketchOverlay, never inline in this card.
    const card = makeCard("diary" + (hasInk(e) ? ` sketch-card ${paperClassOf(e.drawing)}` : ""));
    card.dataset.entryId = e.id;
    const body = hasInk(e) ? renderStaticImage(e.drawing, "sketch-view", sketchCanvasHeight(e.type, e.drawing)) : `<p>${escapeHtml(e.body)}</p>`;
    card.innerHTML =
      `<div class="meta"><span>${dateStr}</span><span class="tags">${e.tags.map((t) => tagSpan(t)).join(" ")}` +
      `<span class="boxclose" data-addtag="${e.id}" title="add tag">+</span>` +
      (isTouchCapable ? `<span class="boxclose" data-open-sketch="${e.id}" title="draw">✎</span>` : "") +
      `<span class="boxclose" data-del="${e.id}" title="delete">✕</span></span></div>` +
      (e.title ? `<h2>${escapeHtml(e.title)}</h2>` : "") +
      body;
    card.querySelectorAll("[data-del]").forEach((x) => x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteEntry(x.dataset.del);
    }));
    wireAddTag(card);
    card.querySelectorAll("[data-open-sketch]").forEach((x) => x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!e.drawing) e.drawing = { w: 0, h: 0, strokes: [], ...randomDrawingMeta() };
      openSketchOverlay(e);
    }));
    return card;
  });
}

// ── handwriting (Apple Pencil / touch ink, via perfect-freehand) ─────
// Loaded as a dynamic import (works fine from a plain script, no <script type=module> needed).
// Until it resolves, strokes fall back to a plain thin polyline so drawing still works.
let getStroke = null;
import("https://esm.sh/perfect-freehand").then((m) => { getStroke = m.default; }).catch((err) => console.error("perfect-freehand failed to load", err));

const INK_COLOR = (getComputedStyle(document.documentElement).getPropertyValue("--ink") || "#28231C").trim() || "#28231C";

// Three real Procreate pens, approximated from the actual numeric settings inside the .brush
// files she sent (they're zip archives with a readable parameter plist — not guesses). size/
// thinning drive perfect-freehand's outline (thinning = how much pressure narrows the stroke,
// derived from each brush's minSize/maxSize ratio); minAlpha/maxAlpha interpolate by the
// stroke's average pressure (Bellerive's opacity visibly builds with pressure in the original;
// Sanderling/Liffey stay fully opaque regardless of pressure); grain is how strongly the shared
// paper-grain texture multiplies over the fill (0 = none), matching each brush's grainDepth.
// Highlighter is a fourth preset, from the watercolor-calligraphy brush she sent as a starting
// point: same underlying stroke engine, but wide, flat opacity (she asked for 50% specifically,
// not pressure-varying like the pens above), and blended with "multiply" instead of drawn
// solid — so it tints whatever it crosses (lined paper, other ink) rather than covering it.
const PEN_PRESETS = {
  sanderling: { label: "Sanderling", size: 7, thinning: 0.85, minAlpha: 1, maxAlpha: 1, grain: 0.18 },
  bellerive: { label: "Bellerive", size: 6, thinning: 0.92, minAlpha: 0.55, maxAlpha: 1, grain: 0.4 },
  liffey: { label: "Liffey", size: 15, thinning: 0.85, minAlpha: 1, maxAlpha: 1, grain: 0.48 },
  // No grain — it's a wide, mostly-transparent wash, and the same speckle texture that reads as
  // "paper grain" on a thin ink line just looked like grit smeared across a big soft area.
  highlighter: { label: "Highlighter", size: 26, thinning: 0.25, minAlpha: 0.5, maxAlpha: 0.5, grain: 0, blend: "multiply" },
  // Graphite pencil: heavier grain than any pen (that's most of what reads as "pencil" rather
  // than "pen"), gentler pressure-to-width response, and opacity that varies with pressure like
  // Bellerive — light strokes look genuinely light, not just thin.
  pencil: { label: "Pencil", size: 5, thinning: 0.5, minAlpha: 0.7, maxAlpha: 0.95, grain: 0.6 },
  // Erases rather than draws — paintStroke special-cases `erase` to punch a real hole
  // (destination-out) instead of filling with a color.
  eraser: { label: "Eraser", size: 22, thinning: 0.4, minAlpha: 1, maxAlpha: 1, grain: 0, erase: true },
};
const PEN_ORDER = ["sanderling", "bellerive", "liffey", "pencil", "highlighter", "eraser"];
// Size buttons multiply a pen's own base `size` rather than replacing it, so Liffey-small and
// Sanderling-large stay relatively true to each pen's own character instead of all converging on
// the same three widths.
const PEN_SIZE_MULT = { sm: 0.55, md: 1, lg: 1.85 };
const PEN_SIZE_ORDER = ["sm", "md", "lg"];
const PEN_SIZE_LABEL = { sm: "S", md: "M", lg: "L" };
let currentPenSize = "md";
const INK_PALETTE = [
  { name: "ink", hex: "#28231C" }, { name: "rose", hex: "#C25E7C" }, { name: "butter", hex: "#B8862A" },
  { name: "sage", hex: "#6F8A57" }, { name: "peri", hex: "#6B77BF" }, { name: "lilac", hex: "#9A6FBF" },
  { name: "cyan", hex: "#3F97A3" },
];
// A separate, lighter set for the highlighter — real highlighters come in soft/neon pastels,
// not the app's darker ink palette, and half of INK_PALETTE would barely read at 50% opacity.
const HIGHLIGHTER_PALETTE = [
  { name: "pastel-yellow", hex: "#F5E27A" }, { name: "pastel-pink", hex: "#F3AFC0" },
  { name: "pastel-mint", hex: "#A8D9C5" }, { name: "pastel-blue", hex: "#A9C9E8" },
  { name: "pastel-lilac", hex: "#CBB6E0" }, { name: "pastel-peach", hex: "#F3C6A0" },
];
function paletteFor(penId) {
  return penId === "highlighter" ? HIGHLIGHTER_PALETTE : INK_PALETTE;
}
let currentPen = "sanderling";
let currentPenColor = INK_COLOR;

// Each sketch gets a random paper style at creation, so a page of notes doesn't look uniform —
// "warm" is plain warm-toned ruled paper (tried a coffee-stain graphic on it first; didn't land
// after a couple of rounds of tuning, dropped it — lines only, no marks); the other three are
// plain rectangles with just a different background. Picked once and stored on the drawing
// itself (not re-rolled on every render) so a note doesn't change paper every time it redraws.
const PAPER_STYLES = ["warm", "classic", "graph", "notecard"];
function randomPaperStyle() {
  return PAPER_STYLES[Math.floor(Math.random() * PAPER_STYLES.length)];
}
function paperOf(drawing) {
  return (drawing && drawing.paper) || "warm"; // drawings saved before this feature default to the original look
}
// Notecard is the one style that also varies by color — chosen well clear of colors already used
// elsewhere on the board (postit pink, butter, sage) so a notecard sketch doesn't blend in as
// "just another postit."
const NOTECARD_COLORS = ["blue", "yellow", "pink", "mint"];
function randomNotecardColor() {
  return NOTECARD_COLORS[Math.floor(Math.random() * NOTECARD_COLORS.length)];
}
function notecardColorOf(drawing) {
  return (drawing && drawing.cardColor) || "blue";
}
function paperClassOf(drawing) {
  const style = paperOf(drawing);
  return style === "notecard" ? `paper-${style} notecard-${notecardColorOf(drawing)}` : `paper-${style}`;
}
// Sketch cards also vary in size, independent of paper style, so a page of notes looks mixed
// rather than uniform — picked once at creation, same as paper/color.
const SKETCH_SIZE_KEYS = ["sm", "md", "lg"];
const DIARY_SKETCH_HEIGHTS = { sm: 170, md: 230, lg: 300 };
const POSTIT_SKETCH_HEIGHTS = { sm: 110, md: 150, lg: 200 };
function randomSketchSize() {
  return SKETCH_SIZE_KEYS[Math.floor(Math.random() * SKETCH_SIZE_KEYS.length)];
}
// Caps how tall a saved sketch reads on the board (see renderStaticImage) — not the live editing
// canvas, which is always full-screen now.
function sketchCanvasHeight(entryType, drawing) {
  const key = (drawing && drawing.sizeKey) || "md";
  const table = entryType === "task" ? POSTIT_SKETCH_HEIGHTS : DIARY_SKETCH_HEIGHTS;
  return table[key] || table.md;
}
// The one call every "new sketch" creation point uses, so paper/color/size are always rolled
// together and nothing forgets one of them.
function randomDrawingMeta() {
  return { paper: randomPaperStyle(), cardColor: randomNotecardColor(), sizeKey: randomSketchSize() };
}
// The pen/color picker only appears once she's actually touched the canvas with the Apple
// Pencil this session — before that it's hidden so a sketch card is just paper, not a toolbar
// sitting on top of paper. Once shown for a given entry it stays shown for that editing session.
let pencilRevealedIds = new Set();

// A stroke saved before pens existed is just a bare point array — treat it as a plain Sanderling
// stroke in the app's ink color so old drawings keep rendering exactly as they did. A stroke
// saved before pen sizes existed just has no `size` — treat that as "M", today's default.
function normalizeStroke(raw) {
  if (Array.isArray(raw)) return { tool: "sanderling", color: INK_COLOR, points: raw, size: "md" };
  if (raw && !raw.size) raw.size = "md";
  return raw;
}

// Standard perfect-freehand helper (from its own docs): turns the polygon outline getStroke()
// returns into a smoothed SVG path string.
function svgPathFromOutline(points) {
  if (!points.length) return "";
  const d = points.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...points[0], "Q"]
  );
  d.push("Z");
  return d.join(" ");
}
function strokeToPath(points, preset, sizeKey) {
  if (!points || points.length < 2) return "";
  const p = preset || PEN_PRESETS.sanderling;
  const sizeMult = PEN_SIZE_MULT[sizeKey] || 1;
  if (getStroke) {
    // Real per-point pressure only comes from an Apple Pencil; mouse/touch points are all
    // recorded at a constant 0.5 (see localPoint below), so simulate a natural taper for those
    // instead of drawing a uniform-width line.
    const simulatePressure = !points.some((pt) => pt[2] !== 0.5);
    // Tapering the start/end down to a point regardless of pressure — without this, pressing
    // hard right as you lift the pencil ends the stroke at full (pressure-scaled) width with a
    // round cap, which reads as a blob dropped on the page rather than a pen lifting off it.
    // Clamped to a fraction of the stroke's own length — a fixed size-scaled taper distance
    // could exceed a short stroke entirely (start-taper and end-taper zones overlapping and
    // collapsing the whole thing to near-nothing), which is exactly what silently neutered short
    // eraser swipes with a big pen size selected.
    const rawTaper = 14 * sizeMult;
    const taper = Math.min(rawTaper, polylineLength(points) * 0.4);
    return svgPathFromOutline(getStroke(points, {
      size: p.size * sizeMult, thinning: p.thinning, smoothing: 0.55, streamline: 0.55, simulatePressure,
      start: { taper, cap: true }, end: { taper, cap: true },
    }));
  }
  return "M " + points.map((pt) => pt[0] + " " + pt[1]).join(" L ");
}
function avgPressure(points) {
  return points.reduce((sum, p) => sum + p[2], 0) / points.length;
}
function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return len;
}

// A small tileable speckle texture, generated once and reused as-is for both the live canvas
// (as a repeating pattern, multiplied over the ink) and the saved SVG replay (the exact same
// bitmap embedded via a data URL) — so a drawing looks identical while editing and after Done.
let grainCanvasCache = null;
function grainCanvas() {
  if (grainCanvasCache) return grainCanvasCache;
  const n = document.createElement("canvas");
  n.width = n.height = 48;
  const nctx = n.getContext("2d");
  for (let i = 0; i < 900; i++) {
    const v = Math.floor(Math.random() * 90);
    nctx.fillStyle = `rgba(${v},${v},${v},${(0.35 + Math.random() * 0.4).toFixed(2)})`;
    nctx.fillRect(Math.random() * 48, Math.random() * 48, 1, 1);
  }
  grainCanvasCache = n;
  return n;
}

function paintStroke(ctx, stroke) {
  const preset = PEN_PRESETS[stroke.tool] || PEN_PRESETS.sanderling;
  if (!stroke.points || stroke.points.length < 2) return;
  const d = strokeToPath(stroke.points, preset, stroke.size);
  if (!d) return;
  const path = new Path2D(d);
  ctx.save();
  if (preset.erase) {
    // Actually removes pixels rather than drawing over them — since redraw() replays every
    // stroke from scratch in order every time, this only ever erases ink from strokes earlier
    // in that same replay, never ink added after it. Color is irrelevant to destination-out;
    // only the shape/alpha of what's filled matters.
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000";
    ctx.globalAlpha = 1;
    ctx.fill(path);
    ctx.restore();
    return;
  }
  const alpha = preset.minAlpha + (preset.maxAlpha - preset.minAlpha) * avgPressure(stroke.points);
  ctx.globalCompositeOperation = preset.blend || "source-over";
  ctx.fillStyle = stroke.color || INK_COLOR;
  ctx.globalAlpha = alpha;
  ctx.fill(path);
  if (preset.grain > 0) {
    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = preset.grain;
    ctx.fillStyle = ctx.createPattern(grainCanvas(), "repeat");
    ctx.fill(path);
  }
  ctx.restore();
}
// The saved (non-editing) view used to be reconstructed as a parallel SVG-path implementation —
// duplicating paintStroke's blend/grain/alpha logic, and with no way to represent an eraser's
// destination-out at all (SVG has no equivalent that composites against just the earlier
// siblings). Rendering it as a real canvas and replaying the exact same paintStroke() sequence
// used while drawing means there's one rendering path, not two, and erasing "just works" in the
// saved view for free. Traded infinite vector crispness for a 2x-resolution raster image, which
// reads as crisp as this UI ever needed anyway.
function renderStaticImage(drawing, cls, maxHeight) {
  if (!drawing || !drawing.strokes || !drawing.strokes.length) return "";
  const dpr = 2;
  const w = drawing.w || 300, h = drawing.h || 200;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const ctx = c.getContext("2d");
  ctx.scale(dpr, dpr);
  drawing.strokes.map(normalizeStroke).forEach((s) => paintStroke(ctx, s));
  // Sketching now always happens full-screen (see openSketchOverlay), so the sm/md/lg rolled in
  // randomDrawingMeta() no longer comes from the editing canvas's own height — it's applied here
  // instead, as a cap on the saved image, so the board still reads as a varied page of sketches.
  const style = maxHeight ? ` style="max-height:${maxHeight}px"` : "";
  return `<img class="${cls}" src="${c.toDataURL()}" width="${w}" height="${h}" alt=""${style}/>`;
}
function hasInk(e) {
  return !!(e.drawing && e.drawing.strokes && e.drawing.strokes.length);
}
function colorSwatchesHtml(penId) {
  return paletteFor(penId).map((c) => `<button type="button" class="pen-color${c.hex === currentPenColor ? " active" : ""}" data-pen-color="${c.hex}" style="background:${c.hex}" title="${c.name}"></button>`).join("");
}
function penSizesHtml() {
  return PEN_SIZE_ORDER.map((s) => `<button type="button" class="pen-size-btn${s === currentPenSize ? " active" : ""}" data-pen-size="${s}">${PEN_SIZE_LABEL[s]}</button>`).join("");
}
function penToolbarHtml(entryId) {
  const pens = PEN_ORDER.map((id) => `<button type="button" class="pen-btn${id === currentPen ? " active" : ""}" data-pen="${id}">${PEN_PRESETS[id].label}</button>`).join("");
  const revealed = pencilRevealedIds.has(entryId);
  const isEraser = PEN_PRESETS[currentPen] && PEN_PRESETS[currentPen].erase;
  return `<div class="pen-picker${revealed ? " revealed" : ""}" data-pen-picker="${entryId}">` +
    `<div class="pen-toolbar">${pens}<span class="pen-sizes">${penSizesHtml()}</span></div>` +
    `<div class="pen-colors"${isEraser ? ' style="display:none"' : ""}>${colorSwatchesHtml(currentPen)}</div></div>`;
}
function revealPenPicker(card, entryId) {
  pencilRevealedIds.add(entryId);
  const el = card.querySelector(`[data-pen-picker="${entryId}"]`);
  if (el) el.classList.add("revealed");
}
function wirePenToolbar(card) {
  // Only flips module-level state + toggles markup within this one toolbar — deliberately never
  // calls render(), same reasoning as updateEntryDrawing: a live sketch canvas must never be torn
  // down mid-session.
  const colorsEl = card.querySelector(".pen-colors");
  function wireColorButtons() {
    colorsEl.querySelectorAll("[data-pen-color]").forEach((btn) => btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      currentPenColor = btn.dataset.penColor;
      colorsEl.querySelectorAll("[data-pen-color]").forEach((b) => b.classList.toggle("active", b === btn));
    }));
  }
  card.querySelectorAll("[data-pen]").forEach((btn) => btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    currentPen = btn.dataset.pen;
    card.querySelectorAll("[data-pen]").forEach((b) => b.classList.toggle("active", b === btn));
    // Highlighter and pens use different color families — reset to a valid one when switching.
    const palette = paletteFor(currentPen);
    if (!palette.some((c) => c.hex === currentPenColor)) currentPenColor = palette[0].hex;
    colorsEl.innerHTML = colorSwatchesHtml(currentPen);
    colorsEl.style.display = PEN_PRESETS[currentPen] && PEN_PRESETS[currentPen].erase ? "none" : "";
    wireColorButtons();
  }));
  wireColorButtons();
  card.querySelectorAll("[data-pen-size]").forEach((btn) => btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    currentPenSize = btn.dataset.penSize;
    card.querySelectorAll("[data-pen-size]").forEach((b) => b.classList.toggle("active", b === btn));
  }));
}

function sketchOverlayBodyHtml(entryId) {
  return `<canvas class="sketchpad" data-sketch="${entryId}"></canvas>` +
    penToolbarHtml(entryId) +
    `<div class="sketch-toolbar">` +
    `<button type="button" class="sketch-btn" data-sketch-undo="${entryId}">undo</button>` +
    `<button type="button" class="sketch-btn" data-sketch-clear="${entryId}">clear</button>` +
    `</div>`;
}
// Full-screen sketch mode — opened by tapping ✎ on a diary card or "draw instead"/"edit sketch"
// on a task post-it. A small inline canvas is exactly where palm-rejection gets worse (less room,
// more incidental contact) and there's no room left over for real zoom, so drawing now always
// happens here instead, with the whole viewport as the page.
function openSketchOverlay(e) {
  sketchOverlayEntryId = e.id;
  const overlay = document.getElementById("sketchOverlay");
  const body = document.getElementById("sketchOverlayBody");
  document.getElementById("sketchOverlayLabel").textContent = e.type === "diary" ? "diary sketch" : "task sketch";
  overlay.classList.add("open");
  body.innerHTML = sketchOverlayBodyHtml(e.id);
  wirePenToolbar(body);
  const canvas = body.querySelector("canvas.sketchpad");
  sketchOverlayCtl = initSketchpad(canvas, e.drawing, (d) => updateEntryDrawing(e.id, d), () => revealPenPicker(body, e.id));
  body.querySelector("[data-sketch-undo]").addEventListener("click", () => sketchOverlayCtl.undo());
  body.querySelector("[data-sketch-clear]").addEventListener("click", () => sketchOverlayCtl.clear());
}
function closeSketchOverlay() {
  document.getElementById("sketchOverlay").classList.remove("open");
  if (sketchOverlayCtl) sketchOverlayCtl.destroy();
  document.getElementById("sketchOverlayBody").innerHTML = "";
  sketchOverlayEntryId = null;
  sketchOverlayCtl = null;
  render();
}

// Wires pointer events onto a blank canvas for freehand drawing. Palm rejection is simple but
// effective: while one pointer is actively drawing, any second pointer (a resting palm) is
// ignored outright, and a stray touch right after the pencil lifts is ignored for half a second.
function initSketchpad(canvas, drawing, onChange, onPencilStart) {
  drawing = drawing || { w: 0, h: 0, strokes: [] };
  const ctx = canvas.getContext("2d");
  let strokes = (drawing.strokes || []).map(normalizeStroke);
  let current = null; // bare points array for the in-progress stroke; wrapped with the active pen/color once finished
  let activePointerId = null;
  let lastPenUpAt = 0;
  let pencilStartFired = false;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawing.w = rect.width;
    drawing.h = rect.height;
    redraw();
  }
  function redraw() {
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (getStroke) {
      strokes.forEach((s) => paintStroke(ctx, s));
      if (current && current.length > 1) paintStroke(ctx, { tool: currentPen, color: currentPenColor, points: current, size: currentPenSize });
    } else {
      // library still loading — plain polyline fallback, ignores pen styling until it's ready
      ctx.strokeStyle = INK_COLOR;
      (current ? strokes.map((s) => s.points).concat([current]) : strokes.map((s) => s.points)).forEach((pts) => {
        if (pts.length < 2) return;
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
        ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.stroke();
      });
    }
  }
  function localPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const pressure = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
    return [e.clientX - rect.left, e.clientY - rect.top, pressure];
  }
  function down(e) {
    if (activePointerId !== null) return;
    if (e.pointerType === "touch" && Date.now() - lastPenUpAt < 500) return;
    if (e.pointerType === "pen" && !pencilStartFired) { pencilStartFired = true; onPencilStart && onPencilStart(); }
    activePointerId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    current = [localPoint(e)];
    redraw();
    e.preventDefault();
  }
  function move(e) {
    if (e.pointerId !== activePointerId || !current) return;
    current.push(localPoint(e));
    redraw();
    e.preventDefault();
  }
  function up(e) {
    if (e.pointerId !== activePointerId) return;
    if (e.pointerType === "pen") lastPenUpAt = Date.now();
    if (current && current.length > 1) strokes.push({ tool: currentPen, color: currentPenColor, points: current, size: currentPenSize });
    current = null;
    activePointerId = null;
    redraw();
    drawing.strokes = strokes;
    onChange(drawing);
  }
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  // initSketchpad runs while this canvas is still an in-memory element (the card it's on hasn't
  // been appended to #board yet), so getBoundingClientRect() here would read 0x0 and lock the
  // canvas's actual pixel dimensions at zero forever — nothing painted to it would ever be
  // visible. Deferring to the next frame (same double-deferred pattern as packBoard()) waits
  // until the card is actually laid out.
  requestAnimationFrame(resize);
  setTimeout(resize, 300);
  // The full-screen overlay's canvas is layout-sized (flex:1), not fixed-height like the old
  // inline one — an iPad rotation mid-sketch would otherwise leave the drawing buffer at its
  // original size while the CSS box changes shape, stretching everything painted so far. Existing
  // strokes stay anchored at their original (CSS-pixel) position rather than being rescaled, so
  // growing the canvas just reveals more blank page, which reads correctly either way.
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  return {
    undo() { strokes.pop(); redraw(); drawing.strokes = strokes; onChange(drawing); },
    clear() { strokes = []; redraw(); drawing.strokes = strokes; onChange(drawing); },
    destroy() { resizeObserver.disconnect(); },
  };
}

function isUrlLike(s) {
  try {
    const u = new URL(String(s).trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
function noteCards() {
  return entries.filter((e) => e.type === "note" && matchesFilter(e)).map((e) => {
    const primary = e.tags[0];
    const tint = ["sage", "lilac", "butter"].includes(primary) ? primary : "";
    const mini = !e.title && e.body.length < 90 && !e.imageUrl;
    const card = makeCard([tint, mini ? "mini" : ""].filter(Boolean).join(" "));
    card.dataset.entryId = e.id;
    const date = new Date(e.createdAt);
    const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const tagsHtml = e.tags.map((t) => tagSpan(t)).join(" ");
    const bodyHtml = isUrlLike(e.body)
      ? `<a class="note-link" href="${escapeHtml(e.body)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.body)} ↗</a>`
      : escapeHtml(e.body).replace(/\n/g, "<br>");
    const thumbHtml = e.imageUrl
      ? `<a href="${escapeHtml(e.body)}" target="_blank" rel="noopener noreferrer"><img class="note-thumb" src="${escapeHtml(e.imageUrl)}" alt="" loading="lazy" onerror="this.remove()"></a>`
      : "";
    const fontStyle = noteFontStyle(e);
    card.innerHTML =
      `<div class="meta"><span>${dateStr}</span><span class="tags">${tagsHtml}` +
      `<span class="boxclose" data-fonttoggle="${e.id}" title="change font (${noteFontOf(e)})">Aa</span>` +
      `<span class="boxclose" data-addtag="${e.id}" title="add tag">+</span><span class="boxclose" data-del="${e.id}" title="delete">✕</span></span></div>` +
      thumbHtml +
      (e.title ? `<h2${fontStyle}>${escapeHtml(e.title)}</h2>` : "") +
      `<p${fontStyle}>${bodyHtml}</p>`;
    card.querySelectorAll("[data-del]").forEach((x) => x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteEntry(x.dataset.del);
    }));
    wireAddTag(card);
    wireFontToggle(card);
    return card;
  });
}

function pinnedCards() {
  // pinned todo/reply single items get their own small pinned card
  return entries.filter((e) => e.pinned && (e.type === "todo" || e.type === "reply") && matchesFilter(e)).map((e) => {
    const card = makeCard("pin mini");
    card.dataset.entryId = e.id;
    const date = new Date(e.createdAt);
    const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    card.innerHTML =
      `<div class="meta"><span>Pinned · ${dateStr}</span><span class="tags">${tagSpan(e.tags[0] || "todo")}</span></div>` +
      rowHtml(e);
    wireRows(card);
    return card;
  });
}

// A vintage-travel-BROCHURE-style trail map for Jackson Hole Mountain Resort, pinned to the
// bulletin board — mimics the real 3-panel-fold layout of old ski brochures (a badge panel, then
// two repeated wordmark panels, mountain illustration spanning underneath) rather than a single
// poster. Original illustration, not a copy of any real resort's brochure. Built on real facts:
// opened Dec. 28, 1965 (Paul McCollister, Alex Morley, Gordon Graham); Rendezvous Mountain
// summits at 10,450ft with a 4,139ft vertical drop down to Teton Village; 13 lifts (incl. the
// Aerial Tram, Teewinot and Thunder) across 131 trails.
// Sources: jacksonhole.com/history, jacksonhole.com/corbets-couloir, Wikipedia "Jackson Hole
// Mountain Resort". Inlined (not an <img src>) so its text uses the app's own already-loaded
// Oswald/Alex Brush fonts instead of needing fonts baked into the graphic.
const JACKSON_HOLE_MAP_SVG = `<svg viewBox="0 0 630 460" width="630" height="460" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <filter id="jhPaper" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="5" result="n"/>
      <feColorMatrix in="n" type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.22"/></feComponentTransfer>
    </filter>
    <radialGradient id="jhVignette" cx="50%" cy="45%" r="75%">
      <stop offset="60%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.35"/>
    </radialGradient>
    <linearGradient id="jhCrease" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#000" stop-opacity="0"/>
      <stop offset="45%" stop-color="#000" stop-opacity="0.28"/>
      <stop offset="55%" stop-color="#fff" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <!-- aged paper base, textured -->
  <rect width="630" height="460" fill="#2C4A63"/>
  <rect width="630" height="460" filter="url(#jhPaper)" opacity="0.5"/>
  <!-- panel 1: circular badge -->
  <g transform="translate(105,110)">
    <circle r="58" fill="#EDE6D3"/>
    <circle r="52" fill="none" stroke="#2C4A63" stroke-width="2"/>
    <path id="jhArcTop" d="M -42 -10 A 44 44 0 0 1 42 -10" fill="none"/>
    <path id="jhArcBot" d="M -36 22 A 38 38 0 0 0 36 22" fill="none"/>
    <text font-family="'Oswald', sans-serif" font-weight="700" font-size="10.5" fill="#2C4A63" letter-spacing="2"><textPath href="#jhArcTop" xlink:href="#jhArcTop" startOffset="50%" text-anchor="middle">JACKSON HOLE</textPath></text>
    <text font-family="'Oswald', sans-serif" font-weight="500" font-size="9" fill="#2C4A63" letter-spacing="3"><textPath href="#jhArcBot" xlink:href="#jhArcBot" startOffset="50%" text-anchor="middle">WYOMING</textPath></text>
    <g transform="translate(-14,-8)" fill="#2C4A63">
      <path d="M0 20 L0 8 C0 2 4 -2 9 -2 C10 -6 13 -9 16 -10 C15 -8 15 -6 16 -5 C19 -7 23 -7 25 -5 C22 -4 20 -2 20 0 C24 -1 27 1 27 4 C24 3 21 4 20 6 L20 20 L16 20 L16 10 L12 10 L12 20 L8 20 L8 12 C6 12 4 11 3 9 L3 20 Z"/>
    </g>
  </g>
  <text x="105" y="200" font-family="'Oswald', sans-serif" font-weight="500" font-size="11" fill="#EDE6D3" text-anchor="middle" letter-spacing="1">EST. 1965</text>
  <!-- panels 2 + 3: repeated wordmark block, mimicking a real brochure's twin panels -->
  <g transform="translate(215,50)">
    <text x="0" y="46" font-family="'Alex Brush', cursive" font-size="52" fill="#EDE6D3">ski</text>
    <text x="0" y="70" font-family="'Oswald', sans-serif" font-weight="700" font-size="20" fill="#EDE6D3" letter-spacing="0.5">JACKSON HOLE</text>
    <text x="0" y="88" font-family="'Oswald', sans-serif" font-weight="500" font-size="11" fill="#EDE6D3" letter-spacing="1.5">TETON VILLAGE, WYOMING</text>
    <text x="0" y="106" font-family="'Alex Brush', cursive" font-size="18" fill="#EDE6D3">from November to April</text>
  </g>
  <g transform="translate(425,50)">
    <text x="0" y="46" font-family="'Alex Brush', cursive" font-size="52" fill="#EDE6D3">ski</text>
    <text x="0" y="70" font-family="'Oswald', sans-serif" font-weight="700" font-size="20" fill="#EDE6D3" letter-spacing="0.5">JACKSON HOLE</text>
    <text x="0" y="88" font-family="'Oswald', sans-serif" font-weight="500" font-size="11" fill="#EDE6D3" letter-spacing="1.5">TETON VILLAGE, WYOMING</text>
    <text x="0" y="106" font-family="'Alex Brush', cursive" font-size="18" fill="#EDE6D3">from November to April</text>
  </g>
  <!-- fold creases dividing the 3 panels -->
  <rect x="200" y="0" width="20" height="460" fill="url(#jhCrease)"/>
  <rect x="410" y="0" width="20" height="460" fill="url(#jhCrease)"/>
  <!-- mountain illustration, spanning the full width beneath the fold -->
  <g>
    <path d="M20 440 L140 260 L220 400 L250 440 Z" fill="#9FB3C0"/>
    <path d="M180 440 L340 190 L390 265 L440 215 L610 440 Z" fill="#CBD3D6"/>
    <path d="M340 190 L390 265 L355 305 Z" fill="#9FB3C0"/>
    <path d="M440 215 L610 440 L520 440 L490 320 Z" fill="#9FB3C0"/>
    <path d="M328 212 L340 190 L354 213 L340 226 Z" fill="#EDE6D3"/>
    <path d="M0 440 L12 430 L22 440 L32 428 L42 440 L52 431 L62 440 L72 429 L82 440 L92 432 L102 440 L112 427 L122 440 L132 431 L142 440 L152 429 L162 440 L172 432 L182 440 L192 428 L202 440 L212 431 L222 440 L232 429 L242 440 L252 432 L262 440 L272 428 L282 440 L292 431 L302 440 L312 429 L322 440 L332 432 L342 440 L352 428 L362 440 L372 431 L382 440 L392 429 L402 440 L412 432 L422 440 L432 428 L442 440 L452 431 L462 440 L472 429 L482 440 L492 432 L502 440 L512 428 L522 440 L532 431 L542 440 L552 429 L562 440 L572 432 L582 440 L592 428 L602 440 L612 431 L622 440 L630 434 L630 460 L0 460 Z" fill="#182f42"/>
  </g>
  <g stroke-width="2.5" fill="none" stroke-linecap="round">
    <path d="M340 193 L230 400" stroke="#D9A441"/>
    <path d="M340 193 L280 425" stroke="#B5502F"/>
    <path d="M390 268 L350 425" stroke="#7FA872"/>
    <path d="M440 218 L410 425" stroke="#D9A441"/>
    <path d="M440 218 L470 430" stroke="#B5502F"/>
  </g>
  <g font-family="'Oswald', sans-serif" font-weight="500" font-size="10" fill="#EDE6D3">
    <circle cx="340" cy="193" r="4.5" fill="#EDE6D3"/><text x="348" y="188">TRAM</text>
    <circle cx="390" cy="268" r="4.5" fill="#EDE6D3"/><text x="398" y="265">TEEWINOT</text>
    <circle cx="440" cy="218" r="4.5" fill="#EDE6D3"/><text x="448" y="214">THUNDER</text>
  </g>
  <!-- stats box -->
  <g transform="translate(430,370)">
    <rect width="180" height="72" fill="#EDE6D3" opacity="0.95"/>
    <text x="10" y="18" font-family="'Oswald', sans-serif" font-weight="700" font-size="10" fill="#2C4A63" letter-spacing="0.5">JACKSON HOLE MTN RESORT</text>
    <line x1="10" y1="26" x2="170" y2="26" stroke="#2C4A63" stroke-width="0.6" opacity="0.4"/>
    <text x="10" y="42" font-family="'Oswald', sans-serif" font-size="9.5" fill="#2C4A63">SUMMIT: 10,450 FT</text>
    <text x="10" y="56" font-family="'Oswald', sans-serif" font-size="9.5" fill="#2C4A63">VERTICAL DROP: 4,139 FT</text>
    <text x="10" y="68" font-family="'Oswald', sans-serif" font-size="9.5" fill="#2C4A63">13 LIFTS · 131 TRAILS</text>
  </g>
  <!-- aged vignette + border on top -->
  <rect width="630" height="460" fill="url(#jhVignette)"/>
  <rect x="4" y="4" width="622" height="452" fill="none" stroke="#EDE6D3" stroke-width="2" opacity="0.85"/>
</svg>`;

// The plain flat dot the small Everything-board calendar has always used — untouched.
function calendarDotHtml(color) {
  return `<div class="dot ${color}"></div>`;
}
// Hand-drawn sticker for the big bulletin-board calendar — shape by entry type, color by tag
// (colorFor(), same source every tag chip in the app already uses).
function calendarStickerSvg(type, color) {
  const shape = type === "event" ? "flag" : type === "reply" ? "heart" : "star";
  const paths = {
    star: `<path d="M20 3 L24 15 L37 15 L26 23 L30 36 L20 28 L10 36 L14 23 L3 15 L16 15 Z" />`,
    heart: `<path d="M20 33 C10 25 4 17 8 10 C11 5 17 6 20 12 C23 6 29 5 32 10 C36 17 30 25 20 33 Z" />`,
    flag: `<path d="M10 3 L13 3 L13 37 L10 37 Z M13 6 L30 11 L13 17 Z" />`,
  };
  return `<svg class="cal-sticker ${color}" viewBox="0 0 40 40">${paths[shape]}</svg>`;
}
function calendarCard(large) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();
  const monthName = now.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const dueSet = {};
  entries.forEach((e) => {
    if (e.dueAt && !e.done) {
      const d = e.dueAt;
      dueSet[d] = dueSet[d] || { color: colorFor(e.tags[0] || "todo"), type: e.type };
    }
  });

  let cells = [];
  for (let i = startDow - 1; i >= 0; i--) cells.push({ n: prevDays - i, dim: true });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = new Date(y, m, d).toISOString().slice(0, 10);
    const isToday = daysBetween(todayStart(), new Date(y, m, d)) === 0;
    cells.push({ n: d, today: isToday, due: dueSet[iso] });
  }
  let next = 1;
  while (cells.length % 7 !== 0) cells.push({ n: next++, dim: true });

  let rows = "";
  for (let i = 0; i < cells.length; i += 7) {
    rows += "<tr>" + cells.slice(i, i + 7).map((c) =>
      `<td class="${c.dim ? "dim" : ""}${c.today ? " today" : ""}">${c.n}` +
      (c.due ? (large ? calendarStickerSvg(c.due.type, c.due.color) : calendarDotHtml(c.due.color)) : "") +
      `</td>`
    ).join("") + "</tr>";
  }
  const table = `<table class="cal"><tr><th>S</th><th>M</th><th>T</th><th>W</th><th>T</th><th>F</th><th>S</th></tr>${rows}</table>`;

  if (!large) {
    const card = makeCard("graph");
    card.innerHTML = `<div class="meta"><span>${monthName}</span><span class="tags"><span class="tag peri">#calendar</span></span></div>` + table;
    return card;
  }

  // Big Month-tab view — a corkboard bulletin board with the calendar pinned centered on it like
  // a sheet of paper, and a few placeholder slots (for the Pinterest photos/quotes, once that
  // integration lands) overlapping its corners for real clutter instead of a tidy row.
  const card = makeCard("bulletin-board");
  card.innerHTML =
    `<div class="bulletin-photo placeholder corner-tl"><div class="pushpin butter"></div><span>photos coming soon</span></div>` +
    `<div class="bulletin-photo placeholder corner-br"><div class="pushpin sage"></div><span>photos coming soon</span></div>` +
    `<div class="bulletin-sheet">` +
    `<div class="pushpin rose"></div>` +
    `<div class="meta"><span>${monthName}</span></div>` +
    table +
    `</div>` +
    `<div class="bulletin-photo placeholder corner-bl"><div class="pushpin lilac"></div><span>photos coming soon</span></div>` +
    `<div class="bulletin-photo map-postcard corner-tr"><div class="pushpin cyan"></div>${JACKSON_HOLE_MAP_SVG}</div>`;
  return card;
}

function habitRowHtml(e) {
  const week = weekIsoDates();
  const doneToday = (e.checkins || []).includes(todayIso());
  const count = (e.checkins || []).filter((d) => week.includes(d)).length;
  return `<div class="row${doneToday ? " done" : ""}" data-id="${e.id}" data-habit="1">
      <div class="box"></div><span class="txt">${escapeHtml(e.title || e.body)}</span>
      <span class="end"><span class="due">${count}/${e.weeklyTarget || 3}</span><span class="del" data-del="${e.id}" title="delete">✕</span></span>
    </div>`;
}
function habitsCard() {
  const items = entries.filter((e) => e.type === "habit" && matchesFilter(e));
  if (!items.length && (activeTag || searchQuery)) return null;
  const card = makeCard("graph");
  card.innerHTML =
    `<div class="meta"><span>Habits · This week</span><span class="tags">${tagSpan("habit")}</span></div>` +
    items.map((e) => habitRowHtml(e)).join("") +
    addRowHtml("add a habit…");
  wireCardInteractions(card, { type: "habit", tags: ["habit"], weeklyTarget: 3, checkins: [] });
  return card;
}

// ── star chart — a nostalgic, hand-drawn alternative view of the same habit entries/checkins
// used by habitsCard() above (its own tab, per the ask; the plain weekly-count card on the
// Everything board is untouched). A cell is a day × habit square; tapping one places or removes
// a star sticker for that exact date, not just today.
const STAR_COLORS = ["gold", "rust", "olive"];
function starStickerSvg(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const angle = (h % 17) - 8; // small per-cell tilt, stable across re-renders — looks hand-stuck-on
  const color = STAR_COLORS[h % STAR_COLORS.length];
  return `<svg class="star-sticker ${color}" viewBox="0 0 40 40" style="transform:rotate(${angle}deg)">` +
    `<path d="M20 3 L24 15 L37 15 L26 23 L30 36 L20 28 L10 36 L14 23 L3 15 L16 15 Z" /></svg>`;
}
function starChartCard() {
  const items = entries.filter((e) => e.type === "habit" && matchesFilter(e));
  const week = weekIsoDates();
  const dayLetters = ["M", "T", "W", "T", "F", "S", "S"];
  const today = todayIso();
  const rows = items.map((e) => {
    const checkins = e.checkins || [];
    const cells = week.map((iso) =>
      `<td class="star-cell${iso === today ? " today" : ""}" data-star-cell="${e.id}" data-star-date="${iso}">` +
      (checkins.includes(iso) ? starStickerSvg(e.id + iso) : "") +
      `</td>`
    ).join("");
    return `<tr><th class="star-row-label"><span>${escapeHtml(e.title || e.body)}</span><span class="star-del" data-del="${e.id}" title="delete">✕</span></th>${cells}</tr>`;
  }).join("");
  const card = makeCard("wide star-chart");
  card.innerHTML =
    `<div class="star-chart-banner">☆ <span class="star-chart-title">weekly star chart</span> ☆</div>` +
    `<table class="star-table"><colgroup><col style="width:28%">${dayLetters.map(() => "<col>").join("")}</colgroup>` +
    `<tr><th></th>${dayLetters.map((d) => `<th>${d}</th>`).join("")}</tr>` +
    (rows || `<tr><td colspan="8" class="star-empty">No habits yet — add one below to start earning stars.</td></tr>`) +
    `</table>` +
    addRowHtml("add a habit…");
  wireCardInteractions(card, { type: "habit", tags: ["habit"], weeklyTarget: 3, checkins: [] });
  card.querySelectorAll("[data-star-cell]").forEach((td) => td.addEventListener("click", () => {
    toggleHabitCheckinDate(td.dataset.starCell, td.dataset.starDate);
  }));
  card.querySelectorAll(".star-del").forEach((x) => x.addEventListener("click", (ev) => {
    ev.stopPropagation();
    deleteEntry(x.dataset.del);
  }));
  return card;
}

// ── interactions ─────────────────────────────────────────────────────
function wireRows(container) {
  container.querySelectorAll(".row").forEach((row) => {
    row.addEventListener("click", (ev) => {
      if (ev.target.dataset.del) return;
      const detailToggle = ev.target.closest("[data-detail-toggle]");
      if (detailToggle) {
        const id = detailToggle.dataset.detailToggle;
        if (expandedTaskIds.has(id)) expandedTaskIds.delete(id);
        else expandedTaskIds.add(id);
        render();
        return;
      }
      if (row.dataset.habit) { toggleHabitCheckin(row.dataset.id); return; }
      const entry = entries.find((x) => x.id === row.dataset.id);
      if (entry && entry.type === "task") cycleTaskStatus(row.dataset.id);
      else toggleDone(row.dataset.id);
    });
  });
  container.querySelectorAll("[data-del]").forEach((del) => {
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteEntry(del.dataset.del);
    });
  });
}
function wireTaskDetailInputs(container) {
  container.querySelectorAll("[data-detail-input]").forEach((ta) => {
    ta.addEventListener("blur", () => updateTaskDetail(ta.dataset.detailInput, ta.value));
  });
}
function wireAddRow(container, ctx) {
  const addBtn = container.querySelector(".addrow");
  if (!addBtn) return;
  addBtn.addEventListener("click", () => {
    const input = document.createElement("input");
    input.className = "addrow-input";
    input.style.cssText = "width:100%;border:none;background:none;font-family:'Courier Prime',monospace;font-size:12px;color:var(--ink);padding:6px 0;outline:none;";
    input.placeholder = "type and press enter…";
    addBtn.replaceWith(input);
    input.focus();
    // render() below detaches `input` from the document (the whole card gets rebuilt), and
    // detaching a focused element fires a native blur — which would otherwise re-trigger the
    // "blur" listener a second time and add the entry twice. `committed` makes commit() (and
    // the Escape cancel) run at most once per input.
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const val = input.value.trim();
      if (val) addEntry(Object.assign({ body: val }, ctx));
      render();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") commit();
      if (ev.key === "Escape") { committed = true; render(); }
    });
    input.addEventListener("blur", commit);
  });
}
function wireCardInteractions(card, addCtx) {
  wireRows(card);
  wireAddRow(card, addCtx);
}

// ── board assembly ──────────────────────────────────────────────────
function buildBoardCards() {
  const list = [];
  if (activeNavId === "notes") {
    noteCards().forEach((c) => list.push({ id: "note-" + c.dataset.entryId, el: c }));
  } else if (activeNavId === "diary") {
    diaryCards().forEach((c) => list.push({ id: "diary-" + c.dataset.entryId, el: c }));
    // Drawing only makes sense where there's a pen/touch to draw with — on a plain mouse-driven
    // desktop browser, skip straight to typing instead of offering a canvas.
    const addTile = makeCard("mini addbox");
    if (isTouchCapable) {
      addTile.innerHTML = `<div class="meta"><span>+ new sketch</span></div>`;
      addTile.addEventListener("click", () => {
        const e = addEntry({ type: "diary", drawing: { w: 0, h: 0, strokes: [], ...randomDrawingMeta() } });
        render();
        openSketchOverlay(e);
      });
    } else {
      addTile.innerHTML = `<div class="meta"><span>+ new entry</span></div>`;
      addTile.addEventListener("click", () => openModal("diary"));
    }
    list.push({ id: "add-diary-sketch", el: addTile });
  } else if (activeNavId === "people") {
    const orc = owedReplyCard();
    if (orc) list.push({ id: "owe-reply", el: orc });
  } else if (activeNavId === "biglist") {
    const bl = bigListCard();
    if (bl) list.push({ id: "big-list", el: bl });
  } else if (activeNavId === "tasks") {
    const boxes = taskBoxes.concat([{ id: UNSORTED_BOX, title: "Unsorted" }]);
    boxes.forEach((box, i) => {
      const bc = taskBoxCard(box, i);
      if (bc) list.push({ id: "taskbox-" + box.id, el: bc });
    });
    entries.filter((e) => e.type === "task" && hasTaskDetail(e) && matchesFilter(e))
      .forEach((e) => list.push({ id: "taskdetail-" + e.id, el: taskDetailCard(e) }));
    const addBoxTile = makeCard("mini addbox");
    addBoxTile.innerHTML = `<div class="meta"><span>+ new box</span></div>`;
    addBoxTile.addEventListener("click", addTaskBox);
    list.push({ id: "add-task-box", el: addBoxTile });
  } else if (activeNavId === "month") {
    list.push({ id: "calendar", el: calendarCard(true) });
  } else if (activeNavId === "starchart") {
    list.push({ id: "star-chart", el: starChartCard() });
  } else {
    list.push({ id: "mood", el: moodCard() });
    list.push({ id: "coming-up", el: comingUpCard() });
    const bl = bigListCard();
    if (bl) list.push({ id: "big-list", el: bl });
    const tl = taskListCard();
    if (tl) list.push({ id: "tasks", el: tl });
    list.push({ id: "calendar", el: calendarCard() });
    const hb = habitsCard();
    if (hb) list.push({ id: "habits", el: hb });
    pinnedCards().forEach((c) => list.push({ id: "pin-" + c.dataset.entryId, el: c }));
    const orc = owedReplyCard();
    if (orc) list.push({ id: "owe-reply", el: orc });
    const sc = scratchCard();
    if (sc) list.push({ id: "scratchpad", el: sc });
    diaryCards().forEach((c) => list.push({ id: "diary-" + c.dataset.entryId, el: c }));
    noteCards().forEach((c) => list.push({ id: "note-" + c.dataset.entryId, el: c }));
  }
  list.forEach((c) => {
    const grip = document.createElement("div");
    grip.className = "grip";
    grip.setAttribute("aria-hidden", "true");
    grip.title = "drag to reorder";
    grip.textContent = "⠿";
    c.el.appendChild(grip);
  });
  return list;
}
function orderCards(cards) {
  const order = loadBoardOrder();
  const map = new Map(cards.map((c) => [c.id, c]));
  const ordered = [];
  order.forEach((id) => {
    if (map.has(id)) { ordered.push(map.get(id)); map.delete(id); }
  });
  cards.forEach((c) => { if (map.has(c.id)) ordered.push(c); });
  return ordered;
}

function renderWeekView() {
  const el = document.getElementById("week-grid");
  if (!el) return;
  el.innerHTML = "";
  const today = todayStart();
  const monday = mondayOf(today);
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const isToday = daysBetween(today, d) === 0;
    const dayItems = entries.filter((e) => e.dueAt === iso && e.type !== "habit" && matchesFilter(e));
    const col = document.createElement("div");
    col.className = "wday" + (isToday ? " today" : "");
    col.innerHTML = `<div class="wh"><span class="num">${d.getDate()}</span><span class="nm">${names[i]}</span></div>`;
    if (!dayItems.length) {
      col.innerHTML += `<div class="wday-empty">nothing due</div>`;
    } else {
      dayItems.forEach((e) => {
        const c = colorFor(e.tags[0] || "todo");
        const block = document.createElement("div");
        block.className = "blk " + c + (e.done ? " done" : "");
        block.innerHTML = `<span class="bt">${e.type}</span>${escapeHtml(e.title || e.body)}`;
        if (e.type === "todo" || e.type === "reply") {
          block.addEventListener("click", () => toggleDone(e.id));
        }
        col.appendChild(block);
      });
    }
    el.appendChild(col);
  }
}

function render() {
  renderChips();
  renderWeekStrip();
  renderWeekView();
  renderNav();
  const board = document.getElementById("board");
  board.innerHTML = "";
  orderCards(buildBoardCards()).forEach((c) => {
    c.el.dataset.cardid = c.id;
    board.appendChild(c.el);
  });

  requestAnimationFrame(packBoard);
  setTimeout(packBoard, 300);
}

// ── drag reorder (pointer-based, works for mouse + touch) ────────────
function enableDragReorder(container, { itemSelector, handleSelector, axis = "y", onReorder }) {
  let dragEl = null, startX = 0, startY = 0, moved = false, pointerId = null;
  container.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".no-drag")) return;
    const handle = e.target.closest(handleSelector || itemSelector);
    if (!handle) return;
    const item = handle.closest(itemSelector);
    if (!item) return;
    dragEl = item; startX = e.clientX; startY = e.clientY; moved = false; pointerId = e.pointerId;
    try { dragEl.setPointerCapture(pointerId); } catch (_) {}
  });
  container.addEventListener("pointermove", (e) => {
    if (!dragEl || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) > 6) { moved = true; dragEl.classList.add("dragging"); }
    if (!moved) return;
    e.preventDefault();
    const siblings = Array.from(container.querySelectorAll(itemSelector)).filter((i) => i !== dragEl && !i.classList.contains("no-drag"));
    let target = null, best = Infinity;
    siblings.forEach((it) => {
      const r = it.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const d = Math.hypot(e.clientX - cx, e.clientY - cy);
      if (d < best) { best = d; target = it; }
    });
    if (target) {
      const r = target.getBoundingClientRect();
      const before = axis === "x" ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
      container.insertBefore(dragEl, before ? target : target.nextSibling);
    }
  });
  const end = () => {
    if (!dragEl) return;
    if (pointerId != null) { try { dragEl.releasePointerCapture(pointerId); } catch (_) {} }
    dragEl.classList.remove("dragging");
    if (moved && onReorder) {
      const ids = Array.from(container.querySelectorAll(itemSelector))
        .filter((i) => !i.classList.contains("no-drag"))
        .map((i) => i.dataset.cardid || i.dataset.navid);
      onReorder(ids);
    }
    dragEl = null; moved = false; pointerId = null;
  };
  container.addEventListener("pointerup", end);
  container.addEventListener("pointercancel", end);
}

function packBoard() {
  const gap = 18, rowH = 2;
  const cards = document.querySelectorAll(".board > .card");
  cards.forEach((c) => (c.style.gridRowEnd = "auto"));
  requestAnimationFrame(() => {
    cards.forEach((c) => {
      const h = c.getBoundingClientRect().height;
      if (h > 10) c.style.gridRowEnd = "span " + Math.ceil((h + gap) / (rowH + gap));
    });
  });
}

// ── dither band ──────────────────────────────────────────────────────
const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const ramp = [[194, 94, 124], [184, 134, 42], [111, 138, 87], [107, 119, 191], [154, 111, 191]];
function lerp(a, b, f) { return a.map((v, i) => v + (b[i] - v) * f); }
function rampColor(t) {
  const x = t * (ramp.length - 1), i = Math.min(Math.floor(x), ramp.length - 2), f = x - i;
  return lerp(ramp[i], ramp[i + 1], f).map(Math.round);
}
function drawBand() {
  const cv = document.getElementById("band");
  // Height comes from CSS now (32px on desktop, 8px on phone — see the mobile media query),
  // not a hardcoded value, so the band actually shrinks with the rest of the compact mobile
  // header instead of the canvas staying full-height while CSS just clips it.
  const cell = 2, w = cv.clientWidth, h = cv.clientHeight || 32;
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  const cols = Math.ceil(w / cell), rows = Math.ceil(h / cell);
  for (let x = 0; x < cols; x++) {
    const t = x / (cols - 1);
    const density = 0.92 - t * 0.80;
    const alpha = 1 - t * 0.45;
    const [r, g, b] = rampColor(t);
    for (let y = 0; y < rows; y++) {
      if (density > (bayer[y % 4][x % 4] + 0.5) / 16) {
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  }
}

// ── nav (fixed tabs + user-added custom tabs, both reorderable) ──────
const FIXED_TABS = [
  { id: "everything", label: "Everything", view: "board", tag: null, dotColor: "" },
  { id: "biglist", label: "The Big List", view: "board", tag: null, dotColor: "butter" },
  { id: "tasks", label: "Tasks", view: "board", tag: null, dotColor: "butter" },
  { id: "notes", label: "Notes", view: "board", tag: null, dotColor: "lilac" },
  { id: "diary", label: "Diary", view: "board", tag: null, dotColor: "sage" },
  { id: "people", label: "People", view: "board", tag: null, dotColor: "rose" },
  { id: "day", label: "Day", view: "day", tag: null, dotColor: "cyan" },
  { id: "week", label: "Week", view: "week", tag: null, dotColor: "peri" },
  { id: "month", label: "Month", view: "board", tag: null, dotColor: "peri" },
  { id: "starchart", label: "Star Chart", view: "board", tag: null, dotColor: "butter" },
];
let activeNavId = "everything";

function switchView(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("on"));
  document.getElementById("v-" + view).classList.add("on");
}

// Mobile shows #nav as a collapsed-by-default expanding menu (see navMenuOpen/wireNavMenuToggle)
// instead of the desktop scrolling tab strip — this flag just remembers whether it's open across
// the re-renders that rebuild #nav's contents from scratch (a tab click closes it explicitly).
let navMenuOpen = false;
function renderNav() {
  const nav = document.getElementById("nav");
  nav.innerHTML = "";
  const all = FIXED_TABS.concat(customViews.map((v) => ({ id: v.id, label: v.label, view: "board", tag: v.tag, custom: true, dotColor: colorFor(v.tag) })));
  const order = loadNavOrder();
  const map = new Map(all.map((t) => [t.id, t]));
  const ordered = [];
  order.forEach((id) => { if (map.has(id)) { ordered.push(map.get(id)); map.delete(id); } });
  all.forEach((t) => { if (map.has(t.id)) ordered.push(t); });

  ordered.forEach((t) => {
    const a = document.createElement("div");
    a.className = "tab" + (t.dotColor ? " " + t.dotColor : "") + (t.id === activeNavId ? " active" : "");
    a.dataset.navid = t.id;
    a.innerHTML = `<span class="dot"></span>${escapeHtml(t.label)}` + (t.custom ? `<span class="navclose" data-closeid="${t.id}" title="remove tab">✕</span>` : "");
    a.addEventListener("click", (ev) => {
      if (ev.target.dataset.closeid) return;
      activeNavId = t.id;
      activeTag = t.tag || null;
      switchView(t.view);
      navMenuOpen = false;
      render();
    });
    nav.appendChild(a);
  });
  const addBtn = document.createElement("div");
  addBtn.className = "tab ghost no-drag";
  addBtn.textContent = "+ tab";
  addBtn.addEventListener("click", addCustomView);
  nav.appendChild(addBtn);

  nav.querySelectorAll("[data-closeid]").forEach((x) => {
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeCustomView(x.dataset.closeid);
    });
  });

  const current = ordered.find((t) => t.id === activeNavId);
  const toggle = document.getElementById("navMenuToggle");
  document.getElementById("navMenuLabel").textContent = current ? current.label : "Menu";
  nav.classList.toggle("open", navMenuOpen);
  toggle.classList.toggle("open", navMenuOpen);
  toggle.setAttribute("aria-expanded", String(navMenuOpen));
}

function addCustomView() {
  const label = prompt("New tab name:");
  if (!label || !label.trim()) return;
  const tagInput = prompt("Show entries tagged (no #):", "");
  if (!tagInput || !tagInput.trim()) return;
  const tag = tagInput.trim().toLowerCase().replace(/\s+/g, "-");
  colorFor(tag);
  const id = "view-" + newId();
  customViews.push({ id, label: label.trim(), tag });
  saveViews(customViews);
  activeNavId = id;
  activeTag = tag;
  switchView("board");
  render();
}
function removeCustomView(id) {
  customViews = customViews.filter((v) => v.id !== id);
  saveViews(customViews);
  if (activeNavId === id) {
    activeNavId = "everything";
    activeTag = null;
    switchView("board");
  }
  render();
}

document.getElementById("search").addEventListener("input", (ev) => {
  searchQuery = ev.target.value.trim().toLowerCase();
  render();
});

// ── capture modal ────────────────────────────────────────────────────
const backdrop = document.getElementById("modalBackdrop");
const mBody = document.getElementById("mBody");
const mType = document.getElementById("mType");
const mTitle = document.getElementById("mTitle");
const mTags = document.getElementById("mTags");
const mDue = document.getElementById("mDue");
const mPin = document.getElementById("mPin");
const mHabitRow = document.getElementById("mHabitRow");
const mHabitTarget = document.getElementById("mHabitTarget");

function openModal(presetType) {
  backdrop.classList.add("on");
  mBody.value = ""; mTitle.value = ""; mTags.value = ""; mDue.value = ""; mPin.checked = false;
  mType.value = presetType || "note";
  mHabitRow.style.display = mType.value === "habit" ? "flex" : "none";
  mHabitTarget.value = 3;
  mBody.focus();
}
function closeModal() {
  backdrop.classList.remove("on");
}
document.getElementById("captureBtn").addEventListener("click", () => openModal());
document.getElementById("mCancel").addEventListener("click", closeModal);
backdrop.addEventListener("click", (ev) => { if (ev.target === backdrop) closeModal(); });
mType.addEventListener("change", () => {
  mHabitRow.style.display = mType.value === "habit" ? "flex" : "none";
});

document.getElementById("mSave").addEventListener("click", () => {
  const body = mBody.value.trim();
  if (!body) { closeModal(); return; }
  const tags = mTags.value.split(/[\s,]+/).map((t) => t.replace(/^#/, "").toLowerCase()).filter(Boolean);
  const partial = {
    type: mType.value,
    title: mTitle.value.trim(),
    body,
    tags: tags.length ? tags : [mType.value === "note" ? "todo" : mType.value],
    dueAt: mDue.value || null,
    pinned: mPin.checked,
  };
  if (mType.value === "habit") {
    partial.weeklyTarget = parseInt(mHabitTarget.value, 10) || 3;
    partial.checkins = [];
  }
  addEntry(partial);
  closeModal();
  render();
});

// ── login form ───────────────────────────────────────────────────────
document.getElementById("loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) errEl.textContent = error.message;
});
document.getElementById("signoutBtn").addEventListener("click", () => db.auth.signOut());
// Just flips a class + the remembered flag — no render() needed, so opening the mobile nav
// menu is instant and doesn't touch anything else on the board.
document.getElementById("navMenuToggle").addEventListener("click", () => {
  navMenuOpen = !navMenuOpen;
  const nav = document.getElementById("nav");
  const toggle = document.getElementById("navMenuToggle");
  nav.classList.toggle("open", navMenuOpen);
  toggle.classList.toggle("open", navMenuOpen);
  toggle.setAttribute("aria-expanded", String(navMenuOpen));
});
document.getElementById("sketchOverlayDone").addEventListener("click", closeSketchOverlay);

// ── boot ─────────────────────────────────────────────────────────────
drawBand();
addEventListener("resize", drawBand);
addEventListener("resize", packBoard);
(function setDatestamp() {
  const d = new Date();
  const wd = d.toLocaleDateString("en-US", { weekday: "short" });
  const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  document.getElementById("datestamp").textContent = `${wd} · ${md} · ${d.getFullYear()}`;
})();
document.getElementById("board").addEventListener("click", (ev) => {
  const t = ev.target.closest("[data-tag]");
  if (!t) return;
  const tag = t.dataset.tag;
  activeTag = activeTag === tag ? null : tag;
  render();
});
enableDragReorder(document.getElementById("board"), {
  itemSelector: ".card",
  handleSelector: ".grip",
  axis: "y",
  onReorder: saveBoardOrder,
});
enableDragReorder(document.getElementById("nav"), {
  itemSelector: ".tab",
  axis: "x",
  onReorder: saveNavOrder,
});
if ("serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

(async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (session) await onAuthed(session.user);
  else showLogin();

  db.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" && session && currentUser?.id !== session.user.id) onAuthed(session.user);
    if (event === "SIGNED_OUT") showLogin();
  });
})();
