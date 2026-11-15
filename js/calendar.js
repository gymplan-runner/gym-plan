// Calendar: match days, holidays and other events, marked on Today and the Plan tab. Markers only: the plan never moves.
import * as db from "./db.js";
import { parseDate, isoDate, addDays } from "./plan.js";
import { esc, fmt, toast, today } from "./ui.js";

const KEY = "calendarEvents";
export const EVENT_TYPES = { match: ["⚽", "Match day"], holiday: ["🏖️", "Holiday"], event: ["📅", "Event"], other: ["📌", "Other"] };
const HINT = { holiday: "Rest counts too. Do what you can, or nothing at all." };

export const loadEvents = async () => (await db.getSetting(KEY, null)) ?? [];
const until = (ev) => ev.to || ev.from;
export const eventsBetween = (list, fromIso, toIso) => list.filter((ev) => ev.from <= toIso && until(ev) >= fromIso);
const label = (ev) => `${EVENT_TYPES[ev.type]?.[0] ?? "📌"} ${esc(EVENT_TYPES[ev.type]?.[1] ?? "Event")}${ev.note ? `: ${esc(ev.note)}` : ""}`;
const short = (iso) => fmt(parseDate(iso), { weekday: "short", day: "numeric", month: "short" });
export const when = (ev) => (ev.to && ev.to !== ev.from ? `${short(ev.from)} – ${short(ev.to)}` : short(ev.from));

// Today: anything happening today, and what's coming up in the next 7 days.
export async function todayEventsCard(now) {
  const list = await loadEvents();
  const t = isoDate(now);
  const on = eventsBetween(list, t, t);
  const soon = eventsBetween(list, isoDate(addDays(now, 1)), isoDate(addDays(now, 7))).filter((ev) => ev.from > t);
  if (!on.length && !soon.length) return "";
  return `<div class="card cal-today">${on.map((ev) => `<p><b>${label(ev)}</b>${until(ev) > t ? ` <span class="muted small">until ${short(until(ev))}</span>` : ""}
      ${HINT[ev.type] ? `<br><span class="small">${HINT[ev.type]}</span>` : ""}</p>`).join("")}
    ${soon.length ? `<p class="muted small">Coming up: ${soon.map((ev) => `${label(ev)} (${when(ev)})`).join(" · ")}</p>` : ""}</div>`;
}

// Plan tab: the list of events and a form to add or edit one.
let editing = null;  // event being added or edited, or null
export function calendarCard(list) {
  const t = isoDate(today());
  const upcoming = list.filter((ev) => until(ev) >= t).sort((a, b) => (a.from < b.from ? -1 : 1));
  const rows = upcoming.map((ev) => `<div class="cal-row"><span>${label(ev)}<br><span class="muted small">${when(ev)}</span></span>
    <button type="button" class="linkbtn" data-cal="edit" data-id="${esc(ev.id)}">Edit</button></div>`).join("");
  const form = editing ? `<div class="cal-form">
      <div class="chips" role="group">${Object.entries(EVENT_TYPES).map(([k, [icon, name]]) =>
        `<button type="button" class="chip ${editing.type === k ? "on" : ""}" data-cal="type" data-v="${k}" aria-pressed="${editing.type === k}">${icon} ${name}</button>`).join("")}</div>
      <label class="mini">From<input class="in wide" type="date" data-calf="from" value="${editing.from ?? ""}"></label>
      <label class="mini">To (optional, for more than one day)<input class="in wide" type="date" data-calf="to" value="${editing.to ?? ""}"></label>
      <label class="mini">Note (optional)<input class="in wide" data-calf="note" maxlength="60" value="${esc(editing.note ?? "")}" placeholder="e.g. away game, Spain"></label>
      <div class="row2"><button type="button" class="btn ghost" data-cal="cancel">Cancel</button><button type="button" class="btn" data-cal="save">Save</button></div>
      ${list.some((ev) => ev.id === editing.id) ? `<button type="button" class="linkbtn" data-cal="delete" style="color:var(--muted)">Delete this event</button>` : ""}
    </div>` : `<button type="button" class="btn ghost" data-cal="add">+ Add a match day, holiday or event</button>`;
  return `<div class="card" id="calendar"><b>Your calendar</b>
    <p class="muted small">Marked on Today and here. The plan doesn't move.</p>${rows}${form}</div>`;
}

export function bindCalendar($screen, isActive, rerender) {
  $screen.addEventListener("input", (e) => {
    const el = e.target.closest("[data-calf]");
    if (!isActive() || !el || !editing) return;
    editing[el.dataset.calf] = el.value;
  });
  $screen.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-cal]");
    if (!isActive() || !b) return;
    const list = await loadEvents();
    const act = b.dataset.cal;
    if (act === "add") editing = { id: `ev-${db.newId()}`, type: null, from: isoDate(today()), to: "", note: "" };
    else if (act === "edit") editing = { ...list.find((ev) => ev.id === b.dataset.id) };
    else if (act === "type") editing.type = b.dataset.v;
    else if (act === "cancel") editing = null;
    else if (act === "delete") {
      if (!confirm("Delete this event?")) return;
      await db.setSetting(KEY, list.filter((ev) => ev.id !== editing.id));
      editing = null;
      toast("Event deleted");
    } else if (act === "save") {
      if (!editing.type) { toast("Choose a type"); return; }
      if (!editing.from) { toast("Pick a date"); return; }
      if (editing.to && editing.to < editing.from) { toast("The end date is before the start"); return; }
      const ev = { id: editing.id, type: editing.type, from: editing.from, to: editing.to && editing.to !== editing.from ? editing.to : null,
        note: (editing.note ?? "").trim() };
      await db.setSetting(KEY, [...list.filter((x) => x.id !== ev.id), ev].sort((a, c) => (a.from < c.from ? -1 : 1)));
      editing = null;
      toast("Saved");
    }
    await rerender();
    document.getElementById("calendar")?.scrollIntoView({ block: "start" });
  });
}
