// Progress tab: goals, attendance, 5 km journey, strength, plank, quad timeline, body. Real entries only.
import * as db from "./db.js";
import { getPlan, weekInfo, parseDate, isoDate } from "./plan.js";
import { esc, fmt, toast, num, today } from "./ui.js";
import { lineChart } from "./charts.js";
import { lightOf } from "./symptoms.js";

const LIFTS = [["leg_press", "Leg Press"], ["chest_press", "Chest Press"], ["seated_row", "Seated Row"]];

export async function loadAll() {
  const [sessions, runs, kicks, checkins] = await Promise.all(["sessions", "runs", "kicks", "checkins"].map((s) => db.all(s)));
  return {
    sessions: sessions.filter((s) => s.status === "finished"),
    runs: runs.filter((r) => r.status === "finished"),
    kicks: kicks.filter((k) => k.status === "finished"),
    checkins: checkins.sort((a, b) => a.week - b.week),
    baselines: (await db.getSetting("baselines", null)) ?? {},
  };
}

// Best value per week. pick(x) returns a number or null.
function perWeek(records, pick) {
  const m = new Map();
  for (const r of records) {
    const v = pick(r);
    if (v == null || !Number.isFinite(v)) continue;
    m.set(r.week, Math.max(m.get(r.week) ?? -Infinity, v));
  }
  return [...m].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
}

const doneSets = (it) => it.sets.filter((s) => s.done);
const topKg = (s, ex) => {
  const kgs = s.items.filter((i) => i.exercise === ex).flatMap(doneSets).map((x) => x.kg).filter((v) => v != null);
  return kgs.length ? Math.max(...kgs) : null;
};
const bestHold = (s) => {
  const v = s.items.filter((i) => i.exercise === "plank").flatMap(doneSets).map((x) => x.seconds).filter((x) => x != null);
  return v.length ? Math.max(...v) : null;
};

// The plan's longest non-stop run in a week (the Friday long run; Saturday in Week 1).
function longTarget(w) {
  const mins = Object.values(weekInfo(w).runs).filter(Boolean)
    .map((r) => (r.type === "run_walk" ? r.run_min : r.type === "continuous" ? r.minutes : null)).filter((v) => v != null);
  return mins.length ? Math.max(...mins) : null;
}

function fiveKDone(runs) {
  return runs.find((r) => (r.distanceKm ?? 0) >= 5 && r.longestMin != null && r.totalRunMin != null && r.longestMin >= r.totalRunMin * 0.95);
}

// ------------------------------------------------------------------ sections
function goalsSection(d, nowWeek) {
  const b = d.baselines;
  const longest = Math.max(0, ...d.runs.map((r) => r.longestMin ?? 0));
  const farthest = Math.max(0, ...d.runs.map((r) => r.distanceKm ?? 0));
  const five = fiveKDone(d.runs);
  const kickLatest = [...d.kicks].sort((a, c) => (a.date < c.date ? 1 : -1))[0];
  const plankBest = Math.max(0, ...d.sessions.map(bestHold).filter((v) => v != null));
  const strength = LIFTS.map(([ex, name]) => {
    const wk2 = Math.max(-Infinity, ...d.sessions.filter((s) => s.week === 2).map((s) => topKg(s, ex)).filter((v) => v != null));
    const latestS = [...d.sessions].filter((s) => s.week >= 3 && topKg(s, ex) != null).sort((a, c) => (a.date < c.date ? 1 : -1))[0];
    if (!Number.isFinite(wk2)) return `${name}: <span class="muted">baseline set in Week 2</span>`;
    if (!latestS) return `${name}: Week 2 ${wk2} kg`;
    const pct = Math.round((topKg(latestS, ex) / wk2 - 1) * 100);
    return `${name}: ${wk2} → ${topKg(latestS, ex)} kg <b>${pct >= 0 ? "+" : ""}${pct}%</b>${pct >= 25 ? " ✓" : ""}`;
  });
  const lastW = [...d.checkins].reverse().find((c) => c.bodyweight != null);
  const tile = (title, start, now, target, done = false) => `<div class="goal ${done ? "achieved" : ""}">
      <div class="g-title">${done ? "✓ " : ""}${title}</div>
      <div class="g-row"><span>Start</span><b>${start}</b></div><div class="g-row"><span>Now</span><b>${now}</b></div>
      <div class="g-row"><span>Target</span><b>${target}</b></div></div>`;
  const add = `<span class="muted">add it ↓</span>`;
  const none = `<span class="muted">no data yet</span>`;
  return `<h2>Goals</h2><div class="goals">
    ${tile("Run 5 km non-stop", b.runKm != null ? `${b.runKm} km` : add,
      five ? `${five.distanceKm} km ✓` : longest ? `${longest} min non-stop${farthest ? ` · ${farthest} km` : ""}` : none, "5 km by Sat 23 Jan", !!five)}
    ${tile("Kick hard, pain ≤1/10", b.kickPain != null ? `${b.kickPain}/10` : add,
      kickLatest ? `${kickLatest.painDuring}/10 at stage ${kickLatest.stage}` : none, "≤1/10 at stage 4",
      !!d.kicks.find((k) => k.stage === 4 && k.painDuring <= 1 && (k.painNextMorning ?? 99) <= 1))}
    ${tile("Gym sessions", "0", `${d.sessions.length}`, "30 of 36", d.sessions.length >= 30)}
    ${tile("Plank", b.plankSec != null ? `${b.plankSec} sec` : add, plankBest ? `${plankBest} sec` : none, "90 sec", plankBest >= 90)}
    <div class="goal wide"><div class="g-title">Main lifts +25% (vs Week 2, same machine)</div>${strength.map((s) => `<div class="g-row">${s}</div>`).join("")}</div>
    ${tile("Bodyweight", b.bodyweight != null ? `${b.bodyweight} kg` : add, lastW ? `${lastW.bodyweight} kg` : none, "Steady or slightly up")}
  </div>
  <p class="muted small">Week ${nowWeek} of 12. Goals are targets, not guarantees – progress at your own pace is still progress.</p>`;
}

function attendanceSection(d, todayIso) {
  const finished = new Set(d.sessions.map((s) => s.date));
  const runDates = new Set(d.runs.filter((r) => r.where === "outdoor").map((r) => r.date));
  const cols = ["mon", "wed", "fri", "sat"];  // Saturday only has a run in Week 1 and the 5 km week
  const rows = getPlan().weeks.map((w) => {
    const cells = cols.map((k) => {
      const date = w.days[k].date;
      if (k === "sat" && w.days.sat.plan !== "run") return `<td class="rest" aria-label="Saturday week ${w.week}: rest"></td>`;
      const done = k === "sat" ? runDates.has(date) : finished.has(date);
      const cls = done ? "done" : date < todayIso ? "missed" : date === todayIso ? "today" : "planned";
      const sym = done ? "✓" : date < todayIso ? "–" : date === todayIso ? "●" : "";
      const label = `${k.toUpperCase()} week ${w.week}: ${done ? "done" : date < todayIso ? "not done" : date === todayIso ? "today" : "planned"}`;
      return `<td class="${cls}${k === "sat" ? " sat" : ""}" aria-label="${label}" title="${label}">${sym}</td>`;
    }).join("");
    return `<tr class="${w.lighter_week ? "lighter" : ""}"><th>${w.week}</th>${cells}</tr>`;
  }).join("");
  return `<h2>Attendance</h2><div class="card">
    <p><b>${d.sessions.length}</b> of 30 gym sessions</p>
    <table class="att"><tr><th>Wk</th><th>Mon</th><th>Wed</th><th>Fri</th><th>Sat</th></tr>${rows}</table>
    <p class="muted small">✓ done · – not done · ● today · blank = still to come. Shaded weeks are lighter weeks.</p></div>`;
}

function runSection(d) {
  if (!d.runs.length) return `<h2>5 km journey</h2><div class="card empty">Your first run will start this chart.</div>`;
  const actual = perWeek(d.runs, (r) => r.longestMin);
  const plan = getPlan().weeks.map((w) => ({ x: w.week, y: longTarget(w.week) })).filter((p) => p.y != null);
  const five = fiveKDone(d.runs);
  return `<h2>5 km journey</h2><div class="card">
    ${five ? `<p class="win">🎉 5 km non-stop on ${fmt(parseDate(five.date), { day: "numeric", month: "long" })}!</p>` : ""}
    ${actual.length >= 2 ? lineChart({ title: "Longest non-stop run (minutes) by week", unit: " min",
      series: [{ name: "You", points: actual }, { name: "Plan (long run)", points: plan, dashed: true }] })
      : `<p>Longest non-stop run so far: <b>${actual[0].y} min</b> (week ${actual[0].x}). The chart appears after your second week of runs.</p>`}
    <p class="muted small">5 km is roughly 30–35 minutes at an easy pace.</p></div>`;
}

function strengthSection(d) {
  const blocks = LIFTS.map(([ex, name]) => {
    const pts = perWeek(d.sessions, (s) => topKg(s, ex));
    if (!pts.length) return "";
    const wk2 = pts.find((p) => p.x === 2)?.y;
    const settings = new Set(d.sessions.flatMap((s) => s.items.filter((i) => i.exercise === ex && i.setting).map((i) => i.setting.trim().toLowerCase())));
    const note = settings.size > 1 ? `<p class="muted small">Machine settings changed along the way – compare with care.</p>` : "";
    return pts.length >= 2
      ? lineChart({ title: `${name} – heaviest set (kg)`, unit: " kg", series: [{ name, points: pts }],
          goal: wk2 ? Math.round(wk2 * 1.25 * 2) / 2 : undefined, goalLabel: wk2 ? `+25% = ${Math.round(wk2 * 1.25 * 2) / 2} kg` : undefined }) + note
      : `<p><b>${name}:</b> ${pts[0].y} kg (week ${pts[0].x})</p>`;
  }).join("");
  return `<h2>Strength</h2><div class="card">${blocks || `<div class="empty">Log your first gym session to see your lifts here.</div>`}
    <p class="muted small">The +25% goal is measured from your heaviest Week 2 set, on the same machine.</p></div>`;
}

function plankSection(d) {
  const pts = perWeek(d.sessions, bestHold);
  if (!pts.length) return "";
  return `<h2>Plank</h2><div class="card">${pts.length >= 2
    ? lineChart({ title: "Best plank hold (seconds)", unit: "s", series: [{ name: "Plank", points: pts }], goal: 90, goalLabel: "Goal 90s" })
    : `<p>Best hold: <b>${pts[0].y} sec</b> (week ${pts[0].x}).</p>`}</div>`;
}

function quadSection(d) {
  const sessPain = (s) => s.painDuring ?? (s.items.some((i) => i.pain != null) ? Math.max(...s.items.map((i) => i.pain ?? -1)) : null);
  const rows = [
    ...d.sessions.map((s) => ({ date: s.date, what: s.title, during: sessPain(s), morning: s.painNextMorning })),
    ...d.runs.filter((r) => r.source !== "gym").map((r) => ({ date: r.date, what: "Run", during: r.painDuring, morning: r.painNextMorning })),
    ...d.kicks.map((k) => ({ date: k.date, what: k.test ? "Kick test" : `Kicking stage ${k.stage}`, during: k.painDuring, morning: k.painNextMorning })),
    ...d.checkins.filter((c) => c.stretch != null).map((c) => ({ date: c.date, what: "Stretch test", during: c.stretch, morning: null })),
  ].filter((r) => r.during != null || r.morning != null).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 30);
  if (!rows.length) return `<h2>Quad</h2><div class="card empty">Pain scores you log will show here.</div>`;
  const name = { g: "Green", a: "Amber", r: "Red" };
  return `<h2>Quad</h2><div class="card"><p class="muted small">Self-reported scores (0–10), most recent first. This is tracking, not a medical assessment.</p>
    <table class="quad"><tr><th>Date</th><th>Activity</th><th>During</th><th>Next am</th><th></th></tr>
    ${rows.map((r) => { const l = lightOf(r.during, r.morning); return `<tr><td>${fmt(parseDate(r.date), { day: "numeric", month: "short" })}</td><td>${esc(r.what)}</td>
      <td>${r.during ?? "–"}</td><td>${r.morning ?? "–"}</td><td><span class="pill ${l}">${name[l] ?? ""}</span></td></tr>`; }).join("")}</table></div>`;
}

function bodySection(d) {
  const bw = d.checkins.filter((c) => c.bodyweight != null).map((c) => ({ x: c.week, y: c.bodyweight }));
  const waist = d.checkins.filter((c) => c.waist != null).map((c) => ({ x: c.week, y: c.waist }));
  if (!bw.length && !waist.length) return `<h2>Body</h2><div class="card empty">Bodyweight and waist come from your Sunday check-ins.</div>`;
  const lo = (pts) => Math.floor(Math.min(...pts.map((p) => p.y)) - 3);
  return `<h2>Body</h2><div class="card">
    ${bw.length >= 2 ? lineChart({ title: "Bodyweight (kg)", unit: " kg", series: [{ name: "Bodyweight", points: bw }], yMin: lo(bw), yMax: Math.ceil(Math.max(...bw.map((p) => p.y)) + 3) })
      : bw.length ? `<p>Bodyweight: <b>${bw[0].y} kg</b> (week ${bw[0].x})</p>` : ""}
    ${waist.length ? `<p>Waist: ${waist.map((p) => `wk ${p.x}: <b>${p.y} cm</b>`).join(" · ")}</p>` : ""}
    <p class="muted small">Goal: stronger, with bodyweight steady or slightly up and waist not increasing.</p></div>`;
}

function baselinesForm(b) {
  const f = (id, label, val, hint) => `<label class="mini">${label}<input class="in wide" inputmode="decimal" data-bfield="${id}" value="${val ?? ""}" placeholder="${hint}"></label>`;
  return `<h2 id="baselines">Your starting values</h2><div class="card">
    <p class="muted small">Private – only on this phone. Measure them before or during Week 1; leave anything you don't know blank.</p>
    ${f("runKm", "Furthest you can run non-stop (km)", b.runKm, "e.g. 1")}
    ${f("plankSec", "Plank – best hold (seconds)", b.plankSec, "e.g. 30")}
    ${f("kickPain", "Kick pain when striking hard (0–10)", b.kickPain, "e.g. 4")}
    ${f("bodyweight", "Bodyweight (kg)", b.bodyweight, "e.g. 80")}
    ${f("waist", "Waist (cm)", b.waist, "e.g. 94")}
    <button type="button" class="btn" data-pact="save-baselines">Save starting values</button></div>`;
}

export async function renderProgress($screen) {
  const d = await loadAll();
  const start = await db.getSetting("startDate", getPlan().meta.start_date);
  const now = today();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - parseDate(start)) / 86400000);
  const nowWeek = Math.min(12, Math.max(1, Math.floor(days / 7) + 1));
  $screen.innerHTML = `<h1>Progress</h1>
    ${goalsSection(d, nowWeek)}
    ${attendanceSection(d, isoDate(now))}
    ${runSection(d)}
    ${strengthSection(d)}
    ${plankSection(d)}
    ${quadSection(d)}
    ${bodySection(d)}
    ${baselinesForm(d.baselines)}`;
}

export function bindProgress($screen, isActive) {
  $screen.addEventListener("click", async (e) => {
    if (!isActive()) return;
    if (!e.target.closest("[data-pact=save-baselines]")) return;
    const b = (await db.getSetting("baselines", null)) ?? {};
    for (const el of $screen.querySelectorAll("[data-bfield]")) b[el.dataset.bfield] = num(el.value);
    b.updated = isoDate(new Date());
    await db.setSetting("baselines", b);
    toast("Starting values saved");
    renderProgress($screen);
  });
}
