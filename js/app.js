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

const $screen = document.getElementById("screen");
const $tabs = document.getElementById("tabs");
const state = { tab: "today", name: "", start: null };
const runView = createRunView({ $screen, $tabs });
const kickView = createKickView({ $screen, $tabs });
const workout = createWorkoutView({
  $screen, $tabs, onExit: () => show("today"),
  // Treadmill run inside a gym session: run timer, then back to the workout with the minutes filled in.
  onRun: async (session, i) => {
    const item = session.items[i];
    const rec = (await db.get("runs", runId(session.date, "treadmill")))
      ?? newRun({ date: session.date, week: session.week, where: "treadmill", run: item.planned.run, source: "gym" });
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
const viewActive = () => workout.active() || runView.active() || kickView.active() || settingsView.active();
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
  const label = { gym: "Gym", run: "Run", rest: "Rest", kick_test: "Kick" };
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
  if (!session) return `<button type="button" class="btn big" data-go="start">Start workout</button>`;
  if (session.status === "in_progress") return `<button type="button" class="btn big" data-go="resume">Resume workout</button>`;
  return `<div class="done-banner">✓ Done · ${session.durationMin ?? "–"} min${session.effort ? ` · effort ${session.effort}/10` : ""}
    <button type="button" class="linkbtn" data-go="resume">View or edit</button></div>`;
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
    const kick = dp.kickStage ? await db.get("kicks", kickId(date)) : null;
    const sug = dp.kickStage ? await suggestion() : null;
    const stage = sug ? getPlan().kicking.stages.find((k) => k.stage === sug.stage) : null;
    const kickBlock = !dp.kickStage ? "" : kick
      ? `<div class="done-banner">✓ Kicking logged · stage ${kick.stage} · pain ${kick.painDuring}/10 <button type="button" class="linkbtn" data-go="kick">Edit</button></div>`
      : `<div class="card"><b>Kicking – your stage: ${sug.stage}</b>${sug.stage !== dp.kickStage ? ` <span class="muted small">(plan guide this week: stage ${dp.kickStage} – it's fine to take longer)</span>` : ""}
          <p class="small">${esc(stage.what)}</p>
          <p class="hint">💡 ${esc(sug.text)}</p>
          ${sug.to ? `<button type="button" class="btn ghost" data-go="stage" data-to="${sug.to}">${sug.kind === "up" ? `Move up to Stage ${sug.to}` : `Drop back to Stage ${sug.to}`}</button>` : ""}
          <button type="button" class="btn" data-go="kick">Log kicking (before the run)</button></div>`;
    const runBlock = run?.status === "finished"
      ? `<div class="done-banner">✓ Run logged · ${run.totalRunMin} min${run.distanceKm ? ` · ${run.distanceKm} km` : ""} <button type="button" class="linkbtn" data-go="run">Edit</button></div>`
      : `<button type="button" class="btn big" data-go="run">${run ? "Resume run" : "Start run"}</button>`;
    body = `<div class="session-head" style="background:${colour}"><h2>${dayLabel}: Outdoor run</h2><p>The key session of the week</p></div>
      <div class="session-body">
        ${itemRow({ exercise: "outdoor_run", run: dp.run }, colour)}
        ${dp.kickStage ? itemRow({ exercise: "kick", note: "Warm up, kick, then run." }, colour, `Kicking stage ${sug.stage}: ${stage.name}`) : ""}
        ${dp.strides ? `<p class="small muted">+ strides ${esc(dp.strides)} if your quad is green.</p>` : ""}
      </div>
      ${pos.status === "during" ? kickBlock + runBlock : ""}`;
  } else if (dp.kind === "kick_test") {
    const kick = await db.get("kicks", kickId(w.days[showDay].date));
    body = `<div class="card"><h2 style="margin-top:0">${dayLabel}: final kick test</h2><p>Warm up, then Stage 4 strikes. Record the pain score.</p>
      ${kick ? `<div class="done-banner">✓ Logged · pain ${kick.painDuring}/10 <button type="button" class="linkbtn" data-go="kicktest">Edit</button></div>`
        : `<button type="button" class="btn" data-go="kicktest">Log kick test</button>`}</div>`;
  } else {
    body = `<div class="card"><h2 style="margin-top:0">${dayLabel}: rest${dp.kind === "checkin" ? " + Sunday check-in" : ""}</h2>
      <p class="muted">${dp.kind === "checkin" ? "Rest, then five minutes to record your week." : "Recovery is part of the plan. An easy walk is fine."}</p></div>`;
  }

  // Missed an earlier gym day this week? Offer to do it today (counts once, for the planned day).
  let catchUp = "";
  if (pos.status === "during" && dp.kind !== "gym" && !inProgress) {
    const todayIso = isoDate(now);
    const missed = ["mon", "wed", "fri"].filter((k) => w.days[k].date < todayIso && !finishedDates.has(w.days[k].date));
    if (missed.length) {
      const k = missed[missed.length - 1];
      catchUp = `<div class="card"><b>Missed ${DAY_NAMES[k]}'s session?</b>
        <p class="muted small">You can do it today – it still counts once.</p>
        <button type="button" class="btn ghost" data-go="catchup" data-day="${k}">Do ${DAY_NAMES[k]}'s session now</button></div>`;
    }
  }

  const resume = inProgress && inProgress.date !== w.days[showDay].date
    ? `<div class="notice"><b>Unfinished workout:</b> ${esc(inProgress.title)} (${fmt(parseDate(inProgress.date), { weekday: "short", day: "numeric", month: "short" })})
       <button type="button" class="linkbtn" data-go="resume-other">Resume</button></div>` : "";

  // Next-morning quad check for yesterday's (or the day before's) run, kicks or gym session.
  const m = await pendingMorning(now);
  const scale = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const morningCard = m ? `<div class="card morning"><b>How's the quad this morning?</b>
      <p class="muted small">After your ${m.label} on ${fmt(parseDate(m.r.date), { weekday: "long" })}${m.during != null ? ` (pain during: ${m.during}/10)` : ""}. 0 = nothing, 10 = worst.</p>
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
    ${resume}
    <div class="card hero">${ring(pos.status === "before" ? 0 : week)}
      <div><div style="font-weight:700;font-size:18px">${headline}</div>
      <div class="muted small">${pos.status === "during" ? `Gym this week: <b style="color:#fff">${weekDone} of 3</b> · Total: <b style="color:#fff">${finished.length} of 30</b>` : esc(phase.focus)}</div></div></div>
    ${dayStrip(week, pos.status === "during" ? pos.dayKey : null, finishedDates)}
    ${body}
    ${catchUp}
    ${dp.kind === "gym" && w.sets_note !== "Sets as listed" ? `<div class="notice">${esc(w.sets_note)}</div>` : ""}
    ${notes}
    <button type="button" class="btn ghost" data-go="poster">🖼️ This phase at a glance</button>`;
}

// ------------------------------------------------------------------ phase infographic (pinch to zoom)
function openPoster() {
  const idx = getPlan().phases.indexOf(phaseFor(position(today(), state.start).week)) + 1;
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

// ------------------------------------------------------------------ other tabs (built in later steps)
function renderLater(title, step) {
  $screen.innerHTML = `<h1>${title}</h1><div class="card empty">Coming in build step ${step}.</div>`;
}

const screens = {
  today: renderToday,
  plan: () => renderLater("Plan", 2),
  progress: () => renderLater("Progress", 5),
  history: () => renderLater("History", 5),
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
  const backToToday = () => show("today");
  if (go === "poster") return openPoster();
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
      ?? newRun({ date: c.date, week: c.week, where: "outdoor", run: w.runs.sat, strides: w.strides, source: "today" });
    return runView.start(rec, backToToday);
  }
  if (go === "kick" || go === "kicktest") {
    const rec = (await db.get("kicks", kickId(c.date))) ?? await newKick(c.date, c.week, go === "kicktest");
    return kickView.start(rec, backToToday);
  }
  if (go === "start" || go === "resume") {
    return workout.start(await getOrCreateSession(c.week, c.dayKey, c.date, isoDate(today())));
  }
  if (go === "catchup") {
    const k = b.dataset.day;
    return workout.start(await getOrCreateSession(c.week, k, weekInfo(c.week).days[k].date, isoDate(today())));
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
