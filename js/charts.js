// Small inline-SVG charts. One y-axis, thin marks, recessive grid; every chart has a table view.
import { esc } from "./ui.js";

// series: [{ name, points: [{ x, y }], dashed?, muted? }] — x is a week number (1–12).
export function lineChart({ title, unit, series, yMin = 0, yMax, goal, goalLabel }) {
  const all = series.flatMap((s) => s.points.map((p) => p.y)).concat(goal ?? []);
  const top = yMax ?? Math.max(1, ...all) * 1.12;
  const W = 340, H = 170, L = 34, R = 10, T = 12, B = 26;
  const x = (wk) => L + ((wk - 1) / 11) * (W - L - R);
  const y = (v) => T + (1 - (v - yMin) / (top - yMin)) * (H - T - B);
  const ticks = [0, 0.5, 1].map((f) => yMin + f * (top - yMin));
  const grid = ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/>
    <text x="${L - 6}" y="${y(t) + 4}" class="axis" text-anchor="end">${Math.round(t)}</text>`).join("");
  const xt = [1, 4, 8, 12].map((w) => `<text x="${x(w)}" y="${H - 6}" class="axis" text-anchor="${w === 12 ? "end" : w === 1 ? "start" : "middle"}">Wk ${w}</text>`).join("");
  const goalLine = goal != null ? `<line x1="${L}" x2="${W - R}" y1="${y(goal)}" y2="${y(goal)}" class="goalline"/>
    <text x="${W - R}" y="${y(goal) - 5}" class="axis" text-anchor="end">${esc(goalLabel ?? `Goal ${goal}${unit}`)}</text>` : "";
  const lines = series.map((s) => {
    const pts = s.points.filter((p) => p.y != null);
    if (!pts.length) return "";
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
    const dots = s.dashed ? "" : pts.map((p) => `<circle cx="${x(p.x)}" cy="${y(p.y)}" r="4.5" class="dot"><title>Week ${p.x}: ${p.y}${unit}</title></circle>`).join("");
    const lastP = pts[pts.length - 1];
    const label = s.dashed ? "" : `<text x="${Math.min(x(lastP.x) + 7, W - R - 2)}" y="${y(lastP.y) - 8}" class="val" text-anchor="${x(lastP.x) > W - 60 ? "end" : "start"}">${lastP.y}${unit}</text>`;
    return `<path d="${d}" class="${s.dashed ? "plan" : "line"}"/>${dots}${label}`;
  }).join("");
  const legend = series.length > 1 ? `<div class="legend">${series.map((s) =>
    `<span><i class="${s.dashed ? "k-plan" : "k-line"}"></i>${esc(s.name)}</span>`).join("")}</div>` : "";
  const weeks = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  const table = `<details class="tbl"><summary>Show as table</summary><table><tr><th>Week</th>${series.map((s) => `<th>${esc(s.name)}</th>`).join("")}</tr>
    ${weeks.map((w) => `<tr><td>${w}</td>${series.map((s) => `<td>${s.points.find((p) => p.x === w)?.y ?? "–"}</td>`).join("")}</tr>`).join("")}</table></details>`;
  return `<figure class="chart"><figcaption>${esc(title)}</figcaption>${legend}
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${grid}${xt}${goalLine}${lines}</svg>${table}</figure>`;
}
