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
    box_id: e.boxId ?? null,
  };
}
function fromDbRow(r) {
  const e = {
    id: r.id, createdAt: r.created_at, type: r.type, title: r.title || "", body: r.body || "",
    tags: r.tags || [], dueAt: r.due_at, done: r.done, doneAt: r.done_at, pinned: r.pinned,
    boxId: r.box_id || null,
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

// ── task boxes (mood-board Tasks tab) ─────────────────────────────────
const UNSORTED_BOX = "_unsorted";
let expandedTaskIds = new Set();
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
      render();
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
  return !!(e.title && e.title.trim());
}
function taskRowHtml(e) {
  const due = fmtDue(e);
  const end = due ? `<span class="${due.cls}">${due.text}</span>` : "";
  const expanded = expandedTaskIds.has(e.id);
  return `<div class="taskrow">
      <div class="row${e.done ? " done" : ""}" data-id="${e.id}">
        <div class="box"></div><span class="txt" data-detail-toggle="${e.id}">${escapeHtml(e.body)}</span>
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
  const card = makeCard("postit");
  const editing = expandedTaskIds.has(e.id);
  card.innerHTML =
    `<div class="meta"><span>Task</span><span class="boxclose" data-del="${e.id}" title="delete">✕</span></div>` +
    `<div class="row${e.done ? " done" : ""}" data-id="${e.id}"><div class="box"></div><span class="txt">${escapeHtml(e.body)}</span></div>` +
    (editing
      ? `<textarea class="postit-editor" data-detail-input="${e.id}" placeholder="– one point per line…">${escapeHtml(e.title || "")}</textarea>`
      : `<div class="postit-bullets-wrap" data-detail-toggle="${e.id}">${bulletListHtml(e.title)}</div>`);
  wireRows(card);
  wireTaskDetailInputs(card);
  card.querySelectorAll("[data-detail-toggle]").forEach((el) => el.addEventListener("click", () => {
    expandedTaskIds.add(e.id);
    render();
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
    items.map((e) => `<span class="scratch-line${e.done ? " strike" : ""}" data-id="${e.id}" style="cursor:pointer;${e.done ? "text-decoration:line-through;color:var(--soft);" : ""}">${escapeHtml(e.body)}</span>`).join("<br>") +
    `</div>` +
    addRowHtml("jot something…");
  card.querySelectorAll(".scratch-line").forEach((line) => {
    line.addEventListener("click", () => toggleDone(line.dataset.id));
  });
  wireAddRow(card, { type: "scratch", tags: ["loose"] });
  return card;
}

function diaryCards() {
  return entries.filter((e) => e.type === "diary" && matchesFilter(e)).map((e) => {
    const card = makeCard("diary");
    card.dataset.entryId = e.id;
    const date = new Date(e.createdAt);
    const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " + date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    card.innerHTML =
      `<div class="meta"><span>${dateStr}</span><span class="tags">${tagSpan("diary")}</span></div>` +
      (e.title ? `<h2>${escapeHtml(e.title)}</h2>` : "") +
      `<p>${escapeHtml(e.body)}</p>`;
    return card;
  });
}

function noteCards() {
  return entries.filter((e) => e.type === "note" && matchesFilter(e)).map((e) => {
    const primary = e.tags[0];
    const tint = ["sage", "lilac", "butter"].includes(primary) ? primary : "";
    const mini = !e.title && e.body.length < 90;
    const card = makeCard([tint, mini ? "mini" : ""].filter(Boolean).join(" "));
    card.dataset.entryId = e.id;
    const date = new Date(e.createdAt);
    const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const tagsHtml = e.tags.map((t) => tagSpan(t)).join(" ");
    card.innerHTML =
      `<div class="meta"><span>${dateStr}</span><span class="tags">${tagsHtml}</span></div>` +
      (e.title ? `<h2>${escapeHtml(e.title)}</h2>` : "") +
      `<p>${escapeHtml(e.body).replace(/\n/g, "<br>")}</p>`;
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

function calendarCard() {
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

  const card = makeCard("graph");
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
      if (row.dataset.habit) toggleHabitCheckin(row.dataset.id);
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
    list.push({ id: "calendar", el: calendarCard() });
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
  const cell = 2, w = cv.clientWidth, h = 32;
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

(async function boot() {
  const { data: { session } } = await db.auth.getSession();
  if (session) await onAuthed(session.user);
  else showLogin();

  db.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" && session && currentUser?.id !== session.user.id) onAuthed(session.user);
    if (event === "SIGNED_OUT") showLogin();
  });
})();
