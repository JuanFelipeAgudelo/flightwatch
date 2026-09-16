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

// Mirrors the Worker's DEFAULT_SETTINGS, which follow the department's written
// guidelines: arrive 15m before a landing, 1.5h/2h check-in for a departure.
const DEFAULT_SETTINGS = {
  driveMinutes: {}, bufferMinutes: 15,
  checkInLeadMinutes: 90, checkInLeadIntlMinutes: 120,
  showPassengerNames: true,
};
let settings = { ...DEFAULT_SETTINGS };
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

// A flight's id stays derivable so rows written before Phase 1 address the same
// way they always did; everything else carries an explicit one.
function jobIdOf(job) {
  return job.id || `${job.flightNumber}:${job.date}`;
}

function jobIdFromEl(el) {
  return el.dataset.job || `${el.dataset.flight}:${el.dataset.date}`;
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

// Sort key, and the basis for "is this in the past" — so it must be a REAL
// instant, not a wall clock. parseWall deliberately parses "06:00" as 06:00 UTC
// because for display that string is only ever a carrier; comparing that raw
// value against a flight's true instant, or against Date.now(), is four or five
// hours wrong. Fixed-time jobs are local to places that are all US/Eastern, so
// they are resolved through that zone.
const LOCAL_ZONE = "America/New_York";

// Offset of a zone from UTC at a given instant, in ms. Derived from the parts
// the formatter reports rather than assumed, so DST is handled.
function zoneOffsetMs(date, zone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const asUtc = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour % 24, +parts.minute, +parts.second
  );
  return asUtc - date.getTime();
}

// Turn a wall-clock string in `zone` into the real instant it names.
function wallToInstant(raw, zone) {
  const wall = parseWall(raw);
  if (!wall) return null;
  // The offset depends on the instant, which depends on the offset; one
  // correction pass is enough outside the ambiguous hour at a DST boundary.
  const guess = wall.getTime() - zoneOffsetMs(wall, zone);
  return guess - (zoneOffsetMs(new Date(guess), zone) - zoneOffsetMs(wall, zone));
}

function targetInstant(entry) {
  const target = targetFor(entry);
  if (!target) return Infinity;
  if (target.utc) return new Date(target.utc).getTime();
  const at = wallToInstant(target.local, LOCAL_ZONE);
  return at === null ? Infinity : at;
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

// A fixed-time job has no live status, so "UNKNOWN" would be wrong — nothing is
// unknown about a 6:00 AM appointment. It states what kind of job it is instead.
const FIXED_KIND_LABEL = { appointment: "APPOINTMENT", shift: "SHIFT" };

function entryLabel(entry) {
  const kind = kindOf(entry.flight);
  if (!isFlightKind(kind)) return FIXED_KIND_LABEL[kind] || "SCHEDULED";
  return statusLabel(entry.status);
}

function entrySeverity(entry) {
  const kind = kindOf(entry.flight);
  // Fixed-time work is never "delayed" or "landed" — it is simply due or past.
  if (!isFlightKind(kind)) {
    const at = targetInstant(entry);
    return at !== Infinity && at < Date.now() ? "landed" : "ok";
  }
  return severity(entry.status);
}

function entryChip(entry) {
  const sev = entrySeverity(entry);
  const label = entryLabel(entry);
  if (sev === "ok") return `<span class="chip"><span class="dot"></span>${label}</span>`;
  if (sev === "alert") return `<span class="chip is-alert">${label}</span>`;
  if (sev === "landed") return `<span class="chip is-landed">${label}</span>`;
  return `<span class="chip is-unknown">${label}</span>`;
}

/* --- target time: the moment leave-by counts back from --- */

function kindOf(job) {
  return (job && job.kind) || "arrival";
}

function isFlightKind(kind) {
  return kind === "arrival" || kind === "departure";
}

// Which leg of a flight record this job cares about. An arrival pickup waits for
// the plane to land; a departure drop-off is racing the plane leaving.
function legFor(entry) {
  const kind = kindOf(entry.flight);
  if (!entry.status || !isFlightKind(kind)) return null;
  return kind === "departure" ? entry.status.departure : entry.status.arrival;
}

// The single thing the whole app now counts down to. `local` is a wall-clock
// string at the place it happens; `utc` is a real instant and is only available
// for flights, which is why fixed-time jobs get no live countdown.
function targetFor(entry) {
  const kind = kindOf(entry.flight);
  if (isFlightKind(kind)) {
    const leg = legFor(entry);
    if (!leg) return null;
    return {
      kind,
      local: leg.estimatedTime || leg.scheduledTime || null,
      utc: leg.estimatedTimeUtc || leg.scheduledTimeUtc || null,
      placeCode: leg.airportCode || null,
      place: leg.airport || null,
    };
  }
  return {
    kind,
    local: entry.flight.targetTime || null,
    utc: null,
    placeCode: entry.flight.placeCode || null,
    place: entry.flight.place || null,
  };
}

// Null when it can't be told. Callers must decide which way to fail, because
// guessing domestic makes the driver leave LATER — the error that misses a flight.
function isInternational(entry) {
  if (!entry.status) return null;
  const zones = [entry.status.departure.timeZone, entry.status.arrival.timeZone].filter(Boolean);
  if (zones.length < 2) return null;
  return zones.some((z) => !/^America\//.test(z));
}

function checkInLeadFor(entry) {
  // Unknown falls to the longer lead: leaving early costs waiting, leaving
  // late costs the flight.
  return isInternational(entry) === false
    ? (settings.checkInLeadMinutes ?? 90)
    : (settings.checkInLeadIntlMinutes ?? 120);
}

// How long after touchdown before the passenger is actually in the car. The
// department allows 45m domestic for luggage, 60m international for claim and
// customs — so a landed flight is not a finished job.
function deplaneMinutes(entry) {
  return isInternational(entry) === true ? 60 : 45;
}

// leaveBy = target − checkInLead (departures only) − drive − buffer, computed in
// the destination's own wall-clock so it never crosses a timezone. Returns
// {unset} when the drive time isn't set — a guessed number would put someone at
// the curb at the wrong time.
function leaveByFor(entry) {
  const target = targetFor(entry);
  if (!target || !target.local || !target.placeCode) return null;

  const drive = settings.driveMinutes[target.placeCode];
  if (typeof drive !== "number") return { unset: true, iata: target.placeCode };

  const wall = parseWall(target.local);
  if (!wall) return null;

  // A departure has to be there before the plane leaves, not as it leaves — and
  // an international one needs longer. Inferred from the far end's timezone,
  // which is a proxy, not a fact: Canada and Mexico read as America/* too.
  const lead = target.kind === "departure" ? checkInLeadFor(entry) : 0;
  const at = new Date(wall.getTime() - (lead + drive + settings.bufferMinutes) * 60000);
  const s = at.toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "UTC",
  });
  return {
    time: s,
    drive,
    buffer: settings.bufferMinutes,
    lead,
    iata: target.placeCode,
  };
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
    at: targetInstant(e),
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

// Shared by both heroes. The derivation line spells out the arithmetic, and a
// departure shows its check-in lead because that term is why the two directions
// produce different answers from the same flight.
function renderLeaveBy(lb) {
  if (lb.unset) {
    return `<div class="leaveby">
        ${icon("car", "ico-lg")}
        <div class="lb-stack"><span class="lb-label">LEAVE BY</span></div>
        <span class="spacer"></span>
        <button class="lb-deriv" type="button" data-set-drive="${esc(lb.iata)}">
          Set drive time<br>for ${esc(lb.iata)}
        </button>
      </div>`;
  }
  const derivation = lb.lead
    ? `${lb.lead}m check-in<br>${lb.drive}m drive &middot; +${lb.buffer}m`
    : `${lb.drive}m drive<br>+${lb.buffer}m buffer`;
  return `<div class="leaveby">
      ${icon("car", "ico-lg")}
      <div class="lb-stack">
        <span class="lb-label">LEAVE BY</span>
        <span class="lb-time">${esc(lb.time)}</span>
      </div>
      <span class="spacer"></span>
      <button class="lb-deriv" type="button" data-set-drive="${esc(lb.iata)}">
        ${derivation}
      </button>
    </div>`;
}

// Job identity as DOM attributes. Flights keep flightNumber/date so existing
// rows address the same way they always did; everything else carries its id.
function jobAttrs(job) {
  return job.id
    ? `data-job="${esc(job.id)}"`
    : `data-flight="${esc(job.flightNumber)}" data-date="${esc(job.date)}"`;
}

// The hero for an appointment or a shift: same shape, same leave-by, but the
// target time is fixed, so there is no live countdown and no gate/claim strip.
function renderFixedHero(entry, subject, sev) {
  const { flight } = entry;
  const target = targetFor(entry);
  const parts = timeParts(target && target.local) || { time: "&mdash;", meridiem: "" };
  const kind = kindOf(flight);
  const eyebrow = kind === "shift" ? "NEXT SHIFT" : "NEXT APPOINTMENT";

  const wherePieces = [flight.place, flight.dropOff].filter(Boolean);
  const where = wherePieces.length ? joinParts(wherePieces) : "";
  const ends = flight.endTime ? `Until ${esc(shortTime(flight.endTime) || "")}` : "";

  const lb = leaveByFor(entry);
  const leaveby = lb ? renderLeaveBy(lb) : "";

  return `
    <section class="hero${sev === "alert" ? " is-alert" : ""}${offline ? " is-stale" : ""}"
             ${jobAttrs(flight)} role="button" tabindex="0">
      <div class="hero-top">
        <span class="eyebrow">${eyebrow}</span>
        ${entryChip(entry)}
      </div>
      <div class="pax-block">
        <span class="pax-name">${subject.primary}</span>
        <span class="pax-meta">${subject.meta}</span>
      </div>
      ${where ? `<div class="flight-line"><span class="route">${where}</span></div>` : ""}
      <div class="hero-bottom">
        <div>
          <div class="hero-time">${parts.time}<span class="meridiem">${parts.meridiem}</span></div>
          ${ends ? `<div class="hero-was">${ends}</div>` : ""}
        </div>
        <div class="countdown">
          <span class="eyebrow">${esc(shortDate((target && target.local || "").slice(0, 10)))}</span>
        </div>
      </div>
    </section>
    ${leaveby}`;
}

function renderHero(entry, hasChanged) {
  const { flight, status } = entry;
  const id = jobIdOf(flight);
  const prev = prevValues.get(id) || {};
  const subject = heroSubject(flight);
  const sev = hasChanged ? "alert" : entrySeverity(entry);

  // A fixed-time job never has a status and never will — it isn't waiting on
  // anything, so it renders its own target time rather than "no status yet".
  if (!status && !isFlightKind(kindOf(flight))) {
    return renderFixedHero(entry, subject, sev);
  }

  if (!status) {
    // Still carries the job id: without it this flight can't be opened, and
    // since delete lives on flight detail, it couldn't be removed either.
    return `
      <section class="hero" ${jobAttrs(flight)} role="button" tabindex="0">
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

  const target = targetFor(entry);
  const arr = target && target.local;
  const parts = timeParts(arr) || { time: "&mdash;", meridiem: "" };
  const dep = status.departure;
  const arrLeg = status.arrival;
  const delay = delayMinutes(arrLeg);
  const timeChanged = prev.arrTime && prev.arrTime !== arr;
  const gateChanged = prev.gate && prev.gate !== arrLeg.gate;

  const wasLine = delay !== null && delay > 0 && arrLeg.scheduledTime
    ? `<div class="hero-was">was <s>${esc(shortTime(arrLeg.scheduledTime))}</s> &middot; +${delay}m</div>`
    : "";

  const utc = target && target.utc;
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

  // Real belt from the API when the airport publishes one, em-dash when it
  // doesn't. No "usual belt" guess: a wrong carousel sends the driver to the
  // wrong end of the hall, which is worse than showing nothing.
  const claim = esc(arrLeg.baggageBelt) || "&mdash;";

  const lb = leaveByFor(entry);
  const leaveby = lb ? renderLeaveBy(lb) : "";

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
            : entryChip(entry)}
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
    ` ${jobAttrs(flight)} role="button" tabindex="0">`;
  // Board keeps the instrument strip full-bleed below the panel; card insets it
  // into the hero card itself.
  return density === "card"
    ? `${openTag}${heroInner}${instruments}</section>${leaveby}`
    : `${openTag}${heroInner}</section>${instruments}${leaveby}`;
}

// What a row shows in its fixed-width first column. A flight has a flight
// number; an appointment or shift has a place code, and failing that the date.
function rowCode(job) {
  if (job.flightNumber) return esc(job.flightNumber);
  if (job.placeCode) return esc(job.placeCode);
  return esc((FIXED_KIND_LABEL[kindOf(job)] || "JOB").slice(0, 5));
}

function rowMeta(entry) {
  const { flight, status } = entry;
  const lead = status
    ? joinParts([status.departure.airportCode || status.departure.airport,
                 status.arrival.airportCode || status.arrival.airport], " &rarr; ")
    : joinParts([flight.place, flight.note]) || esc(shortDate(flight.date));
  const who = flight.passenger && settings.showPassengerNames ? esc(flight.passenger) : "";
  return who ? `${lead} &middot; ${who}` : lead;
}

function renderBoardRow(entry) {
  const { flight, status } = entry;
  const sev = entrySeverity(entry);
  const cls = sev === "alert" ? " is-delayed" : sev === "landed" ? " is-landed" : "";
  const target = targetFor(entry);
  const t = shortTime(target && target.local);
  const leg = legFor(entry);
  const delay = leg ? delayMinutes(leg) : null;
  const utc = target && target.utc;

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
    <button class="row${cls}" type="button" ${jobAttrs(flight)}>
      <span class="dot"></span>
      <span class="code">${rowCode(flight)}</span>
      <span class="meta">${rowMeta(entry)}</span>
      <span class="time">${esc(t) || "&mdash;"}</span>
      <span class="delta"${live ? ` data-countdown="${esc(utc)}"` : ""}>${delta}</span>
    </button>`;
}

function renderFlightCard(entry) {
  const { flight, status } = entry;
  const sev = entrySeverity(entry);
  const cls = sev === "alert" ? " is-delayed" : sev === "landed" ? " is-landed" : "";
  const t = shortTime((targetFor(entry) || {}).local);
  const who = flight.passenger && settings.showPassengerNames ? esc(flight.passenger) : "";
  const sub = status
    ? joinParts([status.departure.airportCode || status.departure.airport,
                 status.arrival.airportCode || status.arrival.airport], " &rarr; ") +
      (status.arrival.terminal ? ` &middot; Terminal ${esc(status.arrival.terminal)}` : "")
    : joinParts([flight.place, flight.note]) || esc(shortDate(flight.date));

  return `
    <button class="fcard${cls}" type="button" ${jobAttrs(flight)}>
      <span class="fcard-line">
        <span class="code">${rowCode(flight)}</span>
        ${who ? `<span class="who">${who}</span>` : ""}
        <span class="spacer"></span>
        <span class="state">${entryLabel(entry)}</span>
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
        <button class="row is-change" type="button" ${jobAttrs(e.flight)}>
          <span class="dot"></span>
          <span class="code">${rowCode(e.flight)}</span>
          <span class="meta">${esc(changeReason(e))}</span>
          <span class="time">${esc(shortTime((targetFor(e) || {}).local) || "—")}</span>
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

function legLine(entry, side) {
  const status = entry.status;
  const leg = status[side];
  const arriving = side === "arrival";
  const bits = [];
  if (arriving) bits.push(isLanded(status) ? "Landed" : "Arriving");
  else bits.push(/depart|enroute|landed|arrived/i.test(status.status) ? "Departed" : "Departs");
  if (leg.terminal) bits.push(`Terminal ${leg.terminal}`);
  if (leg.gate) bits.push(`gate ${leg.gate}`);
  if (arriving && leg.baggageBelt) bits.push(`claim ${leg.baggageBelt}`);
  // Touchdown isn't handover: the department allows 45m domestic / 60m
  // international before the passenger is actually in the car. Only meaningful
  // on an arrival JOB — on a departure the arrival leg is the passenger's
  // destination city, which the driver never sees.
  if (arriving && kindOf(entry.flight) === "arrival") {
    bits.push(`allow ${deplaneMinutes(entry)}m for bags`);
  }
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

  const isFlight = isFlightKind(kindOf(flight)) && !!flight.flightNumber;
  const target = targetFor(entry);
  document.getElementById("detail-title").textContent =
    flight.flightNumber || flight.place || entryLabel(entry);
  document.getElementById("detail-date").textContent =
    shortDate(flight.date || (target && target.local || "").slice(0, 10));

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
        ${entryChip(entry)}
      </div>`;

    const dep = legLine(entry, "departure");
    const arrL = legLine(entry, "arrival");
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

    const lb = leaveByFor(entry);
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
  } else if (!isFlight) {
    // A fixed-time job: show the time it is booked for, not a flight arrival.
    const parts = timeParts(target && target.local) || { time: "&mdash;", meridiem: "" };
    const eyebrow = kindOf(flight) === "shift" ? "STARTS" : "APPOINTMENT";
    summary = `
      <div class="arrival-summary">
        <div>
          <span class="eyebrow">${eyebrow}${flight.placeCode ? " " + esc(flight.placeCode) : ""}</span>
          <div class="arrival-time">${parts.time}<span class="arrival-tz">${parts.meridiem}</span></div>
        </div>
        ${entryChip(entry)}
      </div>`;

    const rows = [
      flight.place ? { icon: "map-pin", title: esc(flight.place), sub: "Destination", value: "" } : null,
      flight.endTime
        ? { icon: "clock", title: "Ends", sub: "", value: esc(shortTime(flight.endTime) || "") }
        : null,
    ].filter(Boolean);
    legs = rows.map((r) => `
      <div class="irow">
        <svg><use href="#i-${r.icon}" /></svg>
        <span class="irow-text">
          <span class="irow-title">${r.title}</span>
          ${r.sub ? `<span class="irow-sub">${r.sub}</span>` : ""}
        </span>
        <span class="irow-value">${r.value}</span>
      </div>`).join("");

    const lb = leaveByFor(entry);
    if (lb) {
      driveRow = `
        <button class="prow" type="button" data-set-drive="${esc(lb.iata)}">
          <span class="prow-label">Drive + buffer</span>
          <span class="prow-value${lb.unset ? " empty" : ""}">${lb.unset
            ? `Set a drive time for ${esc(lb.iata)}`
            : `${lb.drive}m to ${esc(lb.iata)} + ${lb.buffer}m &mdash; leave by ${esc(lb.time)}`}</span>
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
    : `<p class="hist-empty">${isFlight
        ? "Nothing has changed since you started tracking this flight."
        : "Fixed-time jobs don't change on their own — only dispatch can move them."}</p>`;

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
  const entry = entries.find((e) => jobIdOf(e.flight) === detailKey);
  if (entry) renderDetail(entry, lastHistory);
  else { detailKey = null; closeSheet("detail-sheet"); }
}

let lastHistory = null;

async function openDetailById(id) {
  const entry = entries.find((e) => jobIdOf(e.flight) === id);
  if (!entry) return;
  detailKey = id;
  lastHistory = null;
  renderDetail(entry, null);
  openSheet("detail-sheet");

  // Only flight jobs have a change history to fetch.
  const job = entry.flight;
  if (!isFlightKind(kindOf(job)) || !job.flightNumber) return;

  try {
    const res = await fetch(`${API_BASE}/api/history?listCode=${encodeURIComponent(listCode)}` +
      `&flightNumber=${encodeURIComponent(job.flightNumber)}&date=${encodeURIComponent(job.date)}`);
    if (!res.ok) return;
    const data = await res.json();
    // Only paint if the user hasn't navigated away while this was in flight.
    if (detailKey === id) {
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
  settings = Object.assign({ ...DEFAULT_SETTINGS }, data.settings || {});
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
  entries.forEach((entry) => {
    const target = targetFor(entry);
    if (target && target.placeCode) {
      airports.set(target.placeCode, target.place || target.placeCode);
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

/** Point the app at an existing list code. Returns false if the server doesn't
 *  recognise it, and throws only if the server is unreachable. */
async function adoptCode(trimmed) {
  const res = await fetch(`${API_BASE}/api/flights?listCode=${encodeURIComponent(trimmed)}`);
  if (!res.ok) return false;
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
  return true;
}

document.getElementById("switch-code").addEventListener("click", async () => {
  const code = window.prompt("Enter the list code to switch to:");
  if (!code) return;
  const trimmed = code.trim();
  try {
    if (!(await adoptCode(trimmed))) {
      window.alert("That code isn't recognised — check it and try again.");
    }
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
  const flightEl = e.target.closest("[data-flight],[data-job]");
  if (flightEl && main.contains(flightEl)) {
    openDetailById(jobIdFromEl(flightEl));
  }
});

// The hero is a section rather than a button (it contains its own leave-by
// button), so it needs keyboard activation wired up by hand.
main.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const hero = e.target.closest(".hero[data-flight],.hero[data-job],.hero[data-job]");
  if (!hero) return;
  e.preventDefault();
  openDetailById(jobIdFromEl(hero));
});

document.getElementById("detail-back").addEventListener("click", () => {
  detailKey = null;
  closeSheet("detail-sheet");
});

document.getElementById("detail-delete").addEventListener("click", async () => {
  if (!detailKey) return;
  const entry = entries.find((x) => jobIdOf(x.flight) === detailKey);
  if (!entry) return;
  const job = entry.flight;
  const label = job.flightNumber || job.place || entryLabel(entry);
  const who = job.passenger ? ` (${job.passenger})` : "";
  if (!window.confirm(`Stop tracking ${label}${who}? You'll stop getting its alerts.`)) return;

  try {
    const res = await fetch(`${API_BASE}/api/flights`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listCode, id: jobIdOf(job), flightNumber: job.flightNumber, date: job.date }),
    });
    if (!res.ok) { window.alert("Couldn't stop tracking that job. Try again."); return; }
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

/**
 * First run, with no code stored. Registering one silently is what filled the
 * namespace with orphan lists: a new browser, a private window or cleared site
 * data all look exactly like a new user, so the app quietly minted a fresh
 * empty list while the real one stayed on the server, unreachable. The code is
 * the only way back and there is no recovery, so creating a list is now a
 * deliberate act with the recovery path sitting right next to it.
 */
function renderWelcome() {
  main.innerHTML = `
    <div class="welcome">
      <span class="eyebrow">FIRST RUN</span>
      <h2>Do you already have a list code?</h2>
      <p class="welcome-note">Your code is the only way back to your jobs. If you have one
      from another device, enter it here &mdash; starting a new list will not find it.</p>
      <div class="field">
        <label for="w-code">LIST CODE</label>
        <input class="input" id="w-code" placeholder="3226928c" autocomplete="off"
               autocapitalize="off" spellcheck="false" />
      </div>
      <p class="field-error" id="w-error"></p>
      <button class="submit" id="w-use" type="button">USE THIS CODE</button>
      <button class="mini-btn welcome-new" id="w-new" type="button">START A NEW LIST</button>
    </div>`;

  const errorEl = document.getElementById("w-error");
  const input = document.getElementById("w-code");

  document.getElementById("w-use").addEventListener("click", async () => {
    const trimmed = input.value.trim();
    if (!trimmed) { errorEl.textContent = "Enter a code, or start a new list."; return; }
    errorEl.textContent = "";
    try {
      if (await adoptCode(trimmed)) return;
      errorEl.textContent = "That code isn't recognised — check it and try again.";
    } catch (err) {
      console.error(err);
      errorEl.textContent = "Couldn't reach the server. Try again.";
    }
  });

  document.getElementById("w-new").addEventListener("click", async () => {
    errorEl.textContent = "";
    if (!(await ensureList())) {
      errorEl.textContent = "Couldn't set up a list. Check your connection and try again.";
      return;
    }
    await loadFlights();
    syncSettingsSheet();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("w-use").click();
  });
}

(async function init() {
  app.dataset.density = density;
  applyDensity(density);
  setThemeMode(themeMode);
  tickClock();

  if (!listCode) {
    renderWelcome();
    return;
  }
  await loadFlights();
})();

setInterval(tickClock, 1000);
setInterval(tickCountdowns, 30000);
