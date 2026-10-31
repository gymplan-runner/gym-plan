// Loads the plan file and works out what applies on any given date.
export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const DAY_COLOURS = { mon: "#2f6fb3", wed: "#2e8b57", fri: "#7b4fb8", sat: "#d9822b" };

// Exercises that count as "leg work" (dropped on Friday of test week).
export const LEG_WORK = new Set(["leg_press", "leg_extension", "leg_curl", "split_squat", "goblet_squat", "db_rdl",
  "step_up", "calf_raise", "glute_bridge", "cable_knee_drive", "reverse_nordic"]);

let plan, pictos;

// Typographic dashes for display (" - " and ranges like "10-12"), leaving date fields untouched.
function prettify(v, key = "") {
  if (typeof v === "string") {
    return /(date|due|created)$/.test(key) || /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : v.replaceAll(" - ", " – ").replace(/(\d)-(\d)/g, "$1–$2");
  }
  if (Array.isArray(v)) return v.map((x) => prettify(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, prettify(x, k)]));
  return v;
}

export async function loadPlan() {
  if (!plan) {
    [plan, pictos] = await Promise.all([
      fetch("data/plan.json").then((r) => r.json()).then(prettify),
      fetch("data/pictos.json").then((r) => r.json()),
    ]);
  }
  return plan;
}

export const getPlan = () => plan;

export function picto(key, accent = "#2f6fb3", cls = "pic") {
  const inner = pictos?.[key];
  if (!inner) return "";
  return `<svg class="${cls}" viewBox="0 0 120 100" aria-hidden="true">${inner.replaceAll("__ACCENT__", accent)}</svg>`;
}

export function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function isoDate(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// Where a date falls in the programme. Uses whole local days so clocks changes don't shift weeks.
export function position(date, startIso) {
  const start = parseDate(startIso);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((day - start) / 86400000);
  const dayKey = DAY_KEYS[(day.getDay() + 6) % 7];
  if (days < 0) return { status: "before", daysToStart: -days, week: 1, dayKey };
  const week = Math.floor(days / 7) + 1;
  if (week > 12) return { status: "after", week: 12, dayKey };
  return { status: "during", week, dayKey };
}

export const weekInfo = (week) => plan.weeks[week - 1];
export const phaseFor = (week) => plan.phases.find((p) => p.weeks.includes(week));

function adjustSets(item, week, dayKey) {
  if (!item.sets) return item;
  const w = weekInfo(week);
  let sets = item.sets;
  if (week <= 2) sets = Math.min(sets, 2);
  else if (w.lighter_week || (w.test_week && dayKey === "wed")) sets = Math.max(1, sets - 1);
  return { ...item, sets };
}

// The session for a gym day, with this week's set counts and run already applied.
export function sessionFor(week, dayKey) {
  const phase = phaseFor(week);
  const template = phase?.sessions[dayKey];
  if (!template) return null;
  const w = weekInfo(week);
  let items = template.items.map((it) => adjustSets(it, week, dayKey));
  if (w.test_week && dayKey === "fri") items = items.filter((it) => !LEG_WORK.has(it.exercise));
  items = items.map((it) => (it.exercise === "treadmill_run" ? { ...it, run: w.runs[dayKey] } : it));
  if (dayKey === "fri" && w.runs.fri.type === "cross_trainer" && !items.some((it) => it.exercise === "cross_trainer")) {
    items = items.map((it) => (it.exercise === "treadmill_run"
      ? { exercise: "cross_trainer", minutes: w.runs.fri.minutes, note: w.runs.fri.text } : it));
  }
  return { ...template, items, phase, week: w };
}

// What's planned for a date: gym session, Saturday run, kick test, or rest.
export function dayPlan(week, dayKey) {
  const w = weekInfo(week);
  const d = w.days[dayKey];
  if (d.plan === "gym") return { kind: "gym", session: sessionFor(week, dayKey) };
  if (d.plan === "run") return { kind: "run", run: w.runs.sat, strides: w.strides, kickStage: w.kick_stage };
  if (d.plan === "kick_test") return { kind: "kick_test" };
  return { kind: dayKey === "sun" ? "checkin" : "rest" };
}

export function doseText(it) {
  const side = it.per_side ? " each side" : "";
  const dash = (s) => String(s).replace("-", "–");
  if (it.sets && it.reps) return `${it.sets} × ${dash(it.reps)}${side}`;
  if (it.sets && it.seconds) return `${it.sets} × ${dash(it.seconds)} sec${side}`;
  if (it.minutes) return `${dash(it.minutes)} min`;
  if (it.run) return runText(it.run);
  return "";
}

export function runText(r) {
  if (r.type === "run_walk") return `${r.reps} × ${r.run_min} min run, ${r.walk_min} min walk`;
  if (r.type === "continuous") return `${r.minutes} min non-stop`;
  if (r.type === "cross_trainer") return `Cross trainer ${r.minutes} min`;
  if (r.type === "test") return `${r.distance_km} km run`;
  return r.text;
}
