// Point this at your deployed Worker URL once you've run `wrangler deploy`.
// For local dev with `wrangler dev`, this defaults to the standard local port.
const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://127.0.0.1:8787"
  : "https://flightwatch-worker.juanfe02agu.workers.dev";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}

// AeroDataBox gives times like "2026-07-23 20:30-04:00" — already local to that
// specific airport, so we only reformat for readability, never convert timezone.
function formatFlightTime(raw) {
  if (!raw) return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  if (!match) return raw;
  const [, y, mo, d, h, mi] = match;
  const wall = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  const weekday = wall.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  const day = wall.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const time = wall.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC" });
  return `${weekday} ${day} · ${time}`;
}

function formatDateOnly(isoDate) {
  const [y, mo, d] = isoDate.split("-").map(Number);
  const wall = new Date(Date.UTC(y, mo - 1, d));
  return wall.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

function renderLegTime(leg) {
  const scheduled = formatFlightTime(leg.scheduledTime);
  const estimated = formatFlightTime(leg.estimatedTime);
  const changed = estimated && estimated !== scheduled;
  const primary = estimated ?? scheduled ?? "—";
  const gate = leg.gate ? ` · Gate ${leg.gate}` : "";
  return changed
    ? `<span class="leg-time revised">${primary}</span><span class="leg-was">was ${scheduled}</span>${gate}`
    : `<span class="leg-time">${primary}</span>${gate}`;
}

const form = document.getElementById("add-form");
const numberInput = document.getElementById("flight-number");
const dateInput = document.getElementById("flight-date");
const list = document.getElementById("flight-list");

async function loadFlights() {
  list.innerHTML = `<p class="empty">Loading…</p>`;
  try {
    const res = await fetch(`${API_BASE}/api/flights`);
    const data = await res.json();
    renderFlights(data);
  } catch (err) {
    list.innerHTML = `<p class="empty">Couldn't reach the server. Is the Worker running?</p>`;
    console.error(err);
  }
}

function renderFlights(entries) {
  if (!entries.length) {
    list.innerHTML = `<p class="empty">NO FLIGHTS TRACKED — ADD ONE ABOVE<span class="cursor"></span></p>`;
    return;
  }

  list.innerHTML = "";
  entries.forEach(({ flight, status }, i) => {
    const statusSlug = (status?.status ?? "unknown").toLowerCase();
    const row = document.createElement("div");
    row.className = `board-row status-${statusSlug}`;
    row.style.animationDelay = `${i * 90}ms`;
    row.innerHTML = `
      <div class="row-top">
        <span class="flight-number">${flight.flightNumber} <span class="flight-date">· ${formatDateOnly(flight.date)}</span></span>
        <span class="status-badge">${status ? status.status : "Unknown"}</span>
      </div>
      ${status ? `
        <div class="leg">
          <span class="leg-label">Dep — ${status.departure.airport}</span>
          <span class="leg-value">${renderLegTime(status.departure)}</span>
        </div>
        <div class="leg">
          <span class="leg-label">Arr — ${status.arrival.airport}</span>
          <span class="leg-value">${renderLegTime(status.arrival)}</span>
        </div>
      ` : `<p class="hint" style="margin:8px 0 0;">No status yet — check back in a few minutes.</p>`}
      <div class="row-footer">
        <button class="remove-btn" data-number="${flight.flightNumber}" data-date="${flight.date}">Remove</button>
      </div>
    `;
    list.appendChild(row);
  });

  list.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await fetch(`${API_BASE}/api/flights`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flightNumber: btn.dataset.number, date: btn.dataset.date }),
      });
      loadFlights();
    });
  });
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const flightNumber = numberInput.value.trim().toUpperCase();
  const date = dateInput.value;
  if (!flightNumber || !date) return;

  const submitBtn = form.querySelector("button");
  submitBtn.disabled = true;
  try {
    await fetch(`${API_BASE}/api/flights`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flightNumber, date }),
    });
    numberInput.value = "";
    await loadFlights();
  } finally {
    submitBtn.disabled = false;
  }
});

loadFlights();
