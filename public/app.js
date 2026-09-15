// FlightWatch — "Runway Concierge" home screen.
// Static PWA, no build step: plain DOM against the Worker API.

const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://127.0.0.1:8787"
  : "https://flightwatch-worker.juanfe02agu.workers.dev";

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}

/* ================= STATE ================= */

// Per-list, from the server.
const LS_LIST_CODE = "fw_list_code";
const LS_NTFY_TOPIC = "fw_ntfy_topic";
// Per-device. Density and theme deliberately never round-trip to KV: a dispatcher's
// tablet and a driver's phone can share one list code and want different views.
const LS_DENSITY = "fw_density";
const LS_THEME = "fw_theme";
const LS_LAST_GOOD = "fw_last_good";

let listCode = localStorage.getItem(LS_LIST_CODE);
let ntfyTopic = localStorage.getItem(LS_NTFY_TOPIC);
let density = localStorage.getItem(LS_DENSITY) === "card" ? "card" : "board";
let themeMode = localStorage.getItem(LS_THEME) || "auto"; // auto | night | day

let settings = { driveMinutes: {}, bufferMinutes: 10, showPassengerNames: true };
let entries = [];
let offline = false;
// Last rendered values per flight, so a flip animation only plays on what changed.
const prevValues = new Map();

const app = document.getElementById("app");
const main = document.getElementById("main");

/* ================= UTIL ================= */

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function icon(name, cls) {
  return `<svg class="ico ${cls || ""}" aria-hidden="true"><use href="#i-${name}" /></svg>`;
}

function flightId(flight) {
  return `${flight.flightNumber}:${flight.date}`;
}

/* ================= TIME =================
   AeroDataBox local times are already wall-clock at their own airport, so they are
   parsed into a UTC Date purely as a carrier and never timezone-converted. */

function parseWall(raw) {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
}

function timeParts(raw) {
  const wall = parseWall(raw);
  if (!wall) return null;
  const s = wall.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC",
  });
  const [time, meridiem] = s.split(" ");
  return { time, meridiem };
}

function shortTime(raw) {
  const p = timeParts(raw);
  return p ? p.time : null;
}

function shortDate(isoDate) {
  const [y, mo, d] = String(isoDate).split("-").map(Number);
  if (!y) return "";
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  });
}

function tzAbbreviation(rawLocalTime, ianaZone) {
  const wall = parseWall(rawLocalTime);
  if (!wall || !ianaZone) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaZone, timeZoneName: "short", hour: "numeric",
  }).formatToParts(wall);
  const found = parts.find((p) => p.type === "timeZoneName");
  return found ? found.value : "";
}

function formatDuration(ms) {
  const total = Math.round(Math.abs(ms) / 60000);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days > 0) return `${days}D ${hours}H`;
  if (hours > 0) return `${hours}H ${String(minutes).padStart(2, "0")}M`;
  return `${minutes}M`;
}

/* ================= DERIVED ================= */

function arrivalUtc(status) {
  if (!status) return null;
  return status.arrival.estimatedTimeUtc || status.arrival.scheduledTimeUtc || null;
}

function arrivalLocal(status) {
  if (!status) return null;
  return status.arrival.estimatedTime || status.arrival.scheduledTime || null;
}

// Minutes a leg has slipped versus its schedule, or null when there's no revision.
function delayMinutes(leg) {
  if (!leg || !leg.estimatedTimeUtc || !leg.scheduledTimeUtc) return null;
  const diff = new Date(leg.estimatedTimeUtc) - new Date(leg.scheduledTimeUtc);
  const mins = Math.round(diff / 60000);
  return mins === 0 ? null : mins;
}

function isLanded(status) {
  return !!status && /landed|arrived/i.test(status.status);
}

function isCancelled(status) {
  return !!status && /cancel/i.test(status.status);
}

function severity(status) {
  if (!status) return "unknown";
  if (isCancelled(status)) return "alert";
  if (isLanded(status)) return "landed";
  const d = delayMinutes(status.arrival) || delayMinutes(status.departure);
  if (/delay/i.test(status.status) || (d !== null && d > 0)) return "alert";
  return "ok";
}

function statusLabel(status) {
  if (!status) return "UNKNOWN";
  if (isCancelled(status)) return "CANCELLED";
  if (isLanded(status)) return "LANDED";
  const d = delayMinutes(status.arrival);
  if (d !== null && d > 0) return `DELAYED ${d}M`;
  if (/delay/i.test(status.status)) return "DELAYED";
  return "ON TIME";
}

// leaveBy = arrival − drive − buffer, computed in the arrival airport's own wall-clock
// so it never crosses a timezone. Returns null when the drive time isn't set yet —
// a guessed number here would put someone at the curb at the wrong time.
function leaveByFor(status) {
  const local = arrivalLocal(status);
  const iata = status && status.arrival.airportCode;
  if (!local || !iata) return null;
  const drive = settings.driveMinutes[iata];
  if (typeof drive !== "number") return { unset: true, iata };
  const wall = parseWall(local);
  if (!wall) return null;
  const at = new Date(wall.getTime() - (drive + settings.bufferMinutes) * 60000);
  const s = at.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC",
  });
  return { time: s, drive, buffer: settings.bufferMinutes, iata };
}

function sortEntries(list) {
  const withKey = list.map((e) => ({
    entry: e,
    landed: isLanded(e.status),
    at: arrivalUtc(e.status) ? new Date(arrivalUtc(e.status)).getTime() : Infinity,
  }));
  withKey.sort((a, b) => {
    if (a.landed !== b.landed) return a.landed ? 1 : -1; // landed sinks
    return a.at - b.at;
  });
  return withKey.map((x) => x.entry);
}

/* ================= RENDER ================= */

function chipFor(status) {
  const sev = severity(status);
  const label = statusLabel(status);
  if (sev === "ok") return `<span class="chip"><span class="dot"></span>${label}</span>`;
  if (sev === "alert") return `<span class="chip is-alert">${label}</span>`;
  if (sev === "landed") return `<span class="chip is-landed">${label}</span>`;
  return `<span class="chip is-unknown">${label}</span>`;
}

function heroSubject(flight) {
  const showNames = settings.showPassengerNames;
  if (flight.passenger && showNames) {
    const bits = [];
    if (flight.pax) bits.push(`${flight.pax} pax`);
    if (flight.dropOff) bits.push(flight.dropOff);
    return {
      primary: esc(flight.passenger),
      meta: bits.length ? esc(bits.join(" · ")) : "",
    };
  }
  // No pickup details (or names hidden): the flight itself carries the hero.
  return { primary: esc(flight.flightNumber), meta: esc(shortDate(flight.date)) };
}

function renderHero(entry) {
  const { flight, status } = entry;
  const id = flightId(flight);
  const prev = prevValues.get(id) || {};
  const subject = heroSubject(flight);
  const sev = severity(status);

  if (!status) {
    return `
      <section class="hero">
        <div class="hero-top">
          <span class="eyebrow">NEXT PICKUP</span>
          ${chipFor(null)}
        </div>
        <div class="pax-block">
          <span class="pax-name">${subject.primary}</span>
          <span class="pax-meta">${subject.meta}</span>
        </div>
        <p class="route" style="margin:0">No status yet &mdash; checking every 20 minutes.</p>
      </section>`;
  }

  const arr = arrivalLocal(status);
  const parts = timeParts(arr) || { time: "&mdash;", meridiem: "" };
  const dep = status.departure;
  const arrLeg = status.arrival;
  const delay = delayMinutes(arrLeg);
  const timeChanged = prev.arrTime && prev.arrTime !== arr;
  const gateChanged = prev.gate && prev.gate !== arrLeg.gate;

  const wasLine = delay !== null && delay > 0 && arrLeg.scheduledTime
    ? `<div class="hero-was">was <s>${esc(shortTime(arrLeg.scheduledTime))}</s> &middot; +${delay}m</div>`
    : "";

  const utc = arrivalUtc(status);
  let countdown = "";
  if (offline) {
    countdown = `<div class="countdown">
        <span class="eyebrow">AS OF</span>
        <span class="cd-value is-stale">${esc(shortTime(status.fetchedAt) || "&mdash;")}</span>
      </div>`;
  } else if (utc) {
    const diff = new Date(utc).getTime() - Date.now();
    countdown = `<div class="countdown">
        <span class="eyebrow">${diff > 0 ? "LANDS IN" : "LANDED"}</span>
        <span class="cd-value" data-countdown="${esc(utc)}">${formatDuration(diff)}</span>
      </div>`;
  }

  const routePair = `${esc(dep.airportCode || dep.airport)} &rarr; ${esc(arrLeg.airportCode || arrLeg.airport)}`;
  const route = [status.airline ? esc(status.airline) : "", routePair].filter(Boolean).join(" &middot; ");

  const claim = "&mdash;"; // no claim source yet; an em-dash beats a guess

  const lb = leaveByFor(status);
  let leaveby = "";
  if (lb && lb.unset) {
    leaveby = `<div class="leaveby">
        ${icon("car", "ico-lg")}
        <div class="lb-stack"><span class="lb-label">LEAVE BY</span></div>
        <span class="spacer"></span>
        <button class="lb-deriv" type="button" data-set-drive="${esc(lb.iata)}">
          Set drive time<br>for ${esc(lb.iata)}
        </button>
      </div>`;
  } else if (lb) {
    leaveby = `<div class="leaveby">
        ${icon("car", "ico-lg")}
        <div class="lb-stack">
          <span class="lb-label">LEAVE BY</span>
          <span class="lb-time">${esc(lb.time)}</span>
        </div>
        <span class="spacer"></span>
        <button class="lb-deriv" type="button" data-set-drive="${esc(lb.iata)}">
          ${lb.drive}m drive<br>+${lb.buffer}m buffer
        </button>
      </div>`;
  }

  prevValues.set(id, { arrTime: arr, gate: arrLeg.gate });

  const instruments = `
    <div class="instruments">
      <div class="cell">
        <div class="cell-label">${icon("map-pin", "ico-sm")}TERMINAL</div>
        <div class="cell-value">${esc(arrLeg.terminal) || "&mdash;"}</div>
      </div>
      <div class="cell${gateChanged ? " is-alert" : ""}">
        <div class="cell-label">${icon("door-open", "ico-sm")}GATE</div>
        <div class="cell-value${gateChanged ? " flip flip-delayed" : ""}">
          ${esc(arrLeg.gate) || "&mdash;"}
          ${gateChanged ? `<span class="cell-was">${esc(prev.gate)}</span>` : ""}
        </div>
      </div>
      <div class="cell wide">
        <div class="cell-label">${icon("luggage", "ico-sm")}CLAIM</div>
        <div class="cell-value">${claim}</div>
      </div>
    </div>`;

  const heroInner = `
      <div class="hero-top">
        <span class="eyebrow">NEXT PICKUP</span>
        ${chipFor(status)}
      </div>
      <div class="pax-block">
        <span class="pax-name">${subject.primary}</span>
        <span class="pax-meta">${subject.meta}</span>
      </div>
      <div class="flight-line">
        <span class="flight-code">${esc(flight.flightNumber)}</span>
        <span class="route">${route}</span>
      </div>
      <div class="hero-bottom">
        <div>
          <div class="hero-time${timeChanged ? " flip" : ""}">${parts.time}<span class="meridiem">${parts.meridiem}</span></div>
          ${wasLine}
        </div>
        ${countdown}
      </div>`;

  const openTag = `<section class="hero${sev === "alert" ? " is-alert" : ""}">`;
  // Board keeps the instrument strip full-bleed below the panel; card insets it
  // into the hero card itself.
  return density === "card"
    ? `${openTag}${heroInner}${instruments}</section>${leaveby}`
    : `${openTag}${heroInner}</section>${instruments}${leaveby}`;
}

function rowMeta(entry) {
  const { flight, status } = entry;
  const bits = [];
  if (status) {
    bits.push(`${esc(status.departure.airportCode || status.departure.airport)} &rarr; ${esc(status.arrival.airportCode || status.arrival.airport)}`);
  } else {
    bits.push(esc(shortDate(flight.date)));
  }
  if (flight.passenger && settings.showPassengerNames) bits.push(esc(flight.passenger));
  return bits.join(" &middot; ");
}

function renderBoardRow(entry) {
  const { flight, status } = entry;
  const sev = severity(status);
  const cls = sev === "alert" ? " is-delayed" : sev === "landed" ? " is-landed" : "";
  const t = shortTime(arrivalLocal(status));
  const delay = status ? delayMinutes(status.arrival) : null;
  const utc = arrivalUtc(status);

  let delta = "";
  if (sev === "landed") delta = "LANDED";
  else if (delay !== null && delay > 0) delta = `+${delay}M`;
  else if (utc) delta = formatDuration(new Date(utc).getTime() - Date.now());

  return `
    <button class="row${cls}" type="button" data-flight="${esc(flight.flightNumber)}" data-date="${esc(flight.date)}">
      <span class="dot"></span>
      <span class="code">${esc(flight.flightNumber)}</span>
      <span class="meta">${rowMeta(entry)}</span>
      <span class="time">${esc(t) || "&mdash;"}</span>
      <span class="delta"${utc && sev !== "landed" && !(delay > 0) ? ` data-countdown="${esc(utc)}"` : ""}>${delta}</span>
    </button>`;
}

function renderFlightCard(entry) {
  const { flight, status } = entry;
  const sev = severity(status);
  const cls = sev === "alert" ? " is-delayed" : sev === "landed" ? " is-landed" : "";
  const t = shortTime(arrivalLocal(status));
  const who = flight.passenger && settings.showPassengerNames ? esc(flight.passenger) : "";
  const sub = status
    ? `${esc(status.departure.airportCode || status.departure.airport)} &rarr; ${esc(status.arrival.airportCode || status.arrival.airport)}${status.arrival.terminal ? ` &middot; Terminal ${esc(status.arrival.terminal)}` : ""}`
    : esc(shortDate(flight.date));

  return `
    <button class="fcard${cls}" type="button" data-flight="${esc(flight.flightNumber)}" data-date="${esc(flight.date)}">
      <span class="fcard-line">
        <span class="code">${esc(flight.flightNumber)}</span>
        ${who ? `<span class="who">${who}</span>` : ""}
        <span class="spacer"></span>
        <span class="state">${statusLabel(status)}</span>
      </span>
      <span class="fcard-line">
        <span class="sub">${sub}</span>
        <span class="spacer"></span>
        <span class="time">${esc(t) || "&mdash;"}</span>
      </span>
    </button>`;
}

function renderEmpty() {
  return `
    <div class="empty-state">
      ${icon("plane-landing")}
      <h2>Nothing to watch yet</h2>
      <p>Add a flight number and the departure date. FlightWatch checks it every twenty
      minutes and pushes you the changes.</p>
    </div>`;
}

function renderHome() {
  if (!entries.length) {
    main.innerHTML = renderEmpty();
    document.getElementById("add-btn").classList.add("filled");
    return;
  }
  document.getElementById("add-btn").classList.remove("filled");

  const sorted = sortEntries(entries);
  const hero = sorted[0];
  const rest = sorted.slice(1);

  const staleStrip = offline
    ? `<div class="warn-strip">
         ${icon("triangle-alert")}
         <span>No connection. Showing the last known data &mdash; times may have moved.</span>
       </div>`
    : "";

  let list = "";
  if (rest.length) {
    const header = `
      <div class="list-header">
        <span class="eyebrow">ALSO TRACKING</span>
        <span class="rule"></span>
        <span class="count">${rest.length}</span>
      </div>`;
    list = density === "card"
      ? header + `<div class="cards">${rest.map(renderFlightCard).join("")}</div>`
      : header + rest.map(renderBoardRow).join("");
  }

  const body = renderHero(hero) + list;
  main.innerHTML = staleStrip + (density === "card"
    ? `<div style="padding:14px var(--gutter) 0;display:flex;flex-direction:column;gap:14px">${body}</div>`
    : body);
}

/* ================= COUNTDOWN ================= */

function tickCountdowns() {
  const now = Date.now();
  let crossed = false;
  document.querySelectorAll("[data-countdown]").forEach((el) => {
    const target = new Date(el.dataset.countdown).getTime();
    const diff = target - now;
    if (diff <= 0 && el.classList.contains("cd-value")) { crossed = true; return; }
    el.textContent = formatDuration(diff);
  });
  if (crossed) loadFlights();
}

/* ================= API ================= */

async function ensureList() {
  if (listCode) return true;
  try {
    const res = await fetch(`${API_BASE}/api/register`, { method: "POST" });
    if (!res.ok) throw new Error(`register failed: ${res.status}`);
    const data = await res.json();
    if (!data.listCode) throw new Error("register response missing listCode");
    listCode = data.listCode;
    ntfyTopic = data.ntfyTopic;
    localStorage.setItem(LS_LIST_CODE, listCode);
    localStorage.setItem(LS_NTFY_TOPIC, ntfyTopic);
    return true;
  } catch (err) {
    console.error("Failed to register a list:", err);
    return false;
  }
}

function applyPayload(data) {
  ntfyTopic = data.ntfyTopic;
  settings = Object.assign({ driveMinutes: {}, bufferMinutes: 10, showPassengerNames: true }, data.settings || {});
  entries = data.entries || [];
  localStorage.setItem(LS_NTFY_TOPIC, ntfyTopic);
  localStorage.setItem(LS_LAST_GOOD, JSON.stringify(data));
}

async function loadFlights() {
  try {
    const res = await fetch(`${API_BASE}/api/flights?listCode=${encodeURIComponent(listCode)}`);
    if (!res.ok) {
      main.innerHTML = `<div class="warn-strip">${icon("triangle-alert")}
        <span>That list code isn't recognised. Open Settings to switch to a different one.</span></div>`;
      return;
    }
    offline = false;
    applyPayload(await res.json());
    renderHome();
    syncSettingsSheet();
  } catch (err) {
    console.error(err);
    const cached = localStorage.getItem(LS_LAST_GOOD);
    if (cached) {
      offline = true;
      try { applyPayload(JSON.parse(cached)); } catch (_) { /* fall through */ }
      renderHome();
    } else {
      main.innerHTML = `<div class="warn-strip">${icon("triangle-alert")}
        <span>Couldn't reach the server, and there's nothing saved to show yet.</span></div>`;
    }
  }
}

async function saveSettings(patch) {
  settings = Object.assign({}, settings, patch);
  renderHome();
  try {
    await fetch(`${API_BASE}/api/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ listCode }, patch)),
    });
  } catch (err) {
    console.error("Couldn't save settings:", err);
  }
}

/* ================= PREFERENCES (per device) ================= */

function applyDensity(next) {
  density = next;
  localStorage.setItem(LS_DENSITY, next);
  app.dataset.density = next;
  document.getElementById("den-board").setAttribute("aria-pressed", String(next === "board"));
  document.getElementById("den-card").setAttribute("aria-pressed", String(next === "card"));
  renderHome();
}

function resolveTheme() {
  if (themeMode === "day") return "day";
  if (themeMode === "night") return "night";
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  return h >= 6.5 && h < 19.5 ? "day" : "night"; // device-clock fallback
}

function applyTheme(mode) {
  themeMode = mode;
  localStorage.setItem(LS_THEME, mode);
  const resolved = resolveTheme();
  if (resolved === "day") document.documentElement.setAttribute("data-theme", "day");
  else document.documentElement.removeAttribute("data-theme");
  document.querySelector('meta[name="theme-color"]')
    .setAttribute("content", resolved === "day" ? "#EFECE4" : "#0E1B30");
  ["auto", "night", "day"].forEach((m) => {
    document.getElementById(`theme-${m}`).setAttribute("aria-pressed", String(m === mode));
  });
}

/* ================= SHEETS ================= */

function openSheet(id) { document.getElementById(id).hidden = false; }
function closeSheet(id) { document.getElementById(id).hidden = true; }

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.innerHTML;
    btn.textContent = "COPIED";
    setTimeout(() => { btn.innerHTML = original; }, 1200);
  } catch (err) {
    console.error("Clipboard write failed:", err);
  }
}

// One drive-time row per arrival airport actually being tracked.
function syncSettingsSheet() {
  document.getElementById("set-code").textContent = listCode || "—";
  document.getElementById("set-topic").textContent = ntfyTopic || "—";
  document.getElementById("buffer-input").value = settings.bufferMinutes;

  const airports = new Map();
  entries.forEach(({ status }) => {
    if (status && status.arrival.airportCode) {
      airports.set(status.arrival.airportCode, status.arrival.airport);
    }
  });

  const host = document.getElementById("drive-rows");
  document.getElementById("drive-empty").hidden = airports.size > 0;
  host.innerHTML = Array.from(airports.entries()).map(([iata, name]) => `
    <div class="set-row">
      <span class="set-value" style="width:46px">${esc(iata)}</span>
      <span class="lbl" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
      <input class="num-input" type="number" min="0" max="300" step="5"
             data-drive="${esc(iata)}" value="${Number(settings.driveMinutes[iata]) || ""}"
             placeholder="--" aria-label="Drive time to ${esc(iata)} in minutes" />
      <span class="lbl">min</span>
    </div>`).join("");

  host.querySelectorAll("[data-drive]").forEach((input) => {
    input.addEventListener("change", () => {
      const iata = input.dataset.drive;
      const value = input.value === "" ? null : Number(input.value);
      const next = Object.assign({}, settings.driveMinutes);
      if (value === null || Number.isNaN(value)) delete next[iata];
      else next[iata] = value;
      saveSettings({ driveMinutes: next });
    });
  });
}

/* ================= WIRING ================= */

document.getElementById("settings-btn").addEventListener("click", () => {
  syncSettingsSheet();
  openSheet("settings-sheet");
});
document.getElementById("settings-close").addEventListener("click", () => closeSheet("settings-sheet"));

document.getElementById("den-board").addEventListener("click", () => applyDensity("board"));
document.getElementById("den-card").addEventListener("click", () => applyDensity("card"));
["auto", "night", "day"].forEach((m) => {
  document.getElementById(`theme-${m}`).addEventListener("click", () => applyTheme(m));
});

document.getElementById("buffer-input").addEventListener("change", (e) => {
  const value = Number(e.target.value);
  if (!Number.isNaN(value)) saveSettings({ bufferMinutes: value });
});

document.getElementById("copy-code").addEventListener("click", (e) => copyText(listCode, e.currentTarget));
document.getElementById("copy-topic").addEventListener("click", (e) => copyText(ntfyTopic, e.currentTarget));

document.getElementById("switch-code").addEventListener("click", async () => {
  const code = window.prompt("Enter the list code to switch to:");
  if (!code) return;
  const trimmed = code.trim();
  try {
    const res = await fetch(`${API_BASE}/api/flights?listCode=${encodeURIComponent(trimmed)}`);
    if (!res.ok) { window.alert("That code isn't recognised — check it and try again."); return; }
    listCode = trimmed;
    localStorage.setItem(LS_LIST_CODE, listCode);
    applyPayload(await res.json());
    prevValues.clear();
    renderHome();
    syncSettingsSheet();
  } catch (err) {
    console.error(err);
    window.alert("Couldn't reach the server. Try again.");
  }
});

// Tapping the leave-by derivation jumps to that airport's drive-time field.
main.addEventListener("click", (e) => {
  const setDrive = e.target.closest("[data-set-drive]");
  if (setDrive) {
    syncSettingsSheet();
    openSheet("settings-sheet");
    const field = document.querySelector(`[data-drive="${setDrive.dataset.setDrive}"]`);
    if (field) { field.focus(); field.select(); }
  }
});

document.getElementById("add-btn").addEventListener("click", () => {
  document.getElementById("f-error").textContent = "";
  openSheet("add-sheet");
  document.getElementById("f-number").focus();
});
document.getElementById("add-cancel").addEventListener("click", () => closeSheet("add-sheet"));

document.getElementById("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const submit = document.getElementById("add-submit");
  const errorEl = document.getElementById("f-error");
  const payload = {
    listCode,
    flightNumber: form.flightNumber.value.trim().toUpperCase(),
    date: form.date.value,
    passenger: form.passenger.value.trim() || null,
    dropOff: form.dropOff.value.trim() || null,
    pax: form.pax.value ? Number(form.pax.value) : null,
    note: form.note.value.trim() || null,
  };
  if (!payload.flightNumber || !payload.date) return;

  submit.disabled = true;
  errorEl.textContent = "";
  try {
    const res = await fetch(`${API_BASE}/api/flights`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      errorEl.textContent = body.error || "Couldn't add that flight.";
      return;
    }
    form.reset();
    closeSheet("add-sheet");
    await loadFlights();
  } catch (err) {
    console.error(err);
    errorEl.textContent = "Couldn't reach the server.";
  } finally {
    submit.disabled = false;
  }
});

/* ================= CHROME ================= */

function tickClock() {
  document.getElementById("clock").textContent =
    new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (themeMode === "auto") applyTheme("auto");
}

/* ================= PULL TO REFRESH =================
   Installed iOS PWAs run standalone with no browser chrome, so there's no native
   gesture to fall back on. Behaviour kept as-is; only the styling changed. */
(function setupPullToRefresh() {
  const indicator = document.getElementById("pull-refresh");
  const label = indicator.querySelector(".pull-label");
  const THRESHOLD = 70;
  const MAX_PULL = 110;

  let startY = null;
  let pulling = false;
  let refreshing = false;

  document.addEventListener("touchstart", (e) => {
    if (refreshing || window.scrollY > 0) return;
    startY = e.touches[0].clientY;
    pulling = true;
    indicator.classList.remove("settling");
    indicator.classList.add("dragging");
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!pulling || startY === null || refreshing) return;
    const delta = e.touches[0].clientY - startY;
    if (delta <= 0) return;
    const pull = Math.min(delta * 0.5, MAX_PULL);
    indicator.style.transform = `translateY(${pull - 56}px)`;
    indicator.classList.toggle("ready", pull >= THRESHOLD);
    label.textContent = pull >= THRESHOLD ? "RELEASE TO REFRESH" : "PULL TO REFRESH";
  }, { passive: true });

  document.addEventListener("touchend", () => {
    if (!pulling || refreshing) return;
    pulling = false;
    indicator.classList.remove("dragging");
    indicator.classList.add("settling");

    if (indicator.classList.contains("ready")) {
      refreshing = true;
      indicator.classList.add("refreshing");
      indicator.style.transform = "translateY(0px)";
      label.textContent = "REFRESHING";
      loadFlights().finally(() => {
        setTimeout(() => {
          indicator.style.transform = "translateY(-56px)";
          indicator.classList.remove("ready", "refreshing");
          refreshing = false;
        }, 350);
      });
    } else {
      indicator.style.transform = "translateY(-56px)";
    }
    startY = null;
  });
})();

/* ================= INIT ================= */

(async function init() {
  app.dataset.density = density;
  applyDensity(density);
  applyTheme(themeMode);
  tickClock();

  const ok = await ensureList();
  if (!ok) {
    main.innerHTML = `<div class="warn-strip">${icon("triangle-alert")}
      <span>Couldn't set up your list. Check your connection and reload.</span></div>`;
    return;
  }
  await loadFlights();
})();

setInterval(tickClock, 1000);
setInterval(tickCountdowns, 30000);
