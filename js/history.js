// History tab: everything logged, newest first. Tapping an entry opens it for editing.
import * as db from "./db.js";
import { parseDate } from "./plan.js";
import { esc, fmt } from "./ui.js";
import { lightOf } from "./symptoms.js";

const LIGHT = { g: "Green", a: "Amber", r: "Red" };

export async function renderHistory($screen) {
  const [sessions, runs, kicks, checkins] = await Promise.all(["sessions", "runs", "kicks", "checkins"].map((s) => db.all(s)));
  const rows = [
    ...sessions.map((s) => ({ store: "sessions", r: s, icon: "🏋️", title: s.title,
      detail: s.status === "finished" ? `${s.items.filter((i) => i.status === "done").length} exercises · ${s.durationMin ?? "–"} min${s.effort ? ` · effort ${s.effort}` : ""}` : "In progress",
      pain: s.painDuring, morning: s.painNextMorning })),
    ...runs.filter((r) => r.source !== "gym").map((r) => ({ store: "runs", r, icon: "🏃", title: r.where === "outdoor" ? "Outdoor run" : "Treadmill run",
      detail: r.status === "finished" ? `${r.totalRunMin ?? "–"} min running${r.longestMin != null ? ` · longest ${r.longestMin} min` : ""}${r.distanceKm ? ` · ${r.distanceKm} km` : ""}` : "In progress",
      pain: r.painDuring, morning: r.painNextMorning })),
    ...kicks.filter((k) => k.status === "finished").map((k) => ({ store: "kicks", r: k, icon: "⚽", title: k.test ? "Final kick test" : `Kicking – stage ${k.stage}`,
      detail: `${k.effortPct ? `hardest ${k.effortPct}%` : ""}`, pain: k.painDuring, morning: k.painNextMorning })),
    ...checkins.map((c) => ({ store: "checkins", r: c, icon: "📋", title: `Week ${c.week} check-in`,
      detail: [c.bodyweight != null && `${c.bodyweight} kg`, c.energy && `energy ${c.energy}/5`, c.win && `“${c.win}”`].filter(Boolean).join(" · "),
      pain: c.stretch, morning: null })),
  ].sort((a, b) => (a.r.date < b.r.date ? 1 : a.r.date > b.r.date ? -1 : 0));

  if (!rows.length) {
    $screen.innerHTML = `<h1>History</h1><div class="card empty">Nothing logged yet. Your sessions, runs, kicks and check-ins will appear here – tap any of them to correct it.</div>`;
    return;
  }
  let lastDate = "";
  const items = rows.map((x) => {
    const head = x.r.date !== lastDate ? `<h3 class="hdate">${fmt(parseDate(x.r.date), { weekday: "long", day: "numeric", month: "long" })}</h3>` : "";
    lastDate = x.r.date;
    const l = lightOf(x.pain, x.morning);
    return `${head}<button type="button" class="hist" data-go="h-open" data-store="${x.store}" data-id="${esc(x.r.id)}">
      <span class="hicon" aria-hidden="true">${x.icon}</span>
      <span class="htxt"><b>${esc(x.title)}</b><span class="muted small">${esc(x.detail)}</span></span>
      ${l ? `<span class="pill ${l}">${LIGHT[l]}</span>` : ""}<span class="chev" aria-hidden="true">›</span></button>`;
  }).join("");
  $screen.innerHTML = `<h1>History</h1><p class="muted small">Tap any entry to view or correct it.</p>${items}`;
}
