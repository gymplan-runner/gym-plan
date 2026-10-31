// Return-to-kicking log and stage suggestions. The app only suggests; the user confirms any stage change.
import * as db from "./db.js";
import { getPlan, DAY_COLOURS } from "./plan.js";
import { esc, toast, celebrate } from "./ui.js";
import { lightOf, lightHtml } from "./symptoms.js";

export const kickId = (date) => `kick-${date}`;

export async function currentStage() {
  return (await db.getSetting("kickStage", null)) ?? 1;
}

// Suggestion from the latest logs at the current stage (green needs a next-morning score too).
export async function suggestion() {
  const stage = await currentStage();
  const logs = (await db.all("kicks")).filter((k) => k.status === "finished" && k.stage === stage && !k.test)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const last = logs[0];
  if (!last) return { stage, kind: "start", text: `Stage ${stage}: do it twice with green scores to move up.` };
  const l = lightOf(last.painDuring, last.painNextMorning);
  if (l === "r") return { stage, kind: "down", to: Math.max(1, stage - 1), text: "Last session was red – drop back a stage." };
  if (l === "a") return { stage, kind: "repeat", text: "Last session was amber – repeat this stage." };
  if (last.painNextMorning == null) return { stage, kind: "wait", text: "Add last session's next-morning score to get a suggestion." };
  const prev = logs[1];
  const twoGreen = prev && lightOf(prev.painDuring, prev.painNextMorning) === "g" && prev.painNextMorning != null;
  if (twoGreen && stage < 4) return { stage, kind: "up", to: stage + 1, text: `Two greens in a row – ready to try Stage ${stage + 1}.` };
  if (twoGreen) return { stage, kind: "top", text: "Two greens at Stage 4 – full strikes are going well." };
  return { stage, kind: "repeat", text: "One green so far – one more green session at this stage to move up." };
}

export function createKickView({ $screen, $tabs }) {
  let K, onDone;

  async function start(record, done) {
    K = record;
    onDone = done;
    $tabs.hidden = true;
    render();
  }

  function stop() {
    const rec = K;
    K = null;
    $tabs.hidden = false;
    return rec;
  }

  const save = async () => { try { await db.put("kicks", K); } catch { toast("Couldn't save – try again", "bad"); } };

  function chips(act, values, selected, f = (v) => v) {
    return `<div class="chips">${values.map((v) => `<button type="button" class="chip ${selected === v ? "on" : ""}" data-kact="${act}" data-v="${v}" aria-pressed="${selected === v}">${f(v)}</button>`).join("")}</div>`;
  }

  function render() {
    const st = getPlan().kicking.stages.find((s) => s.stage === K.stage);
    const editing = K.status === "finished";
    $screen.innerHTML = `<div class="wk-top" style="background:${DAY_COLOURS.sat}"><button type="button" class="back" data-kact="exit">‹ Today</button>
        <h1>${K.test ? "Final kick test" : `Kicking – Stage ${K.stage}`}</h1><p>${esc(st?.name ?? "")}</p></div>
      <div class="card">
        <p>${esc(st?.what ?? "")}</p>
        <p class="muted small">${esc(getPlan().kicking.rule)}</p>
        <p class="q">Stage you did</p>${chips("stage", [1, 2, 3, 4], K.stage)}
        <label class="mini">What you did (optional)<input class="in wide" data-kfield="what" value="${esc(K.what)}" placeholder="e.g. 30 side-foot passes"></label>
        <p class="q">Hardest kick effort</p>${chips("effortPct", [30, 50, 70, 80, 90, 100], K.effortPct, (v) => `${v}%`)}
        <p class="q">Quad pain during (0–10)</p>${chips("pain", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], K.painDuring)}
        ${lightHtml(K.painDuring, K.painNextMorning)}
        ${editing ? `<p class="q">Quad pain next morning (0–10)</p>${chips("morning", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], K.painNextMorning)}` : ""}
        <label class="mini">Notes<textarea class="in wide" rows="2" data-kfield="note">${esc(K.note)}</textarea></label>
        <button type="button" class="btn" data-kact="save">${editing ? "Save changes" : "Save kicking session"}</button>
        ${editing ? `<button type="button" class="linkbtn" data-kact="delete" style="display:block;margin:8px auto">Delete this entry</button>` : ""}
      </div>`;
  }

  $screen.addEventListener("click", async (e) => {
    if (!K) return;
    const b = e.target.closest("[data-kact]");
    if (!b) return;
    const act = b.dataset.kact, v = Number(b.dataset.v);
    switch (act) {
      case "exit": return onDone(stop(), { left: true });
      case "stage": K.stage = v; break;
      case "effortPct": K.effortPct = K.effortPct === v ? null : v; break;
      case "pain": K.painDuring = K.painDuring === v ? null : v; break;
      case "morning": K.painNextMorning = K.painNextMorning === v ? null : v; break;
      case "save": {
        if (K.painDuring == null) { toast("Add your pain score (0–10) first"); return; }
        const first = K.status !== "finished";
        K.status = "finished";
        await save();
        if (first) celebrate("Kicking logged", "Steady steps back to football.");
        else toast("Changes saved");
        return onDone(stop());
      }
      case "delete":
        if (!confirm("Delete this kicking entry? This can't be undone.")) return;
        await db.remove("kicks", K.id);
        toast("Entry deleted");
        return onDone(stop(), { deleted: true });
      default: return;
    }
    render();
  });

  $screen.addEventListener("input", (e) => {
    if (!K) return;
    const el = e.target.closest("[data-kfield]");
    if (el) K[el.dataset.kfield] = el.value;
  });

  return { start, active: () => !!K };
}

export async function newKick(date, week, test = false) {
  return { id: kickId(date), kind: "kick", date, week, test, stage: test ? 4 : await currentStage(), what: "",
    effortPct: null, painDuring: null, painNextMorning: null, note: "", status: "draft" };
}
