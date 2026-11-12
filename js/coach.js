// Coach tab: the weekly refinement's focus, wins, goals and watch-outs. Loaded from a private file the
// review writes (coach-<date>.json); kept only on this phone (and in backups), like everything else.
import * as db from "./db.js";
import { weekInfo, parseDate } from "./plan.js";
import { esc, fmt, toast } from "./ui.js";

const KEY = "coachUpdates";

export function readCoach(text) {
  let c;
  try { c = JSON.parse(text); } catch { throw new Error("That file isn't a coach update."); }
  if (c?.app !== "gym-plan-coach" || !/^\d{4}-\d{2}-\d{2}$/.test(c.created ?? "") || !Array.isArray(c.focus)) {
    throw new Error("That file isn't a coach update.");
  }
  return c;
}

const updates = async () => (await db.getSetting(KEY, null)) ?? [];

async function saveUpdate(c) {
  const list = (await updates()).filter((u) => u.created !== c.created);
  list.push({ ...c, ticked: c.ticked ?? {} });
  list.sort((a, b) => (a.created < b.created ? -1 : 1));
  await db.setSetting(KEY, list);
}

// Targets the app can check from the logs. Returns { done, value } or null for ones ticked by hand.
function autoCheck(chk, logs) {
  if (!chk || chk.type === "manual") return null;
  const w = chk.week ? weekInfo(chk.week) : null;
  const sessions = logs.sessions.filter((s) => !chk.week || s.week === chk.week);
  const onDay = (s) => !chk.day || s.dayKey === chk.day;
  if (chk.type === "session") {
    const n = sessions.filter(onDay).length;
    return chk.count ? { done: n >= chk.count, value: `${n} of ${chk.count}` } : { done: n > 0, value: n ? "done" : "" };
  }
  if (chk.type === "item") {
    const done = sessions.filter(onDay).some((s) => s.items.some((it) => it.exercise === chk.exercise && it.status === "done"));
    return { done, value: done ? "done" : "" };
  }
  if (chk.type === "run_km") {
    const date = w && chk.day ? w.days[chk.day].date : null;
    const r = logs.runs.filter((x) => (date ? x.date === date : x.week === chk.week) && x.distanceKm != null)
      .sort((a, b) => b.distanceKm - a.distanceKm)[0];
    if (!r) return { done: false, value: "" };
    return { done: chk.min_km == null || r.distanceKm >= chk.min_km, value: `${r.distanceKm} km` };
  }
  if (chk.type === "lift") {
    let best = null;
    for (const s of sessions) {
      for (const it of s.items.filter((x) => x.exercise === chk.exercise)) {
        for (const st of it.sets.filter((x) => x.done && x.kg != null)) {
          if (!best || st.kg > best.kg || (st.kg === best.kg && (st.reps ?? 0) > (best.reps ?? 0))) best = st;
        }
      }
    }
    if (!best) return { done: false, value: "" };
    return { done: best.kg >= chk.kg && (chk.reps == null || (best.reps ?? 0) >= chk.reps), value: `${best.kg} kg × ${best.reps ?? "–"}` };
  }
  return null;
}

function goalTile(g) {
  return `<div class="goal ${g.achieved ? "achieved" : ""}"><div class="g-title">${g.achieved ? "✓ " : ""}${esc(g.label)}</div>
    <div class="g-row"><span>Start</span><b>${esc(g.start ?? "–")}</b></div>
    <div class="g-row"><span>Now</span><b>${esc(g.now ?? "–")}</b></div>
    <div class="g-row"><span>Target</span><b>${esc(g.target ?? "–")}</b></div>
    ${g.note ? `<div class="muted small">${esc(g.note)}</div>` : ""}</div>`;
}

let viewing = null;  // created date of an older update being viewed, or null for the latest

export async function renderCoach($screen) {
  const list = await updates();
  const loadBtn = (label) => `<label class="btn ${list.length ? "ghost" : ""} filebtn">${label}
    <input type="file" accept="application/json,.json" id="coach-file" hidden></label>`;
  if (!list.length) {
    $screen.innerHTML = `<h1>Coach</h1><div class="card empty">
      <p><b>Your weekly coach update shows here.</b></p>
      <p class="small">After each refinement review, a file called <b>coach-&lt;date&gt;.json</b> is saved to OneDrive
      (the <b>Refinement reports</b> folder). Tap below and pick it. It stays on this phone.</p>
      ${loadBtn("Load coach update")}</div>`;
    bindFile($screen);
    return;
  }
  const c = list.find((u) => u.created === viewing) ?? list[list.length - 1];
  const logs = {
    sessions: (await db.all("sessions")).filter((s) => s.status === "finished"),
    runs: (await db.all("runs")).filter((r) => r.status === "finished"),
  };
  const focus = c.focus.map((f) => {
    const auto = autoCheck(f.check, logs);
    const done = auto ? auto.done : !!c.ticked?.[f.id];
    const box = auto
      ? `<span class="tick ${done ? "on" : ""}" aria-label="${done ? "Done" : "Not yet"}">${done ? "✓" : ""}</span>`
      : `<button type="button" class="tick ${done ? "on" : ""}" data-coach="tick" data-id="${esc(f.id)}" aria-pressed="${done}" aria-label="Tick ${esc(f.text)}">${done ? "✓" : ""}</button>`;
    return `<div class="focus ${done ? "done" : ""}">${box}<div><b>${esc(f.text)}</b>
      ${auto?.value ? `<span class="badge ${done ? "ok" : "skip"}">${esc(auto.value)}</span>` : ""}
      ${f.why ? `<div class="muted small">${esc(f.why)}</div>` : ""}
      ${auto ? `<div class="muted small">Ticks itself from your logs</div>` : ""}</div></div>`;
  }).join("");
  const doneN = c.focus.filter((f) => { const a = autoCheck(f.check, logs); return a ? a.done : c.ticked?.[f.id]; }).length;
  const older = list.length > 1 ? `<details class="card"><summary><b>Earlier updates</b></summary>
      ${[...list].reverse().map((u) => `<button type="button" class="linkbtn" data-coach="view" data-created="${u.created}" style="display:block;margin:6px 0">
        ${u.created === c.created ? "▸ " : ""}Week ${esc(u.week ?? "–")} · ${fmt(parseDate(u.created), { day: "numeric", month: "short" })}</button>`).join("")}</details>` : "";
  $screen.innerHTML = `<h1>Coach</h1>
    <p class="muted small">Week ${esc(c.week ?? "–")} · review of ${fmt(parseDate(c.created), { weekday: "long", day: "numeric", month: "long" })}
      ${c !== list[list.length - 1] ? ` · <button type="button" class="linkbtn" data-coach="latest">Show latest</button>` : ""}</p>
    ${c.note ? `<div class="card coachnote">${esc(c.note)}</div>` : ""}
    <h2>This week's focus <span class="muted small">${doneN} of ${c.focus.length}</span></h2>
    <div class="card">${focus || `<p class="muted">No targets this week.</p>`}</div>
    ${c.wins?.length ? `<h2>Wins</h2>${c.wins.map((w) => `<div class="win">🎉 ${esc(w.text)}${w.detail ? `<div class="small" style="font-weight:400">${esc(w.detail)}</div>` : ""}</div>`).join("")}` : ""}
    ${c.watch?.length ? `<h2>Watch-outs</h2>${c.watch.map((w) => `<div class="light ${w.level === "info" ? "g" : "a"}">${esc(w.text)}</div>`).join("")}` : ""}
    ${c.goals?.length ? `<h2>Goal progress</h2><div class="goals">${c.goals.map(goalTile).join("")}</div>` : ""}
    ${c.pdf ? `<p class="muted small">Full report with charts: ${esc(c.pdf)}</p>` : ""}
    ${older}
    ${loadBtn("Load a new coach update")}`;
  bindFile($screen);
}

function bindFile($screen) {
  $screen.querySelector("#coach-file")?.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const c = readCoach(await f.text());
      await saveUpdate(c);
      viewing = null;
      toast("Coach update loaded");
    } catch (err) {
      toast(err.message, "bad");
    }
    renderCoach($screen);
  });
}

export function bindCoach($screen, isActive) {
  $screen.addEventListener("click", async (e) => {
    if (!isActive()) return;
    const b = e.target.closest("[data-coach]");
    if (!b) return;
    const act = b.dataset.coach;
    if (act === "tick") {
      const list = await updates();
      const c = list.find((u) => u.created === viewing) ?? list[list.length - 1];
      c.ticked = { ...c.ticked, [b.dataset.id]: !c.ticked?.[b.dataset.id] };
      await db.setSetting(KEY, list);
    } else if (act === "view") viewing = b.dataset.created;
    else if (act === "latest") viewing = null;
    renderCoach($screen);
  });
}
