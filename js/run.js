// Run timer (run/walk intervals with beeps) and the run log. Timing comes from the clock, so a locked
// screen or a closed app doesn't lose time; the timer state is saved and resumes where it was.
import * as db from "./db.js";
import { getPlan, runText, DAY_COLOURS } from "./plan.js";
import { esc, toast, celebrate, num, mmss } from "./ui.js";
import { beep, unlockAudio } from "./beep.js";
import { lightHtml } from "./symptoms.js";

export const runId = (date, where) => (where === "treadmill" ? `run-${date}-tm` : `run-${date}`);

export function segmentsFor(run, where) {
  const segs = [{ kind: "walk", label: where === "outdoor" ? "Warm-up walk" : "Walk to warm up", sec: (where === "outdoor" ? 5 : 2) * 60 }];
  if (run.type === "run_walk") {
    for (let i = 0; i < run.reps; i++) {
      segs.push({ kind: "run", label: `Run ${i + 1} of ${run.reps}`, sec: run.run_min * 60 });
      if (i < run.reps - 1) segs.push({ kind: "walk", label: "Walk", sec: run.walk_min * 60 });
    }
  } else if (run.type === "continuous") {
    segs.push({ kind: "run", label: `Run ${run.minutes} min non-stop`, sec: run.minutes * 60 });
  } else if (run.type === "test") {
    segs.push({ kind: "run", label: `${run.distance_km} km run – easy pace`, sec: null }); // open-ended
  }
  if (where === "outdoor") segs.push({ kind: "walk", label: "Cool-down walk", sec: 300 });
  return segs;
}

export function newRun({ date, week, where, run, strides, source }) {
  return { id: runId(date, where), kind: "run", date, week, where, source, planned: run, plannedText: runText(run),
    strides: strides ? { planned: strides, done: null } : null, segs: segmentsFor(run, where),
    timer: null, status: "in_progress", totalRunMin: null, longestMin: null, distanceKm: null,
    effort: null, painDuring: null, painNextMorning: null, note: "" };
}

// ---- timer maths
function effMs(R, now = Date.now()) {
  const t = R.timer;
  if (!t) return 0;
  return (t.pausedAt ?? now) - t.t0 - t.pausedMs + t.shift;
}

function locate(R, ms) {
  let acc = 0;
  for (let i = 0; i < R.segs.length; i++) {
    const s = R.segs[i];
    const len = s.sec == null ? Infinity : s.sec * 1000;
    if (ms < acc + len) return { i, into: ms - acc, left: s.sec == null ? null : acc + len - ms };
    acc += len;
  }
  return { i: R.segs.length, into: 0, left: 0 }; // finished
}

// Running time actually covered (skipped remainders don't count).
function runStats(R) {
  const ms = effMs(R);
  let acc = 0, total = 0, longest = 0;
  R.segs.forEach((s, i) => {
    const len = s.sec == null ? Infinity : s.sec * 1000;
    const covered = Math.max(0, Math.min(len, ms - acc)) - (s.skippedMs ?? 0);
    if (s.kind === "run") { total += covered; longest = Math.max(longest, covered); }
    acc += len;
  });
  const min = (x) => Math.round(x / 30000) / 2; // nearest half minute
  return { total: min(total), longest: min(longest) };
}

// ------------------------------------------------------------------ view
export function createRunView({ $screen, $tabs }) {
  let R, onDone, ticker, lastIdx = -1, wakeLock, form = false;

  async function save() {
    try { await db.put("runs", R); } catch { toast("Couldn't save – try again", "bad"); }
  }

  async function start(record, done) {
    R = record;
    onDone = done;
    form = R.status === "finished";
    lastIdx = R.timer ? locate(R, effMs(R)).i : -1;
    $tabs.hidden = true;
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* not supported */ }
    clearInterval(ticker);
    ticker = setInterval(tick, 250);
    document.addEventListener("visibilitychange", onVisible);
    render();
  }

  function stop() {
    clearInterval(ticker);
    document.removeEventListener("visibilitychange", onVisible);
    wakeLock?.release?.().catch(() => {});
    const rec = R;
    R = null;
    $tabs.hidden = false;
    return rec;
  }

  async function onVisible() {
    if (document.visibilityState === "visible" && R?.timer && !R.timer.pausedAt) {
      try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* ignore */ }
    }
  }

  const colour = () => (R.where === "outdoor" ? DAY_COLOURS.sat : DAY_COLOURS.mon);

  function tick() {
    if (!R || form || !R.timer) return;
    const pos = locate(R, effMs(R));
    if (pos.i !== lastIdx) {
      if (lastIdx !== -1) {
        if (pos.i >= R.segs.length) beep(3, 1100);
        else beep(R.segs[pos.i].kind === "run" ? 2 : 1, R.segs[pos.i].kind === "run" ? 990 : 660);
      }
      lastIdx = pos.i;
      render();
      return;
    }
    const big = document.getElementById("bigtime");
    if (big) big.textContent = pos.left == null ? mmss(pos.into / 1000) : mmss(Math.ceil(pos.left / 1000));
    const bar = document.getElementById("runbar");
    if (bar) bar.style.width = `${progressPct()}%`;
  }

  function progressPct() {
    const total = R.segs.reduce((a, s) => a + (s.sec ?? 0), 0) * 1000;
    return total ? Math.min(100, (effMs(R) / total) * 100) : 0;
  }

  function chips(act, values, selected, fmtv = (v) => v) {
    return `<div class="chips">${values.map((v) => `<button type="button" class="chip ${selected === v ? "on" : ""}" data-ract="${act}" data-v="${v}" aria-pressed="${selected === v}">${fmtv(v)}</button>`).join("")}</div>`;
  }

  function render() {
    if (form) return renderForm();
    const head = `<div class="wk-top" style="background:${colour()}"><button type="button" class="back" data-ract="exit">‹ ${R.source === "gym" ? "Back to workout" : "Today"}</button>
      <h1>${R.where === "outdoor" ? "Saturday run" : "Treadmill run"}</h1><p>${esc(R.plannedText)}</p></div>`;
    if (!R.timer) {
      const sat = R.where === "outdoor"
        ? `<div class="card"><b>Before you run – warm-up</b><ul class="small">${getPlan().running.saturday_warmup.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
           <p class="muted small">Kicking this week? Do it after the warm-up and before the run.</p></div>` : "";
      $screen.innerHTML = `${head}
        <div class="card"><p><b>Easy pace</b> – you can talk in sentences. Slower is fine.</p>
          <ol class="seglist">${R.segs.map((s) => `<li class="${s.kind}">${esc(s.label)}${s.sec ? ` · ${mmss(s.sec)}` : ""}</li>`).join("")}</ol>
          <p class="muted small">Beeps: two for run, one for walk, three when you're done. Keep the screen on – iPhones pause timers and sound when locked, but the time stays correct.</p></div>
        ${sat}
        <button type="button" class="btn big" data-ract="go">▶ Start run timer</button>
        <button type="button" class="linkbtn" data-ract="logonly" style="display:block;margin:6px auto">Just log a run without the timer</button>`;
      return;
    }
    const pos = locate(R, effMs(R));
    const doneAll = pos.i >= R.segs.length;
    const seg = R.segs[pos.i];
    const next = R.segs[pos.i + 1];
    const paused = !!R.timer.pausedAt;
    $screen.innerHTML = `${head}
      <div class="runface ${doneAll ? "done" : seg.kind}">
        <div class="segname">${doneAll ? "Plan complete 🎉" : esc(seg.kind === "run" ? "RUN" : "WALK")}</div>
        <div class="seglabel">${doneAll ? "Walk to cool down, then log it" : esc(seg.label)}</div>
        <div class="bigtime" id="bigtime" role="timer">${doneAll ? "✓" : pos.left == null ? mmss(pos.into / 1000) : mmss(Math.ceil(pos.left / 1000))}</div>
        <div class="segnext">${doneAll ? "" : next ? `Next: ${esc(next.label)}` : "Last one!"}${paused ? " · Paused" : ""}</div>
        <div class="runprog"><div id="runbar" style="width:${progressPct()}%"></div></div>
      </div>
      ${doneAll ? "" : `<div class="row2">
        <button type="button" class="btn ghost" data-ract="${paused ? "resume" : "pause"}">${paused ? "▶ Resume" : "❚❚ Pause"}</button>
        <button type="button" class="btn ghost" data-ract="skip">${seg.sec == null ? "I've finished the run" : "Skip to next ›"}</button></div>`}
      <button type="button" class="btn finish" data-ract="end">${doneAll ? "Log this run" : "End run and log it"}</button>`;
  }

  function renderForm() {
    if (R.totalRunMin == null && R.timer) {
      const st = runStats(R);
      R.totalRunMin = st.total;
      R.longestMin = st.longest;
    }
    const pace = R.distanceKm && R.totalRunMin ? R.totalRunMin / R.distanceKm : null;
    const stridesQ = R.strides
      ? `<p class="q">Strides (${esc(R.strides.planned)}) – only if your quad was green</p>
         ${chips("strides", ["yes", "no"], R.strides.done, (v) => (v === "yes" ? "Done" : "Not today"))}` : "";
    $screen.innerHTML = `<div class="wk-top" style="background:${colour()}"><button type="button" class="back" data-ract="${R.status === "finished" ? "exit" : "unform"}">‹ ${R.status === "finished" ? "Back" : "Back to timer"}</button>
        <h1>${R.status === "finished" ? "Edit run" : "Log your run"}</h1><p>Planned: ${esc(R.plannedText)}</p></div>
      <div class="card">
        <label class="mini">Total running time (minutes, not counting walks)
          <input class="in wide" inputmode="decimal" data-rfield="totalRunMin" value="${R.totalRunMin ?? ""}"></label>
        <label class="mini">Longest non-stop run (minutes)
          <input class="in wide" inputmode="decimal" data-rfield="longestMin" value="${R.longestMin ?? ""}"></label>
        <label class="mini">Distance in km (optional – if your phone or watch measured it)
          <input class="in wide" inputmode="decimal" data-rfield="distanceKm" value="${R.distanceKm ?? ""}" placeholder="e.g. 2.4"></label>
        <p class="muted small" id="pace">${pace ? `Pace: ${mmss(pace * 60)} per km` : ""}</p>
        ${stridesQ}
        <p class="q">How hard was it? (1–10 · runs should mostly feel 3–5)</p>
        ${chips("effort", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], R.effort)}
        <p class="q">Quad pain during (0–10)</p>
        ${chips("pain", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], R.painDuring)}
        ${lightHtml(R.painDuring, R.painNextMorning)}
        ${R.status === "finished" ? `<p class="q">Quad pain next morning (0–10)</p>${chips("morning", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], R.painNextMorning)}` : ""}
        <label class="mini">Notes<textarea class="in wide" rows="2" data-rfield="note" placeholder="Route, how it felt…">${esc(R.note)}</textarea></label>
        <button type="button" class="btn" data-ract="save">${R.status === "finished" ? "Save changes" : "Save run"}</button>
        ${R.status === "finished" ? `<button type="button" class="linkbtn" data-ract="delete" style="display:block;margin:8px auto">Delete this run</button>` : ""}
      </div>`;
  }

  async function finish() {
    if (R.totalRunMin == null) { toast("Enter your running time first"); return; }
    const first = R.status !== "finished";
    R.status = "finished";
    if (R.timer && !R.timer.pausedAt) R.timer.pausedAt = Date.now();
    await save();
    const rec = stop();
    if (first) {
      const msg = rec.totalRunMin >= 30 ? "Thirty minutes plus – 5 km is getting close." : "Every run builds towards 5 km.";
      celebrate("Run logged", msg);
    } else toast("Changes saved");
    onDone(rec);
  }

  $screen.addEventListener("click", async (e) => {
    if (!R) return;
    const b = e.target.closest("[data-ract]");
    if (!b) return;
    unlockAudio();
    const act = b.dataset.ract, v = b.dataset.v;
    const t = R.timer;
    switch (act) {
      case "exit": await save(); { const rec = stop(); onDone(rec, { left: true }); } return;
      case "go": R.timer = { t0: Date.now(), pausedMs: 0, pausedAt: null, shift: 0 }; lastIdx = 0; beep(1, 660); break;
      case "logonly": form = true; break;
      case "pause": t.pausedAt = Date.now(); break;
      case "resume": t.pausedMs += Date.now() - t.pausedAt; t.pausedAt = null; break;
      case "skip": {
        const pos = locate(R, effMs(R));
        const seg = R.segs[pos.i];
        if (seg.sec == null) seg.sec = Math.round(pos.into / 1000); // open-ended run ends now
        else { seg.skippedMs = (seg.skippedMs ?? 0) + pos.left; t.shift += pos.left; }
        break;
      }
      case "end": form = true; break;
      case "unform": form = false; R.totalRunMin = null; R.longestMin = null; break;
      case "effort": R.effort = R.effort === Number(v) ? null : Number(v); break;
      case "pain": R.painDuring = R.painDuring === Number(v) ? null : Number(v); break;
      case "morning": R.painNextMorning = R.painNextMorning === Number(v) ? null : Number(v); break;
      case "strides": R.strides.done = R.strides.done === v ? null : v; break;
      case "save": return finish();
      case "delete":
        if (!confirm("Delete this run? This can't be undone.")) return;
        await db.remove("runs", R.id);
        toast("Run deleted");
        { const rec = stop(); onDone(rec, { deleted: true }); }
        return;
      default: return;
    }
    await save();
    render();
  });

  $screen.addEventListener("input", (e) => {
    if (!R) return;
    const el = e.target.closest("[data-rfield]");
    if (!el) return;
    const f = el.dataset.rfield;
    R[f] = f === "note" ? el.value : num(el.value);
    const pace = R.distanceKm && R.totalRunMin ? R.totalRunMin / R.distanceKm : null;
    const p = document.getElementById("pace");
    if (p) p.textContent = pace ? `Pace: ${mmss(pace * 60)} per km` : "";
    save();
  });

  return { start, active: () => !!R };
}
