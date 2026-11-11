import * as db from "./db.js";
import {
  loadPlan, getPlan, position, dayPlan, weekInfo, phaseFor, picto, doseText,
  DAY_KEYS, DAY_COLOURS, parseDate, isoDate,
} from "./plan.js";
import { esc, fmt, today, toast } from "./ui.js";
import { unlockAudio } from "./beep.js";
import { createWorkoutView, getOrCreateSession, gymId } from "./workout.js";
import { createRunView, newRun, runId } from "./run.js";
import { createKickView, newKick, kickId, suggestion } from "./kick.js";
import { pendingMorning, saveMorning, redDays, lightHtml } from "./symptoms.js";
import { createSettingsView, needsBackupReminder, backupNow, readBackup } from "./settings.js";
import { renderProgress, bindProgress } from "./progress.js";
import { renderHistory } from "./history.js";
import { createCheckinView, checkinId } from "./checkin.js";
import { renderPlan, openGuide } from "./planview.js";

const $screen = document.getElementById("screen");
const $tabs = document.getElementById("tabs");
const state = { tab: "today", name: "", start: null };
const runView = createRunView({ $screen, $tabs });
const kickView = createKickView({ $screen, $tabs });
const workout = createWorkoutView({
  $screen, $tabs, onExit: () => show(state.tab),
  // Treadmill run inside a gym session: run timer, then back to the workout with the minutes filled in.
  onRun: async (session, i) => {
    const item = session.items[i];
    const rec = (await db.get("runs", runId(session.date, "treadmill")))
      ?? newRun({ date: session.date, week: session.week, where: "treadmill", run: item.planned.run, source: "gym",
        strides: session.dayKey === "fri" ? weekInfo(session.week).strides : null });
    runView.start(rec, async (done, how = {}) => {
      const s = await db.get("sessions", session.id);
      const it = s.items[i];
      if (how.deleted) { delete it.runId; } else if (done.status === "finished") {
        it.runId = done.id;
        it.minutes = done.totalRunMin;
        it.status = "done";
      }
      await db.put("sessions", s);
      workout.openIndex(i);
      workout.start(s);
    });
  },
});
const settingsView = createSettingsView({ $screen, $tabs });
const checkinView = createCheckinView({ $screen, $tabs });
const viewActive = () => workout.active() || runView.active() || kickView.active() || settingsView.active() || checkinView.active();
bindProgress($screen, () => state.tab === "progress" && !viewActive());
const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

// ------------------------------------------------------------------ first run
function renderWelcome() {
  $tabs.hidden = true;
  const start = getPlan().meta.start_date;
  $screen.innerHTML = `
    <h1>Welcome 👋</h1>
    <p class="muted">Your 12-week plan, on your phone. Everything you log stays on this phone.</p>
    <form id="welcome" class="card">
      <label for="name">What should the app call you?</label>
      <input id="name" type="text" autocomplete="given-name" maxlength="30" placeholder="Your first name" required>
      <label for="start">Week 1 starts on</label>
      <input id="start" type="date" value="${start}" required>
      <p class="muted small" style="margin-top:6px">Pick a Monday. You can change this later.</p>
      <button class="btn" type="submit">Let's go</button>
    </form>
    <div class="card"><b>New phone, or reinstalled?</b>
      <p class="muted small">Restore your logs from a backup file you saved earlier.</p>
      <label class="btn ghost filebtn">Restore from a backup file<input type="file" accept="application/json,.json" id="w-restore" hidden></label></div>`;
  document.getElementById("w-restore").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = await readBackup(f);
      const n = (data.sessions?.length ?? 0) + (data.runs?.length ?? 0) + (data.kicks?.length ?? 0);
      if (!confirm(`Restore this backup (${n} logged activities)?`)) return;
      await db.importAll(data);
      toast("Backup restored");
      init();
    } catch (err) {
      toast(err.message, "bad");
    }
  });
  document.getElementById("welcome").addEventListener("submit", async (e) => {
    e.preventDefault();
    state.name = document.getElementById("name").value.trim();
    state.start = document.getElementById("start").value;
    await db.setSetting("name", state.name);
    await db.setSetting("startDate", state.start);
    $tabs.hidden = false;
    show("today");
  });
}

// ------------------------------------------------------------------ today
function ring(week) {
  const r = 26, c = 2 * Math.PI * r, frac = week / 12;
  return `<svg class="ring" viewBox="0 0 64 64"><circle class="bg" cx="32" cy="32" r="${r}"/>
    <circle class="fg" cx="32" cy="32" r="${r}" stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}"/>
    <text x="32" y="32">${week}/12</text></svg>`;
}

function dayStrip(week, todayKey, finishedDates) {
  const w = weekInfo(week);
  const label = { gym: "Gym", run: "5 km", rest: "Rest", kick_test: "Kick", kick: "Kick" };
  return `<div class="daystrip">${DAY_KEYS.map((k) => {
    const p = w.days[k].plan;
    const train = p === "gym" || p === "run";
    const done = finishedDates.has(w.days[k].date);
    const style = train ? `style="background:${DAY_COLOURS[k]}"` : "";
    return `<div class="${train ? "train" : ""} ${k === todayKey ? "today" : ""}" ${style}>
      <b>${k[0].toUpperCase() + k.slice(1)}</b>${done ? "✓ Done" : label[p]}</div>`;
  }).join("")}</div>`;
}

function itemRow(it, colour, name) {
  const ex = getPlan().exercises[it.exercise];
  const opt = it.optional ? `<span class="tag">optional</span>` : "";
  const note = it.note && !it.run ? `<div class="note">${esc(it.note)}</div>` : "";
  return `<div class="item"><div class="pic-wrap">${picto(it.exercise, colour)}</div>
    <div class="txt"><div class="name">${esc(name ?? ex.name)}${opt}</div>
    <div class="dose">${esc(doseText(it))}</div>${note}</div></div>`;
}

function gymButton(session) {
  if (!session || session.status === "in_progress") return "";
  return `<div class="done-banner">✓ Done · ${session.durationMin ?? "–"} min${session.effort ? ` · effort ${session.effort}/10` : ""}
    <button type="button" class="linkbtn" data-go="resume">View or edit</button></div>`;
}

// Kicking: this week's stage (or the suggested one), with a button to log it.
async function kickBlock(date, planStage) {
  const kick = await db.get("kicks", kickId(date));
  const sug = await suggestion();
  const stage = getPlan().kicking.stages.find((k) => k.stage === sug.stage);
  return kick
    ? `<div class="done-banner">✓ Kicking logged · stage ${kick.stage} · pain ${kick.painDuring}/10 <button type="button" class="linkbtn" data-go="kick">Edit</button></div>`
    : `<div class="card"><b>Kicking – your stage: ${sug.stage}</b>${sug.stage !== planStage ? ` <span class="muted small">(plan guide this week: stage ${planStage} – it's fine to take longer)</span>` : ""}
        <p class="small">${esc(stage.what)}</p>
        <p class="hint">💡 ${esc(sug.text)}</p>
        ${sug.to ? `<button type="button" class="btn ghost" data-go="stage" data-to="${sug.to}">${sug.kind === "up" ? `Move up to Stage ${sug.to}` : `Drop back to Stage ${sug.to}`}</button>` : ""}
        <button type="button" class="btn" data-go="kick">Log kicking</button></div>`;
}

async function renderToday() {
  const now = today();
  const pos = position(now, state.start);
  const week = pos.week;
  const w = weekInfo(week);
  const phase = phaseFor(week);
  const sessions = (await db.all("sessions")).filter((s) => s.kind === "gym");
  const finished = sessions.filter((s) => s.status === "finished");
  const finishedDates = new Set(finished.map((s) => s.date));
  const weekDone = finished.filter((s) => s.week === week).length;
  const inProgress = sessions.find((s) => s.status === "in_progress");

  const hello = state.name ? `Hi ${esc(state.name)}` : "Hi";
  let headline = `Week ${week} of 12 · ${esc(phase.name)}`;
  if (pos.status === "before") headline = `Starts in ${pos.daysToStart} day${pos.daysToStart === 1 ? "" : "s"}`;
  if (pos.status === "after") headline = "12 weeks complete 🎉";

  const showDay = pos.status === "during" ? pos.dayKey : "mon";
  const dp = dayPlan(week, showDay);
  const dayLabel = pos.status === "during" ? "Today" : `Week 1, ${fmt(parseDate(w.days.mon.date), { weekday: "long", day: "numeric", month: "short" })}`;
  const colour = DAY_COLOURS[showDay] || "#5b6678";
  state.current = { week, dayKey: showDay, date: w.days[showDay].date };

  let body = "";
  if (dp.kind === "gym") {
    const s = dp.session;
    const session = sessions.find((x) => x.id === gymId(w.days[showDay].date));
    body = `<div class="session-head" style="background:${colour}"><h2>${dayLabel}: ${esc(s.title)}</h2><p>${esc(s.subtitle)}</p></div>
      <div class="session-body">${s.items.map((it) => itemRow(it, colour)).join("")}</div>
      ${pos.status === "during" ? gymButton(session) : ""}`;
  } else if (dp.kind === "run") {
    const date = w.days[showDay].date;
    const run = await db.get("runs", runId(date, "outdoor"));
    const runBlock = run?.status === "finished"
      ? `<div class="done-banner">✓ Run logged · ${run.totalRunMin} min${run.distanceKm ? ` · ${run.distanceKm} km` : ""} <button type="button" class="linkbtn" data-go="run">Edit</button></div>`
      : `<button type="button" class="btn big" data-go="run">${run ? "Resume run" : "Start run"}</button>`;
    body = `<div class="session-head" style="background:${colour}"><h2>${dayLabel}: 5 km run</h2><p>Your goal run – outdoors, easy pace</p></div>
      <div class="session-body">
        ${itemRow({ exercise: "outdoor_run", run: run?.planned ?? await runToDo(week) }, colour)}
      </div>
      ${pos.status === "during" ? (run?.status === "finished" ? "" : await awayHint(week, now)) + runBlock : ""}`;
  } else if (dp.kind === "kick_test") {
    const kick = await db.get("kicks", kickId(w.days[showDay].date));
    body = `<div class="card"><h2 style="margin-top:0">${dayLabel}: final kick test</h2><p>Warm up, then Stage 4 strikes. Record the pain score.</p>
      ${kick ? `<div class="done-banner">✓ Logged · pain ${kick.painDuring}/10 <button type="button" class="linkbtn" data-go="kicktest">Edit</button></div>`
        : `<button type="button" class="btn" data-go="kicktest">Log kick test</button>`}</div>`;
  } else {
    const ci = dp.kind === "checkin" && pos.status === "during" ? await db.get("checkins", checkinId(week)) : null;
    const ciBtn = dp.kind !== "checkin" || pos.status !== "during" ? ""
      : ci ? `<div class="done-banner">✓ Check-in done <button type="button" class="linkbtn" data-go="checkin">Edit</button></div>`
        : `<button type="button" class="btn" data-go="checkin">Start Sunday check-in</button>`;
    const kicking = dp.kickStage && pos.status === "during";
    body = `<div class="card"><h2 style="margin-top:0">${dayLabel}: ${dp.kickStage ? "kicking" : "rest"}${dp.kind === "checkin" ? " + Sunday check-in" : ""}</h2>
      <p class="muted">${dp.kickStage ? "About 20 minutes in the park on rested legs: warm up, then this week's kicking stage. Then five minutes to record your week."
        : dp.kind === "checkin" ? "Rest, then five minutes to record your week." : "Recovery is part of the plan. An easy walk is fine."}</p>
      ${dp.kickStage ? `<div class="session-body">${itemRow({ exercise: "kick", note: getPlan().running.saturday_warmup.slice(0, 5).join(" · ") }, DAY_COLOURS.sat, `Kicking – plan stage ${dp.kickStage}`)}</div>` : ""}
      ${kicking ? await kickBlock(w.days[showDay].date, dp.kickStage) : ""}${ciBtn}</div>`;
  }

  // Before the plan starts: say when logging opens, and invite the starting values.
  if (pos.status === "before") {
    const b = await db.getSetting("baselines", null);
    body = `<div class="card start-card"><b>Your plan starts ${fmt(parseDate(state.start), { weekday: "long", day: "numeric", month: "long" })}.</b>
      <p class="small"><b>Want to start now?</b> Tap <b>Do a workout</b> – Week 1's sessions can be done early and count towards Week 1.</p>
      <p class="small"><b>This weekend:</b> record your starting values – plank hold, how far you can run, kick pain, bodyweight and waist.</p>
      <button type="button" class="btn" data-go="baselines">${b ? "Update my starting values" : "Record my starting values"}</button></div>${body}`;
  }

  // One clear way in: Do a workout -> which session -> what's in it -> log it.
  const doBtn = pos.status === "after" ? "" : inProgress
    ? `<button type="button" class="btn big" data-go="resume-other">▶ Resume workout: ${esc(inProgress.title)}</button>`
    : `<button type="button" class="btn big" data-go="choose">▶ Do a workout</button>`;

  // Next-morning quad check for yesterday's (or the day before's) run, kicks or gym session.
  const m = await pendingMorning(now);
  const scale = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const morningCard = m ? `<div class="card morning"><b>How's the quad this morning?</b>
      <p class="muted small">After your ${m.label} on ${fmt(parseDate(m.day), { weekday: "long" })}${m.during != null ? ` (pain during: ${m.during}/10)` : ""}. 0 = nothing, 10 = worst.</p>
      <div class="chips">${scale.map((v) => `<button type="button" class="chip" data-go="morning" data-store="${m.store}" data-id="${m.r.id}" data-v="${v}">${v}</button>`).join("")}</div>
      <button type="button" class="linkbtn" data-go="morning-skip" data-store="${m.store}" data-id="${m.r.id}">Skip</button></div>` : "";
  const mr = state.morningResult;
  state.morningResult = null;

  // Two red days in 14 days: a "get it checked" sign. Dismissible, comes back on a new red day.
  const reds = await redDays(now);
  const dismissed = await db.getSetting("redDismissed", "");
  const lastRed = reds[reds.length - 1];
  const redBanner = reds.length >= 2 && lastRed > dismissed
    ? `<div class="light r"><b>Two red days in the last 2 weeks</b><br>This is one of the "get it checked" signs. Consider seeing a GP or physio before pushing on.
        <p class="small" style="margin:6px 0 0">${getPlan().stop_and_seek_advice.map(esc).join("<br>")}</p>
        <button type="button" class="linkbtn" data-go="red-dismiss" data-d="${lastRed}">I've read this</button></div>` : "";
  // The banner already lists the "get it checked" signs, so the morning result stays short when it shows.
  const morningResult = mr ? `<div class="card"><b>Thanks – noted.</b>${lightHtml(mr.during, mr.morning, { short: !!redBanner })}</div>` : "";

  const backupMsg = await needsBackupReminder(now);
  const backupCard = backupMsg ? `<div class="card backup"><b>Back up your logs</b>
      <p class="muted small">${esc(backupMsg)} A backup keeps your progress safe if the phone is lost or the app is deleted.</p>
      <button type="button" class="btn ghost" data-go="backup">Back up now</button></div>` : "";

  const notes = w.notes.length ? `<div class="notice"><b>This week:</b><br>${w.notes.map(esc).join("<br>")}</div>` : "";
  $screen.innerHTML = `
    <div class="topline"><p class="muted" style="margin:6px 0 0">${fmt(now, { weekday: "long", day: "numeric", month: "long" })}</p>
      <button type="button" class="gear" data-go="settings" aria-label="Settings">⚙️</button></div>
    <h1>${hello}</h1>
    ${redBanner}${morningResult}${morningCard}${backupCard}
    <div class="card hero">${ring(pos.status === "before" ? 0 : week)}
      <div><div style="font-weight:700;font-size:18px">${headline}</div>
      <div class="muted small">${pos.status === "during" ? `Gym this week: <b style="color:#fff">${weekDone} of 3</b> · Total: <b style="color:#fff">${finished.length} of 30</b>` : esc(phase.focus)}</div></div></div>
    ${dayStrip(week, pos.status === "during" ? pos.dayKey : null, finishedDates)}
    ${doBtn}
    ${body}
    ${dp.kind === "gym" && w.sets_note !== "Sets as listed" ? `<div class="notice">${esc(w.sets_note)}</div>` : ""}
    ${notes}
    <button type="button" class="btn ghost" data-go="poster">🖼️ This phase at a glance</button>`;
}

// ------------------------------------------------------------------ been away? repeat the last run step
async function lastOutdoorRun(beforeIso) {
  return (await db.all("runs")).filter((r) => r.where === "outdoor" && r.status === "finished" && r.date < beforeIso)
    .sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;
}

// The Saturday run to do this week: the plan's, unless the user chose to repeat their last step after a break.
async function runToDo(week) {
  const w = weekInfo(week);
  return (await db.getSetting(`repeatRun:${w.days.sat.date}`, null)) ?? w.runs.sat;
}

async function awayHint(week, todayDate) {
  const w = weekInfo(week);
  if (!w.runs.sat) return "";
  const last = await lastOutdoorRun(w.days.sat.date);
  if (!last || week === 1) return "";
  const gap = Math.round((todayDate - parseDate(last.date)) / 86400000);
  const chosen = await db.getSetting(`repeatRun:${w.days.sat.date}`, null);
  if (gap < 10 || last.plannedText === w.runs.sat.text) return "";
  if (chosen) {
    return `<div class="notice">Repeating your last step this week: <b>${esc(last.plannedText)}</b>
      <button type="button" class="linkbtn" data-go="repeat-run-undo">Use this week's plan instead</button></div>`;
  }
  return `<div class="card"><b>Been away?</b> <span class="muted small">Your last run was ${gap} days ago.</span>
    <p class="small">After a break it's wise to repeat the last step you completed (<b>${esc(last.plannedText)}</b>) before moving on to this week's (${esc(w.runs.sat.text)}).</p>
    <button type="button" class="btn ghost" data-go="repeat-run">Repeat my last step</button></div>`;
}

// ------------------------------------------------------------------ "Do a workout": which session?
const LETTER = { mon: "A", wed: "B", fri: "C" };

async function sessionChoices(wk, finishedDates, todayIso) {
  const w = weekInfo(wk);
  const satRun = await db.get("runs", runId(w.days.sat.date, "outdoor"));
  return ["mon", "wed", "fri", ...(w.runs.sat ? ["sat"] : [])].map((k) => {
    const date = w.days[k].date;
    const done = k === "sat" ? satRun?.status === "finished" : finishedDates.has(date);
    return { wk, k, date, done, planned: date === todayIso };
  });
}

async function choiceCard(c, suggested) {
  const colour = DAY_COLOURS[c.k];
  const status = c.done ? `<span class="badge ok">✓ Done</span>` : suggested ? `<span class="badge sug">Suggested</span>` : "";
  if (c.k === "sat") {
    const w = weekInfo(c.wk);
    const run = await runToDo(c.wk);
    return `<div class="choice"><div class="choice-head" style="background:${colour}"><b>Run outdoors</b><span>Saturday</span>${status}</div>
      <div class="choice-body">${itemRow({ exercise: "outdoor_run", run }, colour)}
        <button type="button" class="btn ${c.done ? "ghost" : ""}" data-go="catchup-run" data-week="${c.wk}">${c.done ? "View or edit the run" : "Start the run"}</button></div></div>`;
  }
  const s = dayPlan(c.wk, c.k).session;
  return `<div class="choice"><div class="choice-head" style="background:${colour}"><b>Session ${LETTER[c.k]}: ${esc(s.title)}</b><span>usually ${DAY_NAMES[c.k]}</span>${status}</div>
    <div class="choice-body"><p class="muted small">${esc(s.subtitle)}</p>
      <details class="preview" ${suggested && !c.done ? "open" : ""}><summary>What's in it (${s.items.length} items)</summary>${s.items.map((it) => itemRow(it, colour)).join("")}</details>
      <button type="button" class="btn ${c.done ? "ghost" : ""}" data-go="catchup" data-day="${c.k}" data-week="${c.wk}">${c.done ? `View or edit Session ${LETTER[c.k]}` : `Start Session ${LETTER[c.k]}`}</button></div></div>`;
}

async function renderChooser() {
  $tabs.hidden = true;
  state.choosing = true;
  const now = today();
  const todayIso = isoDate(now);
  const pos = position(now, state.start);
  const finishedDates = new Set((await db.all("sessions")).filter((s) => s.status === "finished").map((s) => s.date));
  const list = await sessionChoices(pos.week, finishedDates, todayIso);
  // Suggest today's planned session if it's still to do, otherwise the first undone in order A, B, C, run.
  const sug = list.find((c) => c.planned && !c.done) ?? list.find((c) => !c.done);
  let next = "";
  if (pos.status === "during" && pos.dayKey === "sun" && pos.week < 12) {
    const nl = (await sessionChoices(pos.week + 1, finishedDates, todayIso)).filter((c) => c.k !== "sat");
    next = `<h2>Get ahead: week ${pos.week + 1}</h2><p class="muted small">Free on a Sunday? Next week's sessions count towards next week.</p>
      ${(await Promise.all(nl.map((c) => choiceCard(c, false)))).join("")}`;
  }
  const intro = pos.status === "before"
    ? `<div class="notice">Starting early – these are <b>Week 1</b>'s sessions and count towards Week 1.</div>`
    : `<p class="muted small">Any session, any day – each counts once. Suggested order: A, B, C, with the run on its own day.</p>`;
  $screen.innerHTML = `<div class="wk-top" style="background:var(--navy)"><button type="button" class="back" data-go="choose-back">‹ Today</button>
      <h1>Which session?</h1><p>Week ${pos.week} · ${esc(phaseFor(pos.week).name)}</p></div>
    ${intro}
    ${(await Promise.all(list.map((c) => choiceCard(c, c === sug)))).join("")}
    ${next}`;
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ phase infographic (pinch to zoom)
function openPoster(phase) {
  const idx = phase || getPlan().phases.indexOf(phaseFor(position(today(), state.start).week)) + 1;
  const el = document.createElement("div");
  el.className = "viewer";
  el.innerHTML = `<div class="viewer-bar"><b>Phase ${idx} at a glance</b>
      <span><button type="button" data-v="zoom">Zoom</button><button type="button" data-v="close">Close</button></span></div>
    <div class="viewer-body"><img src="img/phase-${idx}.jpg" alt="Phase ${idx} infographic: every session, exercise pictures, runs and rules"></div>`;
  el.addEventListener("click", (e) => {
    const v = e.target.closest("[data-v]")?.dataset.v;
    if (v === "close") el.remove();
    if (v === "zoom") el.classList.toggle("zoomed");
  });
  document.body.append(el);
}

const screens = {
  today: renderToday,
  plan: () => renderPlan($screen, position(today(), state.start).week),
  progress: () => renderProgress($screen),
  history: () => renderHistory($screen),
};

async function show(tab) {
  state.tab = tab;
  for (const b of $tabs.querySelectorAll("button")) {
    if (b.dataset.tab === tab) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  await screens[tab]();
  window.scrollTo(0, 0);
}

$tabs.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) show(b.dataset.tab);
});

$screen.addEventListener("click", async (e) => {
  if (viewActive()) return;
  const b = e.target.closest("[data-go]");
  if (!b) return;
  unlockAudio();
  const go = b.dataset.go;
  const c = state.current;
  const backToToday = () => show(state.tab);
  if (go === "choose") return renderChooser();
  if (go === "choose-back") { state.choosing = false; $tabs.hidden = false; return show("today"); }
  if (state.choosing && (go === "catchup" || go === "catchup-run")) { state.choosing = false; $tabs.hidden = false; }
  if (go === "poster") return openPoster(Number(b.dataset.phase) || 0);
  if (go === "guide") return openGuide(b.dataset.ex);
  if (go === "baselines") {
    await show("progress");
    return document.getElementById("baselines")?.scrollIntoView();
  }
  if (go === "checkin") return checkinView.start(c.week, c.date, () => show(state.tab));
  if (go === "h-open") {
    const store = b.dataset.store, rec = await db.get(store, b.dataset.id);
    if (!rec) return;
    if (store === "sessions") return workout.start(rec);
    if (store === "runs") return runView.start(rec, backToToday);
    if (store === "kicks") return kickView.start(rec, backToToday);
    if (store === "checkins") return checkinView.start(rec.week, rec.date, backToToday);
  }
  if (go === "backup") { await backupNow(); return show("today"); }
  if (go === "settings") {
    return settingsView.start(async (changed) => {
      if (changed) {
        state.name = await db.getSetting("name", "");
        state.start = await db.getSetting("startDate", null);
        if (!state.start) return renderWelcome();
      }
      show("today");
    });
  }
  if (go === "morning" || go === "morning-skip") {
    const v = go === "morning" ? Number(b.dataset.v) : null;
    const r = await saveMorning(b.dataset.store, b.dataset.id, v);
    if (v != null) {
      const during = b.dataset.store === "sessions"
        ? r.painDuring ?? Math.max(-1, ...r.items.map((i) => i.pain ?? -1))
        : r.painDuring;
      state.morningResult = { during: during >= 0 ? during : null, morning: v };
    }
    return show("today");
  }
  if (go === "red-dismiss") { await db.setSetting("redDismissed", b.dataset.d); return show("today"); }
  if (go === "stage") { await db.setSetting("kickStage", Number(b.dataset.to)); return show("today"); }
  if (go === "run") {
    const w = weekInfo(c.week);
    const rec = (await db.get("runs", runId(c.date, "outdoor")))
      ?? newRun({ date: c.date, week: c.week, where: "outdoor", run: await runToDo(c.week), strides: w.strides, source: "today" });
    return runView.start(rec, backToToday);
  }
  if (go === "repeat-run" || go === "repeat-run-undo") {
    const w = weekInfo(c.week);
    const key = `repeatRun:${w.days.sat.date}`;
    if (go === "repeat-run") await db.setSetting(key, (await lastOutdoorRun(w.days.sat.date)).planned);
    else await db.setSetting(key, null);
    return show("today");
  }
  if (go === "kick" || go === "kicktest") {
    const rec = (await db.get("kicks", kickId(c.date))) ?? await newKick(c.date, c.week, go === "kicktest");
    return kickView.start(rec, backToToday);
  }
  if (go === "start" || go === "resume") {
    return workout.start(await getOrCreateSession(c.week, c.dayKey, c.date, isoDate(today())));
  }
  if (go === "catchup-run") {
    const wk = Number(b.dataset.week) || c.week;
    const w = weekInfo(wk);
    const date = w.days.sat.date;
    const rec = (await db.get("runs", runId(date, "outdoor")))
      ?? newRun({ date, week: wk, where: "outdoor", run: await runToDo(wk), strides: w.strides, source: "today" });
    return runView.start(rec, backToToday);
  }
  if (go === "catchup") {
    const k = b.dataset.day, wk = Number(b.dataset.week) || c.week;
    return workout.start(await getOrCreateSession(wk, k, weekInfo(wk).days[k].date, isoDate(today())));
  }
  if (go === "resume-other") {
    const s = (await db.all("sessions")).find((x) => x.status === "in_progress");
    if (s) return workout.start(s);
  }
});

async function init() {
  // Ask the browser to keep this app's data even when the phone is low on space.
  navigator.storage?.persist?.().catch(() => {});
  await loadPlan();
  state.name = await db.getSetting("name", "");
  state.start = await db.getSetting("startDate", null);
  if (!state.start) return renderWelcome();
  $tabs.hidden = false;
  show("today");
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
init().catch((err) => {
  $screen.innerHTML = `<div class="card"><h1>Something went wrong</h1><p>${esc(err.message)}</p></div>`;
});
