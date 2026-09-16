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
const LS_ACKED = "fw_acked_at"; // newest change timestamp the driver has looked at

let listCode = localStorage.getItem(LS_LIST_CODE);
let ntfyTopic = localStorage.getItem(LS_NTFY_TOPIC);
let density = localStorage.getItem(LS_DENSITY) === "card" ? "card" : "board";
let themeMode = localStorage.getItem(LS_THEME) || "auto"; // auto | night | day

let settings = { driveMinutes: {}, bufferMinutes: 10, showPassengerNames: true };
let entries = [];
let offline = false;
let lastFetchedAt = 0;      // epoch ms of the last successful load
let lastFetchedIso = null;  // the freshest status timestamp we hold
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

// Escapes each part, then joins with a raw separator entity. Keeping the escape
// inside the helper is what stops the "&rarr; rendered literally" class of bug:
// callers never hand-manage which fragments may be escaped.
function joinParts(parts, separator) {
  return parts.filter((p) => p !== null && p !== undefined && p !== "")
    .map(esc)
    .join(separator || " &middot; ");
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

// For real UTC instants (status.fetchedAt), as opposed to the airport wall-clock
// strings everything else here handles. This one DOES convert to the reader's
// timezone — "showing data from 14:10" is only useful against their own clock.
function instantTime(iso) {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
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

/* --- change tracking --- */

function latestChangeAt(entry) {
  const list = entry.recentChanges || [];
  return list.length ? new Date(list[0].at).getTime() : 0;
}

function acknowledgedAt() {
  return Number(localStorage.getItem(LS_ACKED) || 0);
}

// Entries that changed recently and that the driver hasn't looked at yet.
function unacknowledged() {
  const acked = acknowledgedAt();
  return entries.filter((e) => latestChangeAt(e) > acked);
}

function acknowledgeChanges() {
  const newest = entries.reduce((max, e) => Math.max(max, latestChangeAt(e)), 0);
  localStorage.setItem(LS_ACKED, String(newest || Date.now()));
  renderHome();
}

// The chip in the changed state names what moved, not just the status.
function changeChipLabel(entry) {
  const lines = (entry.recentChanges || []).flatMap((h) => h.changes);
  const delay = entry.status ? delayMinutes(entry.status.arrival) : null;
  if (lines.some((l) => /time/i.test(l)) && delay !== null && delay > 0) return `DELAYED ${delay}M`;
  if (lines.some((l) => /gate/i.test(l))) return "GATE CHANGE";
  if (lines.some((l) => /terminal/i.test(l))) return "TERMINAL CHANGE";
  if (lines.some((l) => /cancel/i.test(l))) return "CANCELLED";
  if (lines.some((l) => /status/i.test(l))) return statusLabel(entry.status);
  return "UPDATED";
}

// "Delayed 38m at BOS" — a reason a driver can act on, not a field diff.
function changeReason(entry) {
  const lines = (entry.recentChanges || []).flatMap((h) => h.changes);
  const gate = lines.find((l) => /gate/i.test(l));
  const time = lines.find((l) => /time/i.test(l));
  const state = lines.find((l) => /status/i.test(l));
  const delay = entry.status ? delayMinutes(entry.status.arrival) : null;

  if (delay !== null && delay > 0 && time) {
    const at = entry.status.departure.airportCode;
    return `Delayed ${delay}m${at ? ` at ${at}` : ""}`;
  }
  if (gate) {
    const to = gate.split("→").pop().trim();
    return `Gate ${to}`;
  }
  if (state) return state.replace(/^Status changed:\s*/i, "");
  return lines[0] || "Updated";
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

function renderHero(entry, hasChanged) {
  const { flight, status } = entry;
  const id = flightId(flight);
  const prev = prevValues.get(id) || {};
  const subject = heroSubject(flight);
  const sev = hasChanged ? "alert" : severity(status);

  if (!status) {
    // Still carries data-flight: without it this flight can't be opened, and
    // since delete lives on flight detail, it couldn't be removed either.
    return `
      <section class="hero" data-flight="${esc(flight.flightNumber)}" data-date="${esc(flight.date)}"
               role="button" tabindex="0">
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
    // Never run a live countdown against stale data — that is the one thing
    // here that would actively mislead someone about when to leave.
    countdown = `<div class="countdown">
        <span class="eyebrow">AS OF</span>
        <span class="cd-value is-stale">${esc(instantTime(status.fetchedAt) || "&mdash;")}</span>
      </div>`;
  } else if (utc) {
    // Label from the reported status, not from the clock: an overdue flight the
    // API still calls EnRoute has not landed, and saying so next to an ON TIME
    // chip is both contradictory and a claim we can't support.
    const diff = new Date(utc).getTime() - Date.now();
    const landed = isLanded(status);
    const label = landed ? "LANDED" : diff > 0 ? "LANDS IN" : "DUE";
    const value = landed || diff > 0 ? formatDuration(diff) : "NOW";
    countdown = `<div class="countdown">
        <span class="eyebrow">${label}</span>
        <span class="cd-value"${diff > 0 ? ` data-countdown="${esc(utc)}"` : ""}>${value}</span>
      </div>`;
  }

  const routePair = joinParts(
    [dep.airportCode || dep.airport, arrLeg.airportCode || arrLeg.airport], " &rarr; "
  );
  const route = status.airline ? `${esc(status.airline)} &middot; ${routePair}` : routePair;

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
        ${offline
          ? `<span class="chip is-unknown">LAST KNOWN</span>`
          : hasChanged
            ? `<span class="chip is-alert">${icon("triangle-alert", "ico-sm")}${changeChipLabel(entry)}</span>`
            : chipFor(status)}
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

  const heroCls = [
    "hero",
    sev === "alert" ? "is-alert" : "",
    offline ? "is-stale" : "",
  ].filter(Boolean).join(" ");
  const openTag = `<section class="${heroCls}"` +
    ` data-flight="${esc(flight.flightNumber)}" data-date="${esc(flight.date)}" role="button" tabindex="0">`;
  // Board keeps the instrument strip full-bleed below the panel; card insets it
  // into the hero card itself.
  return density === "card"
    ? `${openTag}${heroInner}${instruments}</section>${leaveby}`
    : `${openTag}${heroInner}</section>${instruments}${leaveby}`;
}

function rowMeta(entry) {
  const { flight, status } = entry;
  const route = status
    ? joinParts([status.departure.airportCode || status.departure.airport,
                 status.arrival.airportCode || status.arrival.airport], " &rarr; ")
    : esc(shortDate(flight.date));
  const who = flight.passenger && settings.showPassengerNames ? esc(flight.passenger) : "";
  return who ? `${route} &middot; ${who}` : route;
}

function renderBoardRow(entry) {
  const { flight, status } = entry;
  const sev = severity(status);
  const cls = sev === "alert" ? " is-delayed" : sev === "landed" ? " is-landed" : "";
  const t = shortTime(arrivalLocal(status));
  const delay = status ? delayMinutes(status.arrival) : null;
  const utc = arrivalUtc(status);

  // A flight whose arrival time has passed but which isn't reported landed yet
  // must not show a countdown: formatDuration takes the absolute value, so it
  // would read exactly like a flight still that far in the future.
  const remaining = utc ? new Date(utc).getTime() - Date.now() : null;
  const live = remaining !== null && remaining > 0 && sev !== "landed" && !(delay > 0);

  let delta = "";
  if (sev === "landed") delta = "LANDED";
  else if (delay !== null && delay > 0) delta = `+${delay}M`;
  else if (live) delta = formatDuration(remaining);
  else if (remaining !== null) delta = "DUE";

  return `
    <button class="row${cls}" type="button" data-flight="${esc(flight.flightNumber)}" data-date="${esc(flight.date)}">
      <span class="dot"></span>
      <span class="code">${esc(flight.flightNumber)}</span>
      <span class="meta">${rowMeta(entry)}</span>
      <span class="time">${esc(t) || "&mdash;"}</span>
      <span class="delta"${live ? ` data-countdown="${esc(utc)}"` : ""}>${delta}</span>
    </button>`;
}

function renderFlightCard(entry) {
  const { flight, status } = entry;
  const sev = severity(status);
  const cls = sev === "alert" ? " is-delayed" : sev === "landed" ? " is-landed" : "";
  const t = shortTime(arrivalLocal(status));
  const who = flight.passenger && settings.showPassengerNames ? esc(flight.passenger) : "";
  const sub = status
    ? joinParts([status.departure.airportCode || status.departure.airport,
                 status.arrival.airportCode || status.arrival.airport], " &rarr; ") +
      (status.arrival.terminal ? ` &middot; Terminal ${esc(status.arrival.terminal)}` : "")
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

function renderFooter(changed) {
  const footer = document.querySelector(".footer-cta");
  if (offline) {
    footer.innerHTML = `<button class="cta" id="retry-btn" type="button">
        ${icon("refresh-cw", "ico-md")}TRY AGAIN
      </button>`;
    document.getElementById("retry-btn").addEventListener("click", () => loadFlights());
    return;
  }
  if (changed.length) {
    // In the changed state the footer reports freshness instead of offering the CTA.
    const elapsed = lastFetchedAt ? Date.now() - lastFetchedAt : 0;
    const age = !lastFetchedAt || elapsed < 60000
      ? "just now"
      : `${formatDuration(elapsed).toLowerCase()} ago`;
    footer.innerHTML = `<p class="freshness">${icon("refresh-cw", "ico-md")}
      Checked ${esc(age)} &middot; pull to refresh</p>`;
    return;
  }
  footer.innerHTML = `<button class="cta${entries.length ? "" : " filled"}" id="add-btn" type="button">
      ${icon("plus", "ico-md")}ADD A FLIGHT
    </button>`;
  document.getElementById("add-btn").addEventListener("click", openAddSheet);
}

function renderHome() {
  const changed = offline ? [] : unacknowledged();
  const bell = document.getElementById("bell-btn");
  bell.classList.toggle("unread", changed.length > 0);
  bell.querySelector("use").setAttribute("href", changed.length ? "#i-bell-ring" : "#i-bell");

  // Offline swaps the chrome controls for a plain offline flag.
  bell.hidden = offline;
  document.getElementById("settings-btn").hidden = offline;
  document.getElementById("offline-flag").hidden = !offline;

  if (!entries.length) {
    main.innerHTML = renderEmpty();
    renderFooter(changed);
    return;
  }

  const sorted = sortEntries(entries);
  const hero = sorted[0];
  const rest = sorted.slice(1);

  const staleStrip = offline
    ? `<div class="warn-strip">
         ${icon("triangle-alert")}
         <span>No connection. Showing what was true at
         <span class="mono">${esc(instantTime(lastFetchedIso) || "earlier")}</span>. Times may have moved.</span>
       </div>`
    : "";

  let list = "";
  if (changed.length) {
    // Changed state: the list narrows to what moved, each with a plain-language reason.
    list = `
      <div class="list-header">
        <span class="eyebrow">CHANGED IN THE LAST HOUR</span>
        <span class="rule"></span>
        <span class="count">${changed.length}</span>
      </div>
      ${changed.map((e) => `
        <button class="row is-change" type="button" data-flight="${esc(e.flight.flightNumber)}" data-date="${esc(e.flight.date)}">
          <span class="dot"></span>
          <span class="code">${esc(e.flight.flightNumber)}</span>
          <span class="meta">${esc(changeReason(e))}</span>
          <span class="time">${esc(shortTime(arrivalLocal(e.status)) || "—")}</span>
        </button>`).join("")}
      <button class="ack-btn" id="ack-btn" type="button">GOT IT &mdash; SHOW ALL FLIGHTS</button>`;
  } else if (rest.length) {
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

  const body = renderHero(hero, changed.some((c) => c.flight === hero.flight)) + list;
  main.innerHTML = staleStrip + (density === "card"
    ? `<div style="padding:14px var(--gutter) 0;display:flex;flex-direction:column;gap:14px">${body}</div>`
    : body);

  const ack = document.getElementById("ack-btn");
  if (ack) ack.addEventListener("click", acknowledgeChanges);

  renderFooter(changed);
}

/* ================= FLIGHT DETAIL ================= */

let detailKey = null; // "NUMBER:DATE" of the flight currently open

function legLine(status, side) {
  const leg = status[side];
  const arriving = side === "arrival";
  const bits = [];
  if (arriving) bits.push(isLanded(status) ? "Landed" : "Arriving");
  else bits.push(/depart|enroute|landed|arrived/i.test(status.status) ? "Departed" : "Departs");
  if (leg.terminal) bits.push(`Terminal ${leg.terminal}`);
  if (leg.gate) bits.push(`gate ${leg.gate}`);
  const delay = delayMinutes(leg);
  return {
    title: esc(leg.airport || leg.airportCode || "—"),
    sub: esc(bits.join(" · ")),
    value: esc(shortTime(leg.estimatedTime || leg.scheduledTime) || "—"),
    late: delay !== null && delay > 0,
  };
}

function renderDetail(entry, history) {
  const { flight, status } = entry;
  const host = document.getElementById("detail-body");

  document.getElementById("detail-title").textContent = flight.flightNumber;
  document.getElementById("detail-date").textContent = shortDate(flight.date);

  const pickupRows = [
    { label: "Passenger", value: flight.passenger },
    { label: "Drop-off", value: flight.dropOff },
    { label: "Passengers", value: flight.pax ? `${flight.pax}` : null },
    { label: "Note", value: flight.note },
  ].map((r) => `
      <div class="prow">
        <span class="prow-label">${r.label}</span>
        <span class="prow-value${r.value ? "" : " empty"}">${r.value ? esc(r.value) : "Not set"}</span>
      </div>`).join("");

  let summary = "";
  let legs = "";
  let driveRow = "";

  if (status) {
    const arr = status.arrival;
    const parts = timeParts(arr.estimatedTime || arr.scheduledTime) || { time: "—", meridiem: "" };
    const tz = tzAbbreviation(arr.estimatedTime || arr.scheduledTime, arr.timeZone);
    summary = `
      <div class="arrival-summary">
        <div>
          <span class="eyebrow">ARRIVES ${esc(arr.airportCode || "")}</span>
          <div class="arrival-time">${parts.time}<span class="arrival-tz">${parts.meridiem}${tz ? " " + esc(tz) : ""}</span></div>
        </div>
        ${chipFor(status)}
      </div>`;

    const dep = legLine(status, "departure");
    const arrL = legLine(status, "arrival");
    legs = `
      <div class="irow">
        <svg><use href="#i-plane-takeoff" /></svg>
        <span class="irow-text">
          <span class="irow-title">${dep.title}</span>
          <span class="irow-sub">${dep.sub}</span>
        </span>
        <span class="irow-value${dep.late ? " is-alert" : ""}">${dep.value}</span>
      </div>
      <div class="irow is-arrival">
        <svg><use href="#i-plane-landing" /></svg>
        <span class="irow-text">
          <span class="irow-title">${arrL.title}</span>
          <span class="irow-sub">${arrL.sub}</span>
        </span>
        <span class="irow-value${arrL.late ? " is-alert" : ""}">${arrL.value}</span>
      </div>`;

    const lb = leaveByFor(status);
    if (lb && !lb.unset) {
      driveRow = `
        <button class="prow" type="button" data-set-drive="${esc(lb.iata)}">
          <span class="prow-label">Drive + buffer</span>
          <span class="prow-value">${lb.drive}m to ${esc(lb.iata)} + ${lb.buffer}m &mdash; leave by ${esc(lb.time)}</span>
          <svg><use href="#i-chevron-right" /></svg>
        </button>`;
    } else if (lb && lb.unset) {
      driveRow = `
        <button class="prow" type="button" data-set-drive="${esc(lb.iata)}">
          <span class="prow-label">Drive + buffer</span>
          <span class="prow-value empty">Set a drive time for ${esc(lb.iata)}</span>
          <svg><use href="#i-chevron-right" /></svg>
        </button>`;
    }
  } else {
    summary = `<div class="arrival-summary"><div>
        <span class="eyebrow">ARRIVES</span>
        <div class="arrival-time">&mdash;</div>
      </div>${chipFor(null)}</div>`;
  }

  const histItems = (history || []).length
    ? history.map((h) => {
        const when = new Date(h.at);
        const label = when.toLocaleString("en-GB", {
          day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
        });
        return `<div class="hist-item">
            <span class="hist-when">${esc(label)}</span>
            <span class="hist-lines">${h.changes.map(esc).join("<br>")}</span>
          </div>`;
      }).join("")
    : `<p class="hist-empty">Nothing has changed since you started tracking this flight.</p>`;

  host.innerHTML = `
    ${summary}
    ${legs}
    <span class="eyebrow" style="display:block;padding:20px var(--gutter) 8px">PICKUP</span>
    ${pickupRows}
    ${driveRow}
    <span class="eyebrow" style="display:block;padding:20px var(--gutter) 0">HISTORY</span>
    <div class="hist">${histItems}</div>`;
}

// Keeps an open detail sheet in step with a background refresh — without this it
// keeps rendering the entry object captured when it was opened.
function refreshOpenDetail() {
  if (!detailKey || document.getElementById("detail-sheet").hidden) return;
  const [flightNumber, date] = splitDetailKey(detailKey);
  const entry = entries.find((e) => e.flight.flightNumber === flightNumber && e.flight.date === date);
  if (entry) renderDetail(entry, lastHistory);
  else { detailKey = null; closeSheet("detail-sheet"); }
}

function splitDetailKey(key) {
  const at = key.lastIndexOf(":");
  return [key.slice(0, at), key.slice(at + 1)];
}

let lastHistory = null;

async function openDetail(flightNumber, date) {
  const entry = entries.find((e) => e.flight.flightNumber === flightNumber && e.flight.date === date);
  if (!entry) return;
  detailKey = `${flightNumber}:${date}`;
  lastHistory = null;
  renderDetail(entry, null);
  openSheet("detail-sheet");

  try {
    const res = await fetch(`${API_BASE}/api/history?listCode=${encodeURIComponent(listCode)}` +
      `&flightNumber=${encodeURIComponent(flightNumber)}&date=${encodeURIComponent(date)}`);
    if (!res.ok) return;
    const data = await res.json();
    // Only paint if the user hasn't navigated away while this was in flight.
    if (detailKey === `${flightNumber}:${date}`) {
      lastHistory = data.history;
      refreshOpenDetail();
    }
  } catch (err) {
    console.error("Couldn't load history:", err);
  }
}

/* ================= COUNTDOWN ================= */

// Milestones already reloaded for, so a flight that stays past its arrival time
// doesn't re-trigger a fetch on every single tick forever.
const reloadedFor = new Set();

function tickCountdowns() {
  const now = Date.now();
  let crossed = false;
  document.querySelectorAll("[data-countdown]").forEach((el) => {
    const key = el.dataset.countdown;
    const diff = new Date(key).getTime() - now;
    if (diff <= 0) {
      if (!reloadedFor.has(key)) { reloadedFor.add(key); crossed = true; }
      return;
    }
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

function applyPayload(data, fromCache) {
  ntfyTopic = data.ntfyTopic;
  settings = Object.assign({ driveMinutes: {}, bufferMinutes: 10, showPassengerNames: true }, data.settings || {});
  entries = data.entries || [];
  lastFetchedIso = entries.reduce(
    (newest, e) => (e.status && e.status.fetchedAt > (newest || "") ? e.status.fetchedAt : newest),
    null
  );
  localStorage.setItem(LS_NTFY_TOPIC, ntfyTopic);
  if (!fromCache) {
    lastFetchedAt = Date.now();
    localStorage.setItem(LS_LAST_GOOD, JSON.stringify(data));
  }
}

async function loadFlights() {
  try {
    const res = await fetch(`${API_BASE}/api/flights?listCode=${encodeURIComponent(listCode)}`);
    if (!res.ok) {
      // Clear offline first and re-render the chrome: the offline layout hides
      // the settings button, and this message tells the driver to open it.
      offline = false;
      entries = [];
      renderHome();
      main.innerHTML = `<div class="warn-strip">${icon("triangle-alert")}
        <span>That list code isn't recognised. Open Settings to switch to a different one.</span></div>`;
      return;
    }
    offline = false;
    applyPayload(await res.json());
    renderHome();
    refreshOpenDetail();
    syncSettingsSheet();
  } catch (err) {
    console.error(err);
    const cached = localStorage.getItem(LS_LAST_GOOD);
    if (cached) {
      offline = true;
      try { applyPayload(JSON.parse(cached), true); } catch (_) { /* fall through */ }
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

let resolvedTheme = null;

function setThemeMode(mode) {
  themeMode = mode;
  localStorage.setItem(LS_THEME, mode);
  ["auto", "night", "day"].forEach((m) => {
    document.getElementById(`theme-${m}`).setAttribute("aria-pressed", String(m === mode));
  });
  applyResolvedTheme();
}

// Called once a second from the clock tick, so it only touches the DOM when the
// resolved theme actually flips — twice a day, not 86,400 times.
function applyResolvedTheme() {
  const resolved = resolveTheme();
  if (resolved === resolvedTheme) return;
  resolvedTheme = resolved;

  if (resolved === "day") document.documentElement.setAttribute("data-theme", "day");
  else document.documentElement.removeAttribute("data-theme");
  document.querySelector('meta[name="theme-color"]')
    .setAttribute("content", resolved === "day" ? "#EFECE4" : "#0E1B30");
}

/* ================= SHEETS ================= */

// Which element opened each sheet, so focus can go back where it came from.
const sheetOpener = new Map();

function openSheet(id) {
  const sheet = document.getElementById(id);
  if (!sheet.hidden) return;
  sheetOpener.set(id, document.activeElement);
  sheet.hidden = false;
  // Move focus into the sheet, otherwise it stays on the now-hidden trigger and
  // tabbing walks the home screen behind the overlay.
  const first = sheet.querySelector("button, input, textarea, [tabindex]");
  if (first) first.focus();
}

function closeSheet(id) {
  const sheet = document.getElementById(id);
  if (sheet.hidden) return;
  sheet.hidden = true;
  // Detail state is cleared here rather than at each call site, so Escape and
  // the back chevron can't leave detailKey pointing at a closed sheet.
  if (id === "detail-sheet") { detailKey = null; lastHistory = null; }
  const opener = sheetOpener.get(id);
  sheetOpener.delete(id);
  if (opener && document.contains(opener) && opener.focus) opener.focus();
}

function topmostOpenSheet() {
  const open = Array.from(document.querySelectorAll(".sheet")).filter((s) => !s.hidden);
  return open.length ? open[open.length - 1] : null;
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const sheet = topmostOpenSheet();
  if (sheet) { e.preventDefault(); closeSheet(sheet.id); }
});

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

  // A background refresh must not yank a half-typed value out from under the
  // driver, so skip rebuilding any field they're currently editing.
  const editing = document.activeElement;
  const editingSettings = editing && editing.closest && editing.closest("#settings-sheet");
  if (!editingSettings) document.getElementById("buffer-input").value = settings.bufferMinutes;

  const airports = new Map();
  entries.forEach(({ status }) => {
    if (status && status.arrival.airportCode) {
      airports.set(status.arrival.airportCode, status.arrival.airport);
    }
  });

  const host = document.getElementById("drive-rows");
  document.getElementById("drive-empty").hidden = airports.size > 0;
  if (editingSettings) return; // leave the DOM alone mid-edit

  host.innerHTML = Array.from(airports.entries()).map(([iata, name]) => {
    // A drive time of 0 is meaningful (pickup point is at the airport), so this
    // checks for an actual number rather than truthiness.
    const stored = settings.driveMinutes[iata];
    const value = typeof stored === "number" ? String(stored) : "";
    return `
    <div class="set-row">
      <span class="set-value" style="width:46px">${esc(iata)}</span>
      <span class="lbl drive-name">${esc(name)}</span>
      <input class="num-input" type="number" min="0" max="300" step="5"
             data-drive="${esc(iata)}" value="${esc(value)}"
             placeholder="--" aria-label="Drive time to ${esc(iata)} in minutes" />
      <span class="lbl">min</span>
    </div>`;
  }).join("");

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
  document.getElementById(`theme-${m}`).addEventListener("click", () => setThemeMode(m));
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
    // Every piece of derived per-list state has to go, or the new list inherits
    // the old one's. The acknowledged timestamp is the dangerous one: if it's
    // newer than the new list's changes, its alerts are silently suppressed.
    localStorage.removeItem(LS_ACKED);
    prevValues.clear();
    reloadedFor.clear();
    detailKey = null;
    lastHistory = null;
    closeSheet("detail-sheet");
    applyPayload(await res.json());
    renderHome();
    syncSettingsSheet();
  } catch (err) {
    console.error(err);
    window.alert("Couldn't reach the server. Try again.");
  }
});

// Tapping the leave-by derivation jumps to that airport's drive-time field.
// Delegated at document level so it works from the detail sheet too.
document.addEventListener("click", (e) => {
  const setDrive = e.target.closest("[data-set-drive]");
  if (setDrive) {
    syncSettingsSheet();
    openSheet("settings-sheet");
    const field = document.querySelector(`[data-drive="${setDrive.dataset.setDrive}"]`);
    if (field) { field.focus(); field.select(); }
    return;
  }
  const flightEl = e.target.closest("[data-flight]");
  if (flightEl && main.contains(flightEl)) {
    openDetail(flightEl.dataset.flight, flightEl.dataset.date);
  }
});

// The hero is a section rather than a button (it contains its own leave-by
// button), so it needs keyboard activation wired up by hand.
main.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const hero = e.target.closest(".hero[data-flight]");
  if (!hero) return;
  e.preventDefault();
  openDetail(hero.dataset.flight, hero.dataset.date);
});

document.getElementById("detail-back").addEventListener("click", () => {
  detailKey = null;
  closeSheet("detail-sheet");
});

document.getElementById("detail-delete").addEventListener("click", async () => {
  if (!detailKey) return;
  const [flightNumber, date] = detailKey.split(":");
  const entry = entries.find((x) => x.flight.flightNumber === flightNumber && x.flight.date === date);
  const who = entry && entry.flight.passenger ? ` (${entry.flight.passenger})` : "";
  if (!window.confirm(`Stop tracking ${flightNumber}${who}? You'll stop getting its alerts.`)) return;

  try {
    const res = await fetch(`${API_BASE}/api/flights`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listCode, flightNumber, date }),
    });
    if (!res.ok) { window.alert("Couldn't stop tracking that flight. Try again."); return; }
    detailKey = null;
    closeSheet("detail-sheet");
    await loadFlights();
  } catch (err) {
    console.error(err);
    window.alert("Couldn't reach the server. Try again.");
  }
});

function openAddSheet() {
  document.getElementById("f-error").textContent = "";
  openSheet("add-sheet");
  document.getElementById("f-number").focus();
}
document.getElementById("add-cancel").addEventListener("click", () => closeSheet("add-sheet"));
document.getElementById("bell-btn").addEventListener("click", acknowledgeChanges);

document.getElementById("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const submit = document.getElementById("add-submit");
  const errorEl = document.getElementById("f-error");
  const payload = {
    listCode,
    flightNumber: form.flightNumber.value.trim().toUpperCase(),
    date: form.date.value,
  };
  // Only send pickup fields the driver actually filled in. The Worker treats a
  // present-but-null key as "clear this", so sending blanks here would wipe the
  // details of a flight that is already tracked.
  const passenger = form.passenger.value.trim();
  const dropOff = form.dropOff.value.trim();
  const note = form.note.value.trim();
  if (passenger) payload.passenger = passenger;
  if (dropOff) payload.dropOff = dropOff;
  if (note) payload.note = note;
  if (form.pax.value !== "") payload.pax = Number(form.pax.value);

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
  if (themeMode === "auto") applyResolvedTheme();
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
  setThemeMode(themeMode);
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
