/* ── Commonplace ──────────────────────────────────────────────────────
   Everything board + capture + manual tags + checkboxes + habits + drag
   reorder + custom tabs, persisted to Supabase (see config.js for the
   project URL/key). Single-user, gated behind Supabase Auth email/password.
   Entries table: id, createdAt, type, title, body, tags[], dueAt, done,
   doneAt, pinned, source, weeklyTarget, checkins[] (see supabase-schema.sql).
   ──────────────────────────────────────────────────────────────────── */

const COLOR_ROTATION = ["butter", "sage", "peri", "lilac", "rose", "cyan"];
const DAY = 86400000;

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
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  e.checkins = e.checkins || [];
  const t = todayIso();
  const i = e.checkins.indexOf(t);
  if (i >= 0) e.checkins.splice(i, 1);
  else e.checkins.push(t);
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
let sketchModeTaskIds = new Set(); // of expandedTaskIds, which are showing the canvas instead of the bullet textarea
let editingSketchIds = new Set(); // diary entries currently showing their canvas
function anySketchEditingOpen() {
  if (editingSketchIds.size) return true;
  for (const id of sketchModeTaskIds) if (expandedTaskIds.has(id)) return true;
  return false;
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
  // Default to sketch mode when reopening a task whose only content is ink (no bullet text yet).
  const sketching = editing && (sketchModeTaskIds.has(e.id) || (hasInk(e) && !(e.title && e.title.trim())));
  const inPaperMode = sketching || hasInk(e);
  // A sketched task's whole card is paper too — same reasoning as diary, no box-behind-paper.
  const card = makeCard(inPaperMode ? `sketch-card ${paperClassOf(e.drawing)}` : "postit");
  let detail;
  if (editing && sketching) {
    detail = `<div class="sketchpad-wrap"><canvas class="sketchpad" style="height:${sketchCanvasHeight(e.type, e.drawing)}px" data-sketch="${e.id}"></canvas>
      ${penToolbarHtml(e.id)}
      <div class="sketch-toolbar">
        <button type="button" class="sketch-btn" data-sketch-undo="${e.id}">undo</button>
        <button type="button" class="sketch-btn" data-sketch-clear="${e.id}">clear</button>
        <button type="button" class="sketch-btn" data-mode-toggle="${e.id}">Aa type instead</button>
        <button type="button" class="sketch-btn" data-sketch-done="${e.id}">done</button>
      </div></div>`;
  } else if (editing) {
    detail = `<textarea class="postit-editor" data-detail-input="${e.id}" placeholder="– one point per line…">${escapeHtml(e.title || "")}</textarea>
      <button type="button" class="sketch-btn mode-switch" data-mode-toggle="${e.id}">✎ draw instead</button>`;
  } else if (hasInk(e)) {
    detail = `<div class="postit-bullets-wrap" data-detail-toggle="${e.id}">${renderStaticImage(e.drawing, "sketch-view")}</div>`;
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
  card.querySelectorAll("[data-mode-toggle]").forEach((el) => el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (sketchModeTaskIds.has(e.id)) sketchModeTaskIds.delete(e.id);
    else { sketchModeTaskIds.add(e.id); if (!e.drawing) e.drawing = { w: 0, h: 0, strokes: [], ...randomDrawingMeta() }; }
    render();
  }));
  card.querySelectorAll("[data-sketch-done]").forEach((el) => el.addEventListener("click", (ev) => {
    ev.stopPropagation();
    expandedTaskIds.delete(e.id);
    sketchModeTaskIds.delete(e.id);
    render();
  }));
  if (editing && sketching) {
    wirePenToolbar(card);
    const canvas = card.querySelector("canvas.sketchpad");
    const ctl = initSketchpad(canvas, e.drawing, (d) => updateEntryDrawing(e.id, d), () => revealPenPicker(card, e.id));
    card.querySelector("[data-sketch-undo]").addEventListener("click", (ev) => { ev.stopPropagation(); ctl.undo(); });
    card.querySelector("[data-sketch-clear]").addEventListener("click", (ev) => { ev.stopPropagation(); ctl.clear(); });
  }
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
    const sketching = editingSketchIds.has(e.id);
    const inPaperMode = sketching || hasInk(e);
    // A sketch's whole card IS the paper — date/tags sit directly on it, no card-behind-paper box.
    const card = makeCard("diary" + (inPaperMode ? ` sketch-card ${paperClassOf(e.drawing)}` : ""));
    card.dataset.entryId = e.id;
    let body;
    if (sketching) {
      body = `<div class="sketchpad-wrap"><canvas class="sketchpad" style="height:${sketchCanvasHeight(e.type, e.drawing)}px" data-sketch="${e.id}"></canvas>
        ${penToolbarHtml(e.id)}
        <div class="sketch-toolbar">
          <button type="button" class="sketch-btn" data-sketch-undo="${e.id}">undo</button>
          <button type="button" class="sketch-btn" data-sketch-clear="${e.id}">clear</button>
          <button type="button" class="sketch-btn" data-sketch-done="${e.id}">done</button>
        </div></div>`;
    } else if (hasInk(e)) {
      body = renderStaticImage(e.drawing, "sketch-view");
    } else {
      body = `<p>${escapeHtml(e.body)}</p>`;
    }
    card.innerHTML =
      `<div class="meta"><span>${dateStr}</span><span class="tags">${e.tags.map((t) => tagSpan(t)).join(" ")}` +
      `<span class="boxclose" data-addtag="${e.id}" title="add tag">+</span>` +
      `<span class="boxclose" data-sketch-toggle="${e.id}" title="${sketching ? "cancel drawing" : "draw"}">${sketching ? "Aa" : "✎"}</span>` +
      `<span class="boxclose" data-del="${e.id}" title="delete">✕</span></span></div>` +
      (e.title ? `<h2>${escapeHtml(e.title)}</h2>` : "") +
      body;
    card.querySelectorAll("[data-del]").forEach((x) => x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteEntry(x.dataset.del);
    }));
    wireAddTag(card);
    card.querySelectorAll("[data-sketch-toggle]").forEach((x) => x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (editingSketchIds.has(e.id)) editingSketchIds.delete(e.id);
      else { editingSketchIds.add(e.id); if (!e.drawing) e.drawing = { w: 0, h: 0, strokes: [], ...randomDrawingMeta() }; }
      render();
    }));
    card.querySelectorAll("[data-sketch-done]").forEach((x) => x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      editingSketchIds.delete(e.id);
      render();
    }));
    if (sketching) {
      wirePenToolbar(card);
      const canvas = card.querySelector("canvas.sketchpad");
      const ctl = initSketchpad(canvas, e.drawing, (d) => updateEntryDrawing(e.id, d), () => revealPenPicker(card, e.id));
      card.querySelector("[data-sketch-undo]").addEventListener("click", (ev) => { ev.stopPropagation(); ctl.undo(); });
      card.querySelector("[data-sketch-clear]").addEventListener("click", (ev) => { ev.stopPropagation(); ctl.clear(); });
    }
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
function renderStaticImage(drawing, cls) {
  if (!drawing || !drawing.strokes || !drawing.strokes.length) return "";
  const dpr = 2;
  const w = drawing.w || 300, h = drawing.h || 200;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  const ctx = c.getContext("2d");
  ctx.scale(dpr, dpr);
  drawing.strokes.map(normalizeStroke).forEach((s) => paintStroke(ctx, s));
  return `<img class="${cls}" src="${c.toDataURL()}" width="${w}" height="${h}" alt=""/>`;
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
  return {
    undo() { strokes.pop(); redraw(); drawing.strokes = strokes; onChange(drawing); },
    clear() { strokes = []; redraw(); drawing.strokes = strokes; onChange(drawing); },
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
      dueSet[d] = dueSet[d] || colorFor(e.tags[0] || "todo");
    }
  });

  let cells = [];
  for (let i = startDow - 1; i >= 0; i--) cells.push({ n: prevDays - i, dim: true });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = new Date(y, m, d).toISOString().slice(0, 10);
    const isToday = daysBetween(todayStart(), new Date(y, m, d)) === 0;
    cells.push({ n: d, today: isToday, dot: dueSet[iso] });
  }
  let next = 1;
  while (cells.length % 7 !== 0) cells.push({ n: next++, dim: true });

  let rows = "";
  for (let i = 0; i < cells.length; i += 7) {
    rows += "<tr>" + cells.slice(i, i + 7).map((c) =>
      `<td class="${c.dim ? "dim" : ""}${c.today ? " today" : ""}">${c.n}${c.dot ? `<div class="dot ${c.dot}"></div>` : ""}</td>`
    ).join("") + "</tr>";
  }

  const card = makeCard("graph" + (large ? " wide big-cal" : ""));
  card.innerHTML =
    `<div class="meta"><span>${monthName}</span><span class="tags"><span class="tag peri">#calendar</span></span></div>` +
    `<table class="cal"><tr><th>S</th><th>M</th><th>T</th><th>W</th><th>T</th><th>F</th><th>S</th></tr>${rows}</table>`;
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
    const commit = () => {
      const val = input.value.trim();
      if (val) addEntry(Object.assign({ body: val }, ctx));
      render();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") commit();
      if (ev.key === "Escape") render();
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
    const addSketchTile = makeCard("mini addbox");
    addSketchTile.innerHTML = `<div class="meta"><span>+ new sketch</span></div>`;
    addSketchTile.addEventListener("click", () => {
      const e = addEntry({ type: "diary", drawing: { w: 0, h: 0, strokes: [], ...randomDrawingMeta() } });
      editingSketchIds.add(e.id);
      render();
    });
    list.push({ id: "add-diary-sketch", el: addSketchTile });
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
  } else {
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
];
let activeNavId = "everything";

function switchView(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("on"));
  document.getElementById("v-" + view).classList.add("on");
}

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

function openModal() {
  backdrop.classList.add("on");
  mBody.value = ""; mTitle.value = ""; mTags.value = ""; mDue.value = ""; mPin.checked = false;
  mType.value = "note";
  mHabitRow.style.display = "none";
  mHabitTarget.value = 3;
  mBody.focus();
}
function closeModal() {
  backdrop.classList.remove("on");
}
document.getElementById("captureBtn").addEventListener("click", openModal);
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
