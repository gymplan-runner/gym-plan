// Your own long-term goals ("By Nov 2027 I want to do a Body Pump class"): your own steps, ticked by you.
// The bar is steps reached out of steps set, so nothing is guessed. Kept in kv "ownGoals".
import * as db from "./db.js";
import { parseDate, isoDate } from "./plan.js";
import { esc, fmt, toast, today } from "./ui.js";

const KEY = "ownGoals";
const MAX_STEPS = 5;
const load = async () => (await db.getSetting(KEY, null)) ?? [];
let editing = null;  // goal being added or edited

function timeLeft(by) {
  const days = Math.round((parseDate(by) - today()) / 86400000);
  if (days < 0) return "target date passed";
  if (days < 60) return `${days} day${days === 1 ? "" : "s"} left`;
  return `about ${Math.round(days / 30.4)} months left`;
}

function goalCard(g) {
  const done = g.steps.filter((s) => s.done).length;
  const pct = Math.round((done / g.steps.length) * 100);
  const all = done === g.steps.length;
  return `<div class="card owngoal ${all ? "achieved" : ""}"><b>${all ? "✓ " : ""}${esc(g.text)}</b>
    <p class="muted small">By ${fmt(parseDate(g.by), { day: "numeric", month: "long", year: "numeric" })} · ${all ? "reached 🎉" : timeLeft(g.by)}</p>
    <div class="bar" role="img" aria-label="${done} of ${g.steps.length} steps reached"><span style="width:${pct}%"></span></div>
    <p class="small"><b>${done} of ${g.steps.length}</b> steps reached</p>
    ${g.steps.map((s, j) => `<button type="button" class="step ${s.done ? "on" : ""}" data-og="tick" data-id="${esc(g.id)}" data-j="${j}"
      aria-pressed="${!!s.done}"><span>${s.done ? "✓" : "○"}</span>${esc(s.text)}${s.done && s.at ? ` <span class="muted small">${fmt(parseDate(s.at), { day: "numeric", month: "short" })}</span>` : ""}</button>`).join("")}
    <button type="button" class="linkbtn" data-og="edit" data-id="${esc(g.id)}">Edit</button></div>`;
}

function form(exists) {
  const steps = Array.from({ length: MAX_STEPS }, (_, j) => editing.steps[j]?.text ?? "");
  return `<div class="card" id="owngoal-form"><b>${exists ? "Edit goal" : "New goal"}</b>
    <label class="mini">Your goal<input class="in wide" data-ogf="text" maxlength="80" value="${esc(editing.text)}" placeholder="e.g. Do a full Body Pump class"></label>
    <label class="mini">By<input class="in wide" type="date" data-ogf="by" value="${editing.by ?? ""}"></label>
    <p class="q">Steps on the way (2–5)</p>
    <p class="muted small">Small, clear steps you can tick, e.g. "Try a class", "Do half a class", "Do a full class".</p>
    ${steps.map((t, j) => `<input class="in wide" data-ogf="step" data-j="${j}" maxlength="60" value="${esc(t)}" placeholder="Step ${j + 1}${j > 1 ? " (optional)" : ""}" aria-label="Step ${j + 1}">`).join("")}
    <div class="row2"><button type="button" class="btn ghost" data-og="cancel">Cancel</button><button type="button" class="btn" data-og="save">Save goal</button></div>
    ${exists ? `<button type="button" class="linkbtn" data-og="delete" style="color:var(--muted)">Delete this goal</button>` : ""}</div>`;
}

export async function ownGoalsSection() {
  const list = await load();
  return `<h2 id="owngoals">My own goals</h2>
    <p class="muted small">Longer-term goals of your own, beyond the 12 weeks. Tick each step when you reach it.</p>
    ${list.filter((g) => g.id !== editing?.id).map(goalCard).join("")}
    ${editing ? form(list.some((g) => g.id === editing.id)) : `<button type="button" class="btn ghost" data-og="add">+ Set a goal of your own</button>`}`;
}

export function bindOwnGoals($screen, isActive, rerender) {
  $screen.addEventListener("input", (e) => {
    const el = e.target.closest("[data-ogf]");
    if (!isActive() || !el || !editing) return;
    if (el.dataset.ogf === "step") {
      const j = Number(el.dataset.j);
      editing.steps[j] = { ...(editing.steps[j] ?? { done: false }), text: el.value };
    } else editing[el.dataset.ogf] = el.value;
  });
  $screen.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-og]");
    if (!isActive() || !b) return;
    const list = await load();
    const act = b.dataset.og;
    if (act === "add") editing = { id: `goal-${db.newId()}`, text: "", by: "", steps: [] };
    else if (act === "edit") editing = structuredClone(list.find((g) => g.id === b.dataset.id));
    else if (act === "cancel") editing = null;
    else if (act === "tick") {
      const g = list.find((x) => x.id === b.dataset.id), s = g.steps[Number(b.dataset.j)];
      s.done = !s.done;
      if (s.done) s.at = isoDate(today()); else delete s.at;
      await db.setSetting(KEY, list);
    } else if (act === "delete") {
      if (!confirm("Delete this goal?")) return;
      await db.setSetting(KEY, list.filter((g) => g.id !== editing.id));
      editing = null;
    } else if (act === "save") {
      const steps = Array.from({ length: MAX_STEPS }, (_, j) => editing.steps[j]).filter((s) => s?.text?.trim())
        .map((s) => ({ ...s, text: s.text.trim(), done: !!s.done }));
      if (!editing.text.trim()) { toast("Write your goal"); return; }
      if (!editing.by) { toast("Pick a target date"); return; }
      if (steps.length < 2) { toast("Add at least 2 steps"); return; }
      const g = { id: editing.id, text: editing.text.trim(), by: editing.by, steps, created: editing.created ?? isoDate(today()) };
      await db.setSetting(KEY, [...list.filter((x) => x.id !== g.id), g]);
      editing = null;
      toast("Goal saved");
    }
    await rerender();
    if (act !== "tick") document.getElementById(editing ? "owngoal-form" : "owngoals")?.scrollIntoView({ block: "start" });
  });
}
