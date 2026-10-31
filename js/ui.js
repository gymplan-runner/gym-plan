// Small shared helpers for rendering.
import { parseDate } from "./plan.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const fmt = (d, opts) => d.toLocaleDateString("en-GB", opts);

// "?today=YYYY-MM-DD" lets testing preview any day of the plan.
export function today() {
  const q = new URLSearchParams(location.search).get("today");
  return q ? parseDate(q) : new Date();
}

export function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", "status");
  el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 3200);
}

// Warm and subtle: a tick and a short message.
export function celebrate(title, message) {
  const el = document.createElement("div");
  el.className = "celebrate";
  el.setAttribute("role", "status");
  el.innerHTML = `<div class="tick">✓</div><b>${esc(title)}</b><p>${esc(message)}</p>`;
  document.body.append(el);
  el.addEventListener("click", () => el.remove());
  setTimeout(() => el.remove(), 3500);
}

export const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

export const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
