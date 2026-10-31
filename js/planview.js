// Plan tab: all 12 weeks (current week open) and the exercise guide with pictures.
import { getPlan, phaseFor, sessionFor, picto, doseText, DAY_COLOURS, parseDate } from "./plan.js";
import { esc, fmt } from "./ui.js";

const NAMES = { mon: "Monday", wed: "Wednesday", fri: "Friday", sat: "Saturday" };

function row(it, colour) {
  const ex = getPlan().exercises[it.exercise];
  return `<button type="button" class="item linkrow" data-go="guide" data-ex="${it.exercise}">
    <span class="pic-wrap">${picto(it.exercise, colour)}</span>
    <span class="txt"><span class="name">${esc(ex.name)}${it.optional ? ' <span class="tag">optional</span>' : ""}</span>
    <span class="dose">${esc(doseText(it))}</span></span><span class="chev" aria-hidden="true">›</span></button>`;
}

export function renderPlan($screen, currentWeek) {
  const plan = getPlan();
  const weeks = plan.weeks.map((w) => {
    const ph = phaseFor(w.week);
    const tag = w.test_week ? " · test week" : w.lighter_week ? " · lighter week" : "";
    const days = ["mon", "wed", "fri"].map((k) => {
      const s = sessionFor(w.week, k);
      return `<div class="session-head small-head" style="background:${DAY_COLOURS[k]}"><b>${NAMES[k]}: ${esc(s.title)}</b></div>
        <div class="session-body">${s.items.map((it) => row(it, DAY_COLOURS[k])).join("")}</div>`;
    }).join("");
    const stage = plan.kicking.stages.find((s) => s.stage === w.kick_stage);
    const sat = `<div class="session-head small-head" style="background:${DAY_COLOURS.sat}"><b>Saturday: outdoor run${w.kick_stage ? " + kicking" : ""}</b></div>
      <div class="session-body">${row({ exercise: "outdoor_run", run: w.runs.sat }, DAY_COLOURS.sat)}
      ${w.strides ? `<p class="small muted">+ strides ${esc(w.strides)} if your quad is green</p>` : ""}
      ${w.kick_stage ? `<p class="small"><b>Kicking stage ${w.kick_stage}:</b> ${esc(stage.what)}</p>` : ""}</div>`;
    return `<details class="week" ${w.week === currentWeek ? "open" : ""} id="wk-${w.week}">
      <summary><b>Week ${w.week}</b> <span class="muted small">${fmt(parseDate(w.start_date), { day: "numeric", month: "short" })} · ${esc(ph.name)}${tag}</span></summary>
      ${w.sets_note !== "Sets as listed" ? `<div class="notice">${esc(w.sets_note)}</div>` : ""}
      ${w.notes.length ? `<div class="notice">${w.notes.map(esc).join("<br>")}</div>` : ""}
      ${days}${sat}</details>`;
  }).join("");
  $screen.innerHTML = `<h1>Plan</h1>
    <div class="phase-btns">${plan.phases.map((p, i) => `<button type="button" class="btn ghost" data-go="poster" data-phase="${i + 1}">🖼️ ${esc(p.name)}<br><span class="small">weeks ${p.weeks[0]}–${p.weeks[p.weeks.length - 1]}</span></button>`).join("")}</div>
    <p class="muted small">Tap a week to open it, and any exercise for how to do it.</p>${weeks}
    <h2>Rules of thumb</h2><div class="card small">
      <p><b>Lifting:</b> ${esc(plan.lifting.progression)}</p><p>${esc(plan.lifting.reps_in_reserve)}</p>
      <p><b>Running:</b> ${esc(plan.running.pace)} ${esc(plan.running.rule)}</p>
      <p><b>Kicking:</b> ${esc(plan.kicking.rule)}</p></div>`;
}

export function openGuide(key) {
  const ex = getPlan().exercises[key];
  if (!ex) return;
  const el = document.createElement("div");
  el.className = "sheet";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", ex.name);
  el.innerHTML = `<div class="sheet-card"><div class="sheet-top"><h2>${esc(ex.name)}</h2><button type="button" class="back dark" data-close>Close</button></div>
    <div class="guide-pic">${picto(key, "#2f6fb3", "pic")}</div>
    <p class="muted small">Faint figure = start, solid = finish.</p>
    <p class="cue">${esc(ex.cue ?? "")}</p>
    <p><b>You need:</b> ${esc(ex.equipment)}</p><p>${esc(ex.what)}</p>
    <ol>${ex.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    ${ex.tips.map((t) => `<p class="tip">✓ ${esc(t)}</p>`).join("")}
    <p class="muted small">Machines vary between gyms – ask a member of staff to show you and set it up for your height.</p></div>`;
  el.addEventListener("click", (e) => { if (e.target === el || e.target.closest("[data-close]")) el.remove(); });
  document.body.append(el);
}
