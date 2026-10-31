// Quad traffic light, next-morning check and the "two reds in 14 days" rule. Self-reported, not medical advice.
import * as db from "./db.js";
import { getPlan, addDays, isoDate, parseDate } from "./plan.js";
import { esc } from "./ui.js";

// Green 0–2, amber 3–4, red 5+. A next-morning score 2+ points worse than during counts as amber at least.
export function lightOf(during, morning = null) {
  const vals = [during, morning].filter((v) => v != null);
  if (!vals.length) return null;
  const worst = Math.max(...vals);
  if (worst >= 5) return "r";
  if (worst >= 3) return "a";
  if (during != null && morning != null && morning - during >= 2) return "a";
  return "g";
}

export function lightHtml(during, morning = null, { short = false } = {}) {
  const l = lightOf(during, morning);
  if (!l) return "";
  const tl = getPlan().traffic_light;
  if (l === "r") {
    return `<div class="light r"><b>Red</b> – ${esc(tl.red.meaning)}${short ? "" : `
      <p class="small" style="margin:6px 0 0"><b>Stop and get it checked (GP or physio) if you have:</b><br>${getPlan().stop_and_seek_advice.map(esc).join("<br>")}</p>`}</div>`;
  }
  if (l === "a") {
    const worse = during != null && morning != null && morning - during >= 2 && Math.max(during, morning) < 3;
    return `<div class="light a"><b>Amber</b> – ${esc(worse ? "Worse this morning than during. " : "")}${esc(tl.amber.meaning)}</div>`;
  }
  return `<div class="light g"><b>Green</b> – ${esc(tl.green.meaning)}</div>`;
}

const LABEL = { runs: "run", kicks: "kicking", sessions: "gym session" };

// Leg-day pain for a gym session: the session score, or the worst leg-exercise score.
function sessionPain(s) {
  const legs = s.items.map((i) => i.pain).filter((v) => v != null);
  return s.painDuring ?? (legs.length ? Math.max(...legs) : null);
}

async function finishedRecords() {
  const out = [];
  for (const store of ["runs", "kicks", "sessions"]) {
    for (const r of await db.all(store)) {
      if (r.status && r.status !== "finished") continue;
      const during = store === "sessions" ? sessionPain(r) : r.painDuring;
      out.push({ store, r, during });
    }
  }
  return out;
}

// The most recent run / kick / gym session from the last 2 days still waiting for a next-morning score.
export async function pendingMorning(todayDate) {
  const todayIso = isoDate(todayDate);
  const from = isoDate(addDays(todayDate, -2));
  const list = (await finishedRecords())
    .filter(({ r }) => r.date < todayIso && r.date >= from && r.painNextMorning == null && !r.morningSkipped)
    .filter(({ store, r }) => !(store === "runs" && r.source === "gym")) // the gym session's check covers it
    .sort((a, b) => (a.r.date < b.r.date ? 1 : -1));
  return list[0] ? { ...list[0], label: LABEL[list[0].store] } : null;
}

export async function saveMorning(store, id, value) {
  const r = await db.get(store, id);
  if (value == null) r.morningSkipped = true;
  else r.painNextMorning = value;
  await db.put(store, r);
  return r;
}

// Distinct days with a red score (during on the day, next-morning on the day after) in the last 14 days.
export async function redDays(todayDate) {
  const from = isoDate(addDays(todayDate, -13));
  const todayIso = isoDate(todayDate);
  const days = new Set();
  for (const { r, during } of await finishedRecords()) {
    if (during != null && during >= 5) days.add(r.date);
    if (r.painNextMorning != null && r.painNextMorning >= 5) days.add(isoDate(addDays(parseDate(r.date), 1)));
  }
  return [...days].filter((d) => d >= from && d <= todayIso).sort();
}
