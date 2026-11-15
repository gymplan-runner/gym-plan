// Activities outside the plan (a swim, a class, a match…), entered after the event. Kept in kv "activities".
// They are extras: they never tick off a plan session, but they show in History, Progress, backups and CSVs.
import * as db from "./db.js";
import { getPlan, isoDate } from "./plan.js";
import { esc, toast, num, today } from "./ui.js";

const KEY = "activities";
export const TYPES = {
  swim: ["🏊", "Swim"], class: ["🧘", "Class"], walk: ["🚶", "Walk"], cycle: ["🚴", "Cycle"],
  sport: ["⚽", "Sport or match"], gym: ["🏋️", "Gym"], other: ["✳️", "Other"],
};
const TIMED = new Set(["plank", "side_plank", "farmer_carry"]);

export const loadActivities = async () => (await db.getSetting(KEY, null)) ?? [];
export const activityTitle = (a) => a.name || TYPES[a.type]?.[1] || "Activity";
export const activityIcon = (a) => TYPES[a.type]?.[0] ?? "✳️";

export function activityDetail(a) {
  const n = a.items?.length ?? 0;
  return [a.minutes != null && `${a.minutes} min`, a.km != null && `${a.km} km`, n && `${n} exercise${n === 1 ? "" : "s"}`,
    a.effort && `effort ${a.effort}`, "extra"].filter(Boolean).join(" · ");
}

async function saveActivity(a) {
  const list = (await loadActivities()).filter((x) => x.id !== a.id);
  list.push(a);
  list.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
  await db.setSetting(KEY, list);
}

async function removeActivity(id) {
  await db.setSetting(KEY, (await loadActivities()).filter((x) => x.id !== id));
}

const exName = (it) => (it.exercise ? getPlan().exercises[it.exercise]?.name ?? it.exercise : it.name);

// ------------------------------------------------------------------ view
export function createActivityView({ $screen, $tabs }) {
  let A = null, isNew = false, onDone;

  function start(rec, done) {
    onDone = done;
    isNew = !rec;
    A = rec ? structuredClone(rec)
      : { id: `act-${db.newId()}`, date: isoDate(today()), type: null, name: "", minutes: null, km: null,
        effort: null, pain: null, note: "", items: [] };
    $tabs.hidden = true;
    render();
    window.scrollTo(0, 0);
  }

  function leave() {
    A = null;
    $tabs.hidden = false;
    onDone();
  }

  function chips(act, values, selected, labels = {}) {
    return `<div class="chips" role="group">${values.map((v) =>
      `<button type="button" class="chip ${String(selected) === String(v) ? "on" : ""}" data-aact="${act}" data-v="${v}"
        aria-pressed="${String(selected) === String(v)}">${labels[v] ?? v}</button>`).join("")}</div>`;
  }

  function itemCard(it, i) {
    const timed = TIMED.has(it.exercise);
    const name = it.exercise
      ? `<b>${esc(exName(it))}</b>`
      : `<input class="in wide" data-afield="iname" data-i="${i}" value="${esc(it.name)}" placeholder="Exercise name" aria-label="Exercise name">`;
    const rows = it.sets.map((st, j) => `<div class="setrow"><span>Set ${j + 1}</span>
      <input class="in" inputmode="decimal" data-afield="kg" data-i="${i}" data-j="${j}" value="${st.kg ?? ""}" placeholder="kg" aria-label="Set ${j + 1} kg">
      <input class="in" inputmode="numeric" data-afield="${timed ? "seconds" : "reps"}" data-i="${i}" data-j="${j}"
        value="${(timed ? st.seconds : st.reps) ?? ""}" placeholder="${timed ? "sec" : "reps"}" aria-label="Set ${j + 1} ${timed ? "seconds" : "reps"}"></div>`).join("");
    return `<div class="card act-ex">${name}${rows}
      <button type="button" class="linkbtn" data-aact="addset" data-i="${i}">+ Add set</button>
      <button type="button" class="linkbtn" data-aact="delex" data-i="${i}" style="color:var(--muted)">Remove</button></div>`;
  }

  function render() {
    const ex = getPlan().exercises;
    const options = Object.entries(ex).filter(([, e]) => e.kind !== "stretch")
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .map(([k, e]) => `<option value="${k}">${esc(e.name)}</option>`).join("");
    const labels = Object.fromEntries(Object.entries(TYPES).map(([k, [icon, label]]) => [k, `${icon} ${label}`]));
    $screen.innerHTML = `
      <div class="wk-top" style="background:var(--navy)"><button type="button" class="back" data-aact="exit">‹ Back</button>
        <h1>${isNew ? "Enter an activity" : "Edit activity"}</h1><p>Anything outside your plan</p></div>
      <p class="muted small">Logged as an extra: it doesn't tick off a plan session.</p>
      <div class="card">
        <p class="q">What did you do?</p>
        ${chips("type", Object.keys(TYPES), A.type, labels)}
        <label class="mini">Name ${A.type === "other" ? "" : "(optional)"}<input class="in wide" data-afield="name" value="${esc(A.name)}"
          maxlength="40" placeholder="e.g. Body Pump, park swim, 5-a-side"></label>
        <label class="mini">Date<input class="in wide" type="date" data-afield="date" value="${A.date}" max="${isoDate(today())}"></label>
        <div class="setrow"><span>Minutes</span><input class="in" inputmode="numeric" data-afield="minutes" value="${A.minutes ?? ""}" aria-label="Minutes"></div>
        <div class="setrow"><span>km</span><input class="in" inputmode="decimal" data-afield="km" value="${A.km ?? ""}" placeholder="optional" aria-label="Distance in km"></div>
      </div>
      <h2>Exercises <span class="muted small">(optional)</span></h2>
      ${A.items.map(itemCard).join("")}
      <label class="mini">Add an exercise<select class="in wide" data-afield="addex">
        <option value="">Choose…</option><option value="__own">Something else (type it)</option>${options}</select></label>
      <div class="card">
        <p class="q">How hard was it overall? (1–10)</p>
        ${chips("effort", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], A.effort)}
        <p class="q">Quad pain during (0–10, optional)</p>
        ${chips("pain", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], A.pain)}
        <label class="mini">Note<textarea class="in wide" data-afield="note" rows="2" placeholder="Anything to remember?">${esc(A.note)}</textarea></label>
        <button type="button" class="btn" data-aact="save">${isNew ? "Save activity" : "Save changes"}</button>
      </div>
      ${isNew ? "" : `<button type="button" class="linkbtn" data-aact="delete" style="display:block;margin:4px auto 60px;color:var(--muted)">Delete this activity</button>`}`;
  }

  async function onClick(e) {
    const b = e.target.closest("[data-aact]");
    if (!b) return;
    const act = b.dataset.aact, i = Number(b.dataset.i);
    switch (act) {
      case "exit": return leave();
      case "type": A.type = b.dataset.v; break;
      case "effort": A.effort = A.effort === Number(b.dataset.v) ? null : Number(b.dataset.v); break;
      case "pain": A.pain = A.pain === Number(b.dataset.v) ? null : Number(b.dataset.v); break;
      case "addset": {
        const prev = A.items[i].sets[A.items[i].sets.length - 1];
        A.items[i].sets.push({ kg: prev?.kg ?? null, reps: null, seconds: null });
        break;
      }
      case "delex": A.items.splice(i, 1); break;
      case "save": {
        if (!A.type) { toast("Choose what you did"); return; }
        if (A.type === "other" && !A.name.trim()) { toast("Give it a name"); return; }
        if (!A.date || A.date > isoDate(today())) { toast("Pick a date up to today"); return; }
        A.name = A.name.trim();
        A.items = A.items.filter((it) => it.exercise || it.name.trim());
        await saveActivity(A);
        toast(isNew ? "Activity saved" : "Changes saved");
        return leave();
      }
      case "delete":
        if (!confirm("Delete this activity? This can't be undone.")) return;
        await removeActivity(A.id);
        toast("Activity deleted");
        return leave();
      default: return;
    }
    render();
  }

  function onInput(e) {
    const el = e.target.closest("[data-afield]");
    if (!el) return;
    const f = el.dataset.afield, i = Number(el.dataset.i), j = Number(el.dataset.j);
    if (f === "addex") {
      if (!el.value) return;
      A.items.push({ exercise: el.value === "__own" ? null : el.value, name: "", sets: [{ kg: null, reps: null, seconds: null }] });
      render();
      return;
    }
    if (f === "name" || f === "note" || f === "date") A[f] = el.value;
    else if (f === "minutes" || f === "km") A[f] = num(el.value);
    else if (f === "iname") A.items[i].name = el.value;
    else A.items[i].sets[j][f] = num(el.value);
  }

  $screen.addEventListener("click", (e) => { if (A) onClick(e); });
  $screen.addEventListener("input", (e) => { if (A && e.target.tagName !== "SELECT") onInput(e); });
  $screen.addEventListener("change", (e) => { if (A && e.target.tagName === "SELECT") onInput(e); });
  return { start, active: () => !!A };
}
