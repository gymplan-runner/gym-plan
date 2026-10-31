// Settings: name, start date, backup / spreadsheet export / restore, install help, delete everything.
import * as db from "./db.js";
import { getPlan, parseDate, isoDate } from "./plan.js";
import { esc, toast, fmt } from "./ui.js";

const BACKUP_EVERY_DAYS = 14;

// Share sheet on iPhone ("Save to Files"); falls back to a normal download elsewhere.
async function saveFiles(files) {
  if (navigator.canShare?.({ files })) {
    try { await navigator.share({ files }); return true; } catch (e) { if (e.name === "AbortError") return false; }
  }
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  return true;
}

const stamp = () => isoDate(new Date());

export async function backupNow() {
  const data = await db.exportAll();
  const file = new File([JSON.stringify(data, null, 1)], `gym-plan-backup-${stamp()}.json`, { type: "application/json" });
  if (await saveFiles([file])) {
    await db.setSetting("lastBackup", new Date().toISOString());
    toast("Backup saved");
    return true;
  }
  return false;
}

// ---- spreadsheet export
function csv(rows) {
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}

export async function exportCsv() {
  const ex = getPlan().exercises;
  const sessions = (await db.all("sessions")).sort((a, b) => (a.date < b.date ? -1 : 1));
  const sets = [["date", "performed_on", "week", "session", "exercise", "set", "kg", "reps", "seconds", "minutes", "status", "reps_left_in_tank", "quad_pain", "setting", "note"]];
  const summary = [["date", "performed_on", "week", "session", "status", "duration_min", "effort", "quad_pain_during", "quad_pain_next_morning", "note"]];
  for (const s of sessions) {
    summary.push([s.date, s.performedOn, s.week, s.title, s.status, s.durationMin, s.effort, s.painDuring, s.painNextMorning, s.note]);
    for (const it of s.items) {
      const name = ex[it.exercise]?.name ?? it.exercise;
      if (!it.sets.length) sets.push([s.date, s.performedOn, s.week, s.title, name, "", "", "", "", it.minutes, it.status, "", it.pain, it.setting, it.note]);
      it.sets.forEach((st, j) => sets.push([s.date, s.performedOn, s.week, s.title, name, j + 1, st.kg, st.reps, st.seconds, "",
        st.done ? it.status : "not done", it.rir, it.pain, it.setting, it.note]));
    }
  }
  const runs = [["date", "week", "where", "planned", "running_min", "longest_non_stop_min", "distance_km", "pace_min_per_km", "effort", "quad_pain_during", "quad_pain_next_morning", "strides", "note"]];
  for (const r of (await db.all("runs")).filter((x) => x.status === "finished").sort((a, b) => (a.date < b.date ? -1 : 1))) {
    const pace = r.distanceKm && r.totalRunMin ? (r.totalRunMin / r.distanceKm).toFixed(2) : "";
    runs.push([r.date, r.week, r.where, r.plannedText, r.totalRunMin, r.longestMin, r.distanceKm, pace, r.effort, r.painDuring, r.painNextMorning, r.strides?.done ?? "", r.note]);
  }
  const kicks = [["date", "week", "stage", "final_test", "what", "hardest_effort_pct", "quad_pain_during", "quad_pain_next_morning", "note"]];
  for (const k of (await db.all("kicks")).filter((x) => x.status === "finished").sort((a, b) => (a.date < b.date ? -1 : 1))) {
    kicks.push([k.date, k.week, k.stage, k.test ? "yes" : "", k.what, k.effortPct, k.painDuring, k.painNextMorning, k.note]);
  }
  const d = stamp();
  const files = [["gym-sets", sets], ["gym-sessions", summary], ["runs", runs], ["kicks", kicks]]
    .map(([n, rows]) => new File([`﻿${csv(rows)}`], `${n}-${d}.csv`, { type: "text/csv" }));
  if (await saveFiles(files)) toast("Spreadsheet files exported");
}

// ---- restore
export function readBackup(file) {
  return file.text().then((t) => {
    let data;
    try { data = JSON.parse(t); } catch { throw new Error("That file isn't a backup from this app."); }
    if (data?.app !== "gym-plan" || typeof data.kv !== "object") throw new Error("That file isn't a backup from this app.");
    for (const n of db.STORES.slice(1)) if (data[n] != null && !Array.isArray(data[n])) throw new Error("The backup file looks damaged.");
    return data;
  });
}

export async function needsBackupReminder(now = new Date()) {
  const last = await db.getSetting("lastBackup", null);
  const logged = (await db.all("sessions")).length + (await db.all("runs")).length + (await db.all("kicks")).length;
  if (!logged) return null;
  if (!last) return "You haven't backed up yet.";
  const days = Math.floor((now - new Date(last)) / 86400000);
  return days >= BACKUP_EVERY_DAYS ? `Last backup was ${days} days ago.` : null;
}

// ------------------------------------------------------------------ view
export function createSettingsView({ $screen, $tabs }) {
  let on = false, onDone, pending = null;

  async function start(done) {
    on = true;
    onDone = done;
    $tabs.hidden = true;
    render();
  }

  function stop(changed) {
    on = false;
    pending = null;
    $tabs.hidden = false;
    onDone(changed);
  }

  async function render() {
    const name = await db.getSetting("name", "");
    const start = await db.getSetting("startDate", getPlan().meta.start_date);
    const last = await db.getSetting("lastBackup", null);
    const counts = Object.fromEntries(await Promise.all(db.STORES.slice(1).map(async (n) => [n, (await db.all(n)).length])));
    const restorePreview = pending
      ? `<div class="notice"><b>Backup from ${fmt(new Date(pending.exported), { day: "numeric", month: "long", year: "numeric" })}</b><br>
          ${pending.sessions?.length ?? 0} gym sessions · ${pending.runs?.length ?? 0} runs · ${pending.kicks?.length ?? 0} kicking entries
          <p class="small">Restoring <b>replaces everything</b> on this phone (${counts.sessions} sessions, ${counts.runs} runs, ${counts.kicks} kicking entries) with this backup.</p>
          <div class="row2"><button type="button" class="btn ghost" data-sact="restore-cancel">Cancel</button>
          <button type="button" class="btn" data-sact="restore-confirm">Restore</button></div></div>` : "";
    $screen.innerHTML = `
      <div class="wk-top" style="background:var(--navy)"><button type="button" class="back" data-sact="exit">‹ Today</button><h1>Settings</h1></div>
      <div class="card"><h2 style="margin-top:0">Your data</h2>
        <p class="small muted">Everything you log stays on this phone. Back it up so a lost phone – or deleting the app icon – doesn't lose it.</p>
        <p><b>Last backup:</b> ${last ? fmt(new Date(last), { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "never"}</p>
        <button type="button" class="btn" data-sact="backup">Back up now</button>
        <p class="muted small" style="margin-top:6px">On iPhone choose <b>Save to Files</b> (iCloud Drive keeps a copy safe).</p>
        <button type="button" class="btn ghost" data-sact="csv">Export for spreadsheets (CSV)</button>
        <label class="btn ghost filebtn">Restore from a backup file<input type="file" accept="application/json,.json" data-sact="file" hidden></label>
        ${restorePreview}
      </div>
      <div class="card"><h2 style="margin-top:0">You</h2>
        <label class="mini">Name<input class="in wide" id="s-name" value="${esc(name)}" maxlength="30"></label>
        <label class="mini">Week 1 starts on (a Monday)<input class="in wide" type="date" id="s-start" value="${start}"></label>
        <button type="button" class="btn" data-sact="save">Save</button>
      </div>
      <div class="card"><h2 style="margin-top:0">Install on your iPhone</h2>
        <ol class="small"><li>Open the app's web address in <b>Safari</b>.</li><li>Tap the <b>Share</b> button (square with an arrow).</li>
        <li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li><li>Open it from the new icon – it works offline after the first time.</li></ol>
        <p class="small muted">This is a web app, not an App Store app. Deleting the icon also deletes its data, so back up first.</p>
      </div>
      <div class="card"><h2 style="margin-top:0">Not medical advice</h2>
        <p class="small">${esc(getPlan().meta.disclaimer)} Pain scores here are self-reported tracking, not a medical assessment.</p>
      </div>
      <button type="button" class="linkbtn" data-sact="wipe" style="display:block;margin:4px auto 40px;color:var(--red)">Delete all my data on this phone</button>`;
  }

  $screen.addEventListener("click", async (e) => {
    if (!on) return;
    const b = e.target.closest("[data-sact]");
    if (!b || b.tagName === "INPUT") return;
    switch (b.dataset.sact) {
      case "exit": return stop(false);
      case "backup": await backupNow(); break;
      case "csv": await exportCsv(); break;
      case "save": {
        const n = document.getElementById("s-name").value.trim();
        const s = document.getElementById("s-start").value;
        if (!s || parseDate(s).getDay() !== 1) { toast("Pick a Monday for the start date"); return; }
        await db.setSetting("name", n);
        await db.setSetting("startDate", s);
        toast("Saved");
        return stop(true);
      }
      case "restore-cancel": pending = null; break;
      case "restore-confirm":
        try {
          await db.importAll(pending);
          toast("Backup restored");
          return stop(true);
        } catch {
          toast("Restore failed – nothing was changed", "bad");
        }
        break;
      case "wipe":
        if (!confirm("Delete ALL your logs and settings on this phone?")) return;
        if (!confirm("Are you sure? Without a backup this can't be undone.")) return;
        await db.clearAll();
        location.reload();
        return;
      default: return;
    }
    render();
  });

  $screen.addEventListener("change", async (e) => {
    if (!on || e.target.dataset.sact !== "file" || !e.target.files[0]) return;
    try { pending = await readBackup(e.target.files[0]); } catch (err) { toast(err.message, "bad"); pending = null; }
    e.target.value = "";
    render();
  });

  return { start, active: () => on };
}
