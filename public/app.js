// Point this at your deployed Worker URL once you've run `wrangler deploy`.
// For local dev with `wrangler dev`, this defaults to the standard local port.
const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://127.0.0.1:8787"
  : "https://flightwatch-worker.juanfe02agu.workers.dev";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
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
    list.innerHTML = `<p class="empty">No flights tracked yet.</p>`;
    return;
  }

  list.innerHTML = "";
  for (const { flight, status } of entries) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-header">
        <span class="flight-number">${flight.flightNumber} · ${flight.date}</span>
        <span class="status-badge">${status ? status.status : "Unknown"}</span>
      </div>
      ${status ? `
        <div class="leg">
          <span class="leg-label">Departure — ${status.departure.airport}</span>
          <span>${status.departure.estimatedTime ?? status.departure.scheduledTime ?? "—"} ${status.departure.gate ? `· Gate ${status.departure.gate}` : ""}</span>
        </div>
        <div class="leg">
          <span class="leg-label">Arrival — ${status.arrival.airport}</span>
          <span>${status.arrival.estimatedTime ?? status.arrival.scheduledTime ?? "—"} ${status.arrival.gate ? `· Gate ${status.arrival.gate}` : ""}</span>
        </div>
      ` : `<p class="hint">No status yet — check back in a few minutes.</p>`}
      <div style="margin-top:10px; text-align:right;">
        <button class="remove-btn" data-number="${flight.flightNumber}" data-date="${flight.date}">Remove</button>
      </div>
    `;
    list.appendChild(card);
  }

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
