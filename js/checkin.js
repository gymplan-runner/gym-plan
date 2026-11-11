// Sunday check-in: what the app already knows, plus bodyweight, waist, stretch test, energy, enjoyment, win.
import * as db from "./db.js";
import { weekInfo, phaseFor, runText } from "./plan.js";
import { esc, toast, celebrate, num } from "./ui.js";
import { lightHtml } from "./symptoms.js";

export const checkinId = (week) => `checkin-${week}`;

async function weekFacts(week) {
  const w = weekInfo(week);
  const inWeek = (r) => r.date >= w.start_date && r.date <= w.end_date;
  const sessions = (await db.all("sessions")).filter((s) => s.status === "finished" && s.week === week);
  const runs = (await db.all("runs")).filter((r) => r.status === "finished" && inWeek(r));
  const kicks = (await db.all("kicks")).filter((k) => k.status === "finished" && inWeek(k));
  const holds = sessions.flatMap((s) => s.items.filter((i) => i.exercise === "plank").flatMap((i) => i.sets.filter((x) => x.done).map((x) => x.seconds)))
    .filter((v) => v != null);
  return {
    sessions: sessions.length,
    runs: runs.length,
    plank: holds.length ? Math.max(...holds) : null,
    longest: runs.length ? Math.max(...runs.map((r) => r.longestMin ?? 0)) : null,
    kickPain: kicks.length ? Math.max(...kicks.map((k) => k.painDuring)) : null,
  };
}

export function createCheckinView({ $screen, $tabs }) {
  let C, F, onDone;

  async function start(week, date, done) {
    onDone = done;
    C = (await db.get("checkins", checkinId(week))) ?? { id: checkinId(week), kind: "checkin", week, date,
      bodyweight: null, waist: null, stretch: null, energy: null, enjoyment: null, win: "" };
    F = await weekFacts(week);
    $tabs.hidden = true;
    render();
  }

  function stop() { C = null; $tabs.hidden = false; }

  function chips(act, values, sel) {
    return `<div class="chips">${values.map((v) => `<button type="button" class="chip ${sel === v ? "on" : ""}" data-cact="${act}" data-v="${v}" aria-pressed="${sel === v}">${v}</button>`).join("")}</div>`;
  }

  function render() {
    const w = weekInfo(C.week);
    const next = C.week < 12 ? weekInfo(C.week + 1) : null;
    const nextPhase = next && phaseFor(next.week) !== phaseFor(C.week) ? ` – <b>Phase change: ${esc(phaseFor(next.week).name)}</b>` : "";
    const fact = (label, v) => `<div class="g-row"><span>${label}</span><b>${v ?? "–"}</b></div>`;
    $screen.innerHTML = `<div class="wk-top" style="background:var(--navy)"><button type="button" class="back" data-cact="exit">‹ Back</button>
        <h1>Week ${C.week} check-in</h1><p>Five minutes to record your week</p></div>
      <div class="card"><b>This week, from your logs</b>
        ${fact("Gym sessions", `${F.sessions} of 3`)}${fact("Runs", `${F.runs} of ${Object.values(w.runs).filter(Boolean).length}`)}
        ${fact("Longest non-stop run", F.longest != null ? `${F.longest} min` : null)}${fact("Best plank", F.plank != null ? `${F.plank} sec` : null)}
        ${fact("Kick pain (highest)", F.kickPain != null ? `${F.kickPain}/10` : null)}</div>
      <div class="card">
        <label class="mini">Bodyweight (kg) – same morning each week<input class="in wide" inputmode="decimal" data-cfield="bodyweight" value="${C.bodyweight ?? ""}"></label>
        ${w.measure_waist ? `<label class="mini">Waist (cm) – measuring week<input class="in wide" inputmode="decimal" data-cfield="waist" value="${C.waist ?? ""}"></label>` : ""}
        <p class="q">Quad stretch test (0–10) <span class="muted small">gentle standing quad stretch, 20 seconds</span></p>
        ${chips("stretch", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], C.stretch)}${lightHtml(C.stretch)}
        <p class="q">Energy this week (1–5)</p>${chips("energy", [1, 2, 3, 4, 5], C.energy)}
        <p class="q">Enjoyment (1–5)</p>${chips("enjoyment", [1, 2, 3, 4, 5], C.enjoyment)}
        <label class="mini">Win of the week<input class="in wide" data-cfield="win" value="${esc(C.win)}" placeholder="Anything you're pleased with"></label>
        <button type="button" class="btn" data-cact="save">Save check-in</button></div>
      ${next ? `<div class="card"><b>Next week (week ${next.week})</b>${nextPhase}
        <p class="small">Runs: ${["mon", "wed", "fri", "sat"].filter((k) => next.runs[k]).map((k) => `${k[0].toUpperCase() + k.slice(1)} ${esc(runText(next.runs[k]))}`).join(" · ")}${next.strides ? ` · Fri + strides ${esc(next.strides)}` : ""}</p>
        ${next.notes.length ? `<p class="small">${next.notes.map(esc).join("<br>")}</p>` : ""}</div>` : ""}`;
  }

  $screen.addEventListener("click", async (e) => {
    if (!C) return;
    const b = e.target.closest("[data-cact]");
    if (!b) return;
    const act = b.dataset.cact, v = Number(b.dataset.v);
    if (act === "exit") { stop(); return onDone(); }
    if (act === "save") {
      C.status = "finished";
      await db.put("checkins", C);
      const { week, win } = C;
      stop();
      celebrate(`Week ${week} done`, win ? `Win of the week: ${win}` : "One week closer. Rest well.");
      return onDone();
    }
    C[act] = C[act] === v ? null : v;
    render();
  });

  $screen.addEventListener("input", (e) => {
    if (!C) return;
    const el = e.target.closest("[data-cfield]");
    if (el) C[el.dataset.cfield] = el.dataset.cfield === "win" ? el.value : num(el.value);
  });

  return { start, active: () => !!C };
}
