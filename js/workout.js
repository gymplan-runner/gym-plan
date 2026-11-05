// Gym session logging: sets, timed holds, cardio, rest timer, autosave, resume and finish.
import * as db from "./db.js";
import { getPlan, sessionFor, picto, doseText, DAY_COLOURS, LEG_WORK } from "./plan.js";
import { esc, toast, celebrate, num, mmss } from "./ui.js";
import { beep, unlockAudio } from "./beep.js";

const TIMED = new Set(["plank", "side_plank", "farmer_carry"]);
const CARDIO = new Set(["bike", "treadmill_run", "cross_trainer", "swim", "sauna"]);
const MACHINES = new Set(["leg_press", "leg_extension", "leg_curl", "chest_press", "seated_row", "lat_pulldown",
  "shoulder_press", "cable_knee_drive"]);
const REST_DEFAULT = 90;

export const gymId = (plannedDate) => `gym-${plannedDate}`;

// "bodyweight" exercises log reps only (kg can be added); the plan can override per session (e.g. "weights").
const loadOf = (item) => item.load ?? getPlan().exercises[item.exercise]?.load ?? "weights";

function newItem(it) {
  const type = CARDIO.has(it.exercise) ? "cardio" : TIMED.has(it.exercise) ? "timed" : "strength";
  const planned = { sets: it.sets ?? null, reps: it.reps ?? null, seconds: it.seconds ?? null,
    minutes: it.minutes ?? null, per_side: !!it.per_side, optional: !!it.optional, note: it.note ?? null,
    run: it.run ?? null, dose: doseText(it) };
  const minutes = type === "cardio" ? (it.run ? it.run.run_total_min : parseInt(it.minutes, 10) || null) : null;
  const sets = type === "cardio" ? [] : Array.from({ length: it.sets || 1 }, () => ({ kg: null, reps: null, seconds: null, done: false }));
  return { exercise: it.exercise, type, load: loadOf(it), planned, sets, minutes, status: "todo", rir: null, pain: null, note: "", setting: "" };
}

// Heaviest weight lifted in a past record of an exercise, or null.
function heaviest(rec) {
  const kgs = (rec?.sets ?? []).filter((x) => x.done && x.kg != null).map((x) => x.kg);
  return kgs.length ? Math.max(...kgs) : null;
}

// Start each set at last time's working weight, so it isn't done from memory. Prefer the same day's session
// (Friday's leg press is lighter than Monday's); with no same-day record, skip items the plan marks lighter.
async function prefillWeights(s) {
  const { sameDay, any } = await lastTimes(s.date, s.dayKey);
  for (const item of s.items) {
    if (item.type !== "strength") continue;
    const kg = heaviest(sameDay[item.exercise]) ?? (/lighter/i.test(item.planned.note ?? "") ? null : heaviest(any[item.exercise]));
    if (kg == null || (item.load === "bodyweight" && kg <= 0)) continue;
    for (const st of item.sets) st.kg = kg;
    if (item.load === "bodyweight") item.addKg = true;
  }
}

export async function getOrCreateSession(week, dayKey, plannedDate, performedOn) {
  const id = gymId(plannedDate);
  const existing = await db.get("sessions", id);
  if (existing) return existing;
  const plan = sessionFor(week, dayKey);
  const s = { id, kind: "gym", date: plannedDate, performedOn, week, dayKey, title: plan.title,
    status: "in_progress", startedAt: Date.now(), items: plan.items.map(newItem) };
  for (const item of s.items) item.setting = (await db.getSetting(`setting:${item.exercise}`, "")) || "";
  await prefillWeights(s);
  await db.put("sessions", s);
  return s;
}

// Most recent finished record of each exercise (from an earlier session): from any day, and from the same weekday slot.
async function lastTimes(beforeDate, dayKey) {
  const sessions = (await db.all("sessions"))
    .filter((s) => s.kind === "gym" && s.status === "finished" && s.date < beforeDate)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const any = {}, sameDay = {};
  for (const s of sessions) {
    for (const it of s.items) {
      if (it.status === "skipped" || !it.sets.some((x) => x.done)) continue;
      if (!any[it.exercise]) any[it.exercise] = { ...it, date: s.date };
      if (s.dayKey === dayKey && !sameDay[it.exercise]) sameDay[it.exercise] = { ...it, date: s.date };
    }
  }
  return { any, sameDay };
}

function topOfRange(reps) {
  const m = String(reps ?? "").match(/(\d+)\D*$/);
  return m ? Number(m[1]) : null;
}

function lastLine(last, type) {
  if (!last) return "";
  const done = last.sets.filter((x) => x.done);
  if (type === "timed") return `Last time: ${done.map((x) => `${x.seconds ?? "–"}s`).join(", ")}`;
  const reps = done.map((x) => x.reps ?? "–").join(", ");
  if (!done.some((x) => x.kg > 0)) return `Last time: ${reps} reps`;
  const kgs = [...new Set(done.map((x) => x.kg ?? "–"))];
  return `Last time: ${kgs.join("/")} kg × ${reps}`;
}

function progressionHint(last, item) {
  if (!last || item.type !== "strength") return "";
  const top = topOfRange(item.planned.reps);
  const done = last.sets.filter((x) => x.done);
  if (!top || !done.length || done.length < last.sets.length) return "";
  const allTop = done.every((x) => (x.reps ?? 0) >= top);
  const rirOk = last.rir === "2" || last.rir === "3" || last.rir === "4+";
  return allTop && rirOk ? "You hit the top of the range last time with reps to spare. Consider the smallest weight step today – your call." : "";
}

// ------------------------------------------------------------------ view
export function createWorkoutView({ $screen, $tabs, onExit, onRun }) {
  let S, last = {}, open = null, pendingOpen = null, rest = null, restTimer = null, clock = null, stopwatch = null, wakeLock = null, finishing = false;

  async function save() {
    try { await db.put("sessions", S); } catch { toast("Couldn't save – try again", "bad"); }
  }

  async function start(session) {
    S = session;
    const lt = await lastTimes(S.date, S.dayKey);
    last = { ...lt.any, ...lt.sameDay };  // the same weekday's record wins (Friday's leg press is lighter)
    open = pendingOpen ?? S.items.findIndex((i) => i.status === "todo");
    pendingOpen = null;
    if (open < 0) open = null;
    finishing = false;
    $tabs.hidden = true;
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* not supported */ }
    clock = setInterval(updateClock, 15000);
    render();
  }

  function suspend() {
    clearInterval(clock); clearInterval(restTimer); clearInterval(stopwatch?.timer);
    rest = null; stopwatch = null;
    wakeLock?.release?.().catch(() => {});
    S = null;
  }

  function leave() {
    suspend();
    $tabs.hidden = false;
    onExit();
  }

  function updateClock() {
    const el = document.getElementById("elapsed");
    if (el && S.status === "in_progress") el.textContent = `${Math.round((Date.now() - S.startedAt) / 60000)} min`;
  }

  const colour = () => DAY_COLOURS[S.dayKey];
  const doneCount = () => S.items.filter((i) => i.status !== "todo").length;

  function chips(name, idx, values, selected, labels = {}) {
    return `<div class="chips" role="group">${values.map((v) =>
      `<button type="button" class="chip ${String(selected) === String(v) ? "on" : ""}" data-act="${name}" data-i="${idx}" data-v="${v}"
        aria-pressed="${String(selected) === String(v)}">${labels[v] ?? v}</button>`).join("")}</div>`;
  }

  function setRows(item, i) {
    if (item.exercise === "treadmill_run" && item.planned.run) {
      return `<button type="button" class="btn" data-act="runtimer" data-i="${i}">▶ ${item.runId ? "Open run log" : "Start run timer"}</button>
        ${item.runId ? `<p class="muted small">Logged: ${item.minutes ?? "–"} min running.</p>` : `<p class="muted small">Or type the minutes if you didn't use the timer:</p>`}
        <div class="setrow"><span>Running minutes</span>
        <input class="in" inputmode="decimal" data-field="minutes" data-i="${i}" value="${item.minutes ?? ""}" aria-label="Running minutes"></div>`;
    }
    if (item.type === "cardio") {
      const label = item.exercise === "treadmill_run" ? "Running minutes" : "Minutes";
      return `<div class="setrow"><span>${label}</span>
        <input class="in" inputmode="decimal" data-field="minutes" data-i="${i}" value="${item.minutes ?? ""}" aria-label="${label}"></div>`;
    }
    // Bodyweight moves log reps only, unless a weight is added (or was logged before).
    const kgBox = item.type === "strength" && (loadOf(item) !== "bodyweight" || item.addKg || item.sets.some((x) => x.kg > 0));
    const rows = item.sets.map((st, j) => {
      const fields = item.type === "timed"
        ? `<input class="in" inputmode="numeric" data-field="seconds" data-i="${i}" data-j="${j}" value="${st.seconds ?? ""}" placeholder="sec" aria-label="Set ${j + 1} seconds">
           <button type="button" class="sw" data-act="stopwatch" data-i="${i}" data-j="${j}">${stopwatch && stopwatch.i === i && stopwatch.j === j ? "Stop" : "⏱"}</button>`
        : `${kgBox ? `<input class="in" inputmode="decimal" data-field="kg" data-i="${i}" data-j="${j}" value="${st.kg ?? ""}" placeholder="kg" aria-label="Set ${j + 1} kg">` : ""}
           <input class="in" inputmode="numeric" data-field="reps" data-i="${i}" data-j="${j}" value="${st.reps ?? ""}" placeholder="${esc(String(item.planned.reps ?? "reps"))}" aria-label="Set ${j + 1} reps">`;
      return `<div class="setrow ${st.done ? "done" : ""}"><span>Set ${j + 1}</span>${fields}
        <button type="button" class="tickbtn" data-act="tick" data-i="${i}" data-j="${j}" aria-label="Set ${j + 1} done" aria-pressed="${st.done}">${st.done ? "✓" : "○"}</button></div>`;
    }).join("");
    const addKg = item.type === "strength" && !kgBox
      ? `<button type="button" class="linkbtn" data-act="addkg" data-i="${i}">+ Add weight (holding a dumbbell?)</button>` : "";
    return rows + addKg;
  }

  function card(item, i) {
    const ex = getPlan().exercises[item.exercise];
    const isOpen = open === i;
    const badge = item.status === "done" ? `<span class="badge ok">✓ Done</span>` : item.status === "skipped" ? `<span class="badge skip">Skipped</span>` : "";
    const head = `<button type="button" class="ex-head" data-act="toggle" data-i="${i}" aria-expanded="${isOpen}">
      <span class="pic-wrap">${picto(item.exercise, colour(), "pic")}</span>
      <span class="txt"><span class="name">${esc(ex.name)}${item.planned.optional ? ' <span class="tag">optional</span>' : ""}</span>
      <span class="dose">${esc(item.planned.dose)}</span></span>${badge}</button>`;
    if (!isOpen) return `<div class="ex ${item.status}">${head}</div>`;
    const lt = last[item.exercise];
    const hint = progressionHint(lt, item);
    const how = `<details class="how"><summary>How to do it</summary><p class="muted small">${esc(ex.equipment)}</p>
      <ol>${ex.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>${ex.tips.map((t) => `<p class="tip">✓ ${esc(t)}</p>`).join("")}</details>`;
    const setting = MACHINES.has(item.exercise)
      ? `<label class="mini">Machine / seat setting<input class="in wide" data-field="setting" data-i="${i}" value="${esc(item.setting)}" placeholder="e.g. seat 4, back pad 2"></label>` : "";
    const rir = item.type === "strength"
      ? `<p class="q">Reps left in the tank? <span class="muted small">(how many more good reps you could have done – aim for 2–3)</span></p>
         ${chips("rir", i, ["0", "1", "2", "3", "4+"], item.rir)}` : "";
    const pain = LEG_WORK.has(item.exercise)
      ? `<p class="q">Quad pain during (0–10)</p>${chips("pain", i, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], item.pain)}` : "";
    return `<div class="ex open ${item.status}">${head}<div class="ex-body">
      ${item.planned.note ? `<p class="note">${esc(item.planned.note)}</p>` : ""}
      <p class="cue">${esc(ex.cue ?? "")}</p>${how}
      ${lt ? `<p class="last">${esc(lastLine(lt, item.type))}${lt.setting ? ` · setting ${esc(lt.setting)}` : ""}</p>` : `<p class="last muted">First time – start light.</p>`}
      ${hint ? `<p class="hint">💡 ${esc(hint)}</p>` : ""}
      ${setting}${setRows(item, i)}${rir}${pain}
      <input class="in wide" data-field="note" data-i="${i}" value="${esc(item.note)}" placeholder="Note (optional)" aria-label="Note">
      <div class="row2"><button type="button" class="btn ghost" data-act="skip" data-i="${i}">${item.status === "skipped" ? "Undo skip" : "Skip"}</button>
      <button type="button" class="btn" data-act="done" data-i="${i}">${item.status === "done" ? "Done ✓" : "Mark done"}</button></div>
    </div></div>`;
  }

  function render() {
    if (finishing) return renderFinish();
    const total = S.items.length;
    const editing = S.status === "finished";
    $screen.innerHTML = `
      <div class="wk-top" style="background:${colour()}">
        <button type="button" class="back" data-act="exit">‹ Today</button>
        <h1>${esc(S.title)}</h1>
        <p>${editing ? "Editing a finished session" : `<span id="elapsed">${Math.round((Date.now() - S.startedAt) / 60000)} min</span>`} · ${doneCount()} of ${total} done</p>
      </div>
      <div class="exlist">${S.items.map(card).join("")}</div>
      <button type="button" class="btn finish" data-act="finish">${editing ? "Save changes" : "Finish workout"}</button>
      <button type="button" class="linkbtn" data-act="discard">${editing ? "Delete this session" : "Discard this workout"}</button>
      ${rest ? `<div class="restbar" role="timer"><span>Rest <b id="restleft">${mmss(rest.left)}</b></span>
        <button type="button" data-act="rest-" aria-label="15 seconds less">−15</button><button type="button" data-act="rest+" aria-label="15 seconds more">+15</button>
        <button type="button" data-act="restskip">Skip</button></div>` : ""}`;
  }

  function startRest() {
    clearInterval(restTimer);
    rest = { left: REST_DEFAULT };
    restTimer = setInterval(() => {
      rest.left -= 1;
      const el = document.getElementById("restleft");
      if (el) el.textContent = mmss(Math.max(0, rest.left));
      if (rest.left <= 0) { clearInterval(restTimer); rest = null; beep(2); render(); }
    }, 1000);
  }

  function renderFinish() {
    const done = S.items.filter((i) => i.status === "done").length;
    const skipped = S.items.filter((i) => i.status === "skipped").length;
    const effort = getPlan().effort_scale;
    const labels = {};
    for (const e of effort) {
      const [a, b] = e.range.replace("–", "-").split("-").map(Number);
      for (let v = a; v <= (b || a); v++) labels[v] = v;
    }
    const mins = S.status === "finished" ? S.durationMin : Math.round((Date.now() - S.startedAt) / 60000);
    $screen.innerHTML = `
      <div class="wk-top" style="background:${colour()}"><button type="button" class="back" data-act="unfinish">‹ Back to workout</button>
        <h1>Nice work 👏</h1><p>${esc(S.title)}</p></div>
      <div class="card">
        <p><b>${done}</b> done${skipped ? ` · ${skipped} skipped` : ""}${S.items.length - done - skipped ? ` · ${S.items.length - done - skipped} not marked` : ""} · about <b>${mins} min</b></p>
        <p class="q">How hard was the session overall? (1–10)</p>
        ${chips("effort", -1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], S.effort)}
        <p class="muted small" id="effortlabel">${esc(effortLabel(S.effort))}</p>
        <p class="q">Quad pain during the session (0–10, optional)</p>
        ${chips("spain", -1, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], S.painDuring)}
        ${light(S.painDuring)}
        <label class="mini">Notes<textarea class="in wide" data-field="snote" rows="3" placeholder="Anything to remember next time?">${esc(S.note ?? "")}</textarea></label>
        <button type="button" class="btn" data-act="confirm">${S.status === "finished" ? "Save changes" : "Save and finish"}</button>
      </div>`;
  }

  function effortLabel(v) {
    if (v == null) return "";
    const e = getPlan().effort_scale.find((x) => {
      const [a, b] = x.range.replace("–", "-").split("-").map(Number);
      return v >= a && v <= (b || a);
    });
    return e ? `${e.label}: ${e.feel}` : "";
  }

  function light(p) {
    if (p == null) return "";
    const tl = getPlan().traffic_light;
    if (p >= 5) return `<div class="light r"><b>Red</b> – ${esc(tl.red.meaning)}<br><span class="small">${getPlan().stop_and_seek_advice.map(esc).join("<br>")}</span></div>`;
    if (p >= 3) return `<div class="light a"><b>Amber</b> – ${esc(tl.amber.meaning)}</div>`;
    return `<div class="light g"><b>Green</b> – ${esc(tl.green.meaning)}</div>`;
  }

  async function onClick(e) {
    const b = e.target.closest("[data-act]");
    if (!b || !S) return;
    unlockAudio();
    const act = b.dataset.act, i = Number(b.dataset.i), j = Number(b.dataset.j);
    const item = S.items[i];
    switch (act) {
      case "exit": await save(); return leave();
      case "toggle": open = open === i ? null : i; break;
      case "runtimer": {
        await save();
        const session = S;
        suspend();
        return onRun(session, i);
      }
      case "tick": {
        const st = item.sets[j];
        const need = item.type === "timed" ? "seconds" : "reps";
        if (!st.done && st[need] == null) {
          toast(item.type === "timed" ? "Enter the seconds (or use ⏱) first" : "Enter your reps first");
          $screen.querySelector(`[data-field="${need}"][data-i="${i}"][data-j="${j}"]`)?.focus();
          return;
        }
        st.done = !st.done;
        if (st.done && j < item.sets.length - 1) startRest();
        if (item.sets.every((x) => x.done)) { clearInterval(restTimer); rest = null; }
        break;
      }
      case "stopwatch": {
        if (stopwatch && stopwatch.i === i && stopwatch.j === j) {
          clearInterval(stopwatch.timer);
          item.sets[j].seconds = Math.round((Date.now() - stopwatch.t0) / 1000);
          item.sets[j].done = true;
          stopwatch = null;
          if (j < item.sets.length - 1) startRest();
        } else {
          clearInterval(stopwatch?.timer);
          stopwatch = { i, j, t0: Date.now() };
          stopwatch.timer = setInterval(() => {
            const el = $screen.querySelector(`[data-field="seconds"][data-i="${i}"][data-j="${j}"]`);
            if (el) el.value = Math.round((Date.now() - stopwatch.t0) / 1000);
          }, 250);
          await save();
          render();
          return;
        }
        break;
      }
      case "addkg": item.addKg = true; break;
      case "rir": item.rir = item.rir === b.dataset.v ? null : b.dataset.v; break;
      case "pain": item.pain = item.pain === Number(b.dataset.v) ? null : Number(b.dataset.v); break;
      case "done":
        item.status = "done";
        if (item.type !== "cardio") for (const st of item.sets) if (st.reps != null || st.seconds != null) st.done = true;
        open = S.items.findIndex((x, k) => k > i && x.status === "todo");
        if (open < 0) open = null;
        break;
      case "skip": item.status = item.status === "skipped" ? "todo" : "skipped"; if (item.status === "skipped") open = null; break;
      case "rest-": if (rest) rest.left = Math.max(5, rest.left - 15); break;
      case "rest+": if (rest) rest.left += 15; break;
      case "restskip": clearInterval(restTimer); rest = null; break;
      case "finish": finishing = true; break;
      case "unfinish": finishing = false; break;
      case "effort": S.effort = S.effort === Number(b.dataset.v) ? null : Number(b.dataset.v); break;
      case "spain": S.painDuring = S.painDuring === Number(b.dataset.v) ? null : Number(b.dataset.v); break;
      case "confirm": {
        const first = S.status !== "finished";
        // Ticked sets count even if "Mark done" was forgotten.
        for (const it of S.items) if (it.status === "todo" && it.sets.some((x) => x.done)) it.status = "done";
        if (first) {
          S.status = "finished";
          S.finishedAt = Date.now();
          S.durationMin = Math.round((S.finishedAt - S.startedAt) / 60000);
        }
        for (const it of S.items) if (it.setting) await db.setSetting(`setting:${it.exercise}`, it.setting);
        await save();
        if (first) celebrate("Session done", "That's one more towards your 30. Enjoy the sauna.");
        else toast("Changes saved");
        return leave();
      }
      case "discard": {
        const msg = S.status === "finished" ? "Delete this finished session? This can't be undone." : "Discard this workout? Anything logged in it will be lost.";
        if (!confirm(msg)) return;
        await db.remove("sessions", S.id);
        toast(S.status === "finished" ? "Session deleted" : "Workout discarded");
        return leave();
      }
      default: return;
    }
    await save();
    render();
  }

  function onInput(e) {
    const el = e.target.closest("[data-field]");
    if (!el || !S) return;
    const f = el.dataset.field, i = Number(el.dataset.i), j = Number(el.dataset.j);
    if (f === "snote") S.note = el.value;
    else if (f === "note") S.items[i].note = el.value;
    else if (f === "setting") S.items[i].setting = el.value;
    else if (f === "minutes") S.items[i].minutes = num(el.value);
    else S.items[i].sets[j][f] = num(el.value);
    save();
  }

  // Only handles events while a workout is open (S is cleared on leave).
  $screen.addEventListener("click", (e) => { if (S) onClick(e); });
  $screen.addEventListener("input", (e) => { if (S) onInput(e); });
  return { start, active: () => !!S, openIndex: (i) => { pendingOpen = i; } };
}
