export interface Env {
  FLIGHT_DATA: KVNamespace;
  AERODATABOX_KEY: string;
}

// What supplies a job's target time — the moment leave-by counts back from.
//   arrival     a flight lands and the passenger is collected  (live, moves)
//   departure   the passenger is dropped off for a flight      (live, moves)
//   appointment a fixed time at a place: medical, consulate    (fixed)
//   shift       a standby/work block with a start time         (fixed)
// Absent means "arrival": every row written before Phase 1 was an airport pickup.
export type JobKind = "arrival" | "departure" | "appointment" | "shift";

export const FLIGHT_KINDS: JobKind[] = ["arrival", "departure"];

export interface Job {
  kind?: JobKind;

  // Identity. Flights derive theirs from flightNumber:date, so rows written
  // before Phase 1 need no migration; everything else carries an explicit id.
  id?: string;

  // Flight kinds only. These also key the SHARED status/trackers/history records.
  flightNumber?: string;
  date?: string; // YYYY-MM-DD

  // Non-flight kinds only. Wall-clock local to `place`, never timezone-converted,
  // matching how AeroDataBox local times are treated everywhere else.
  targetTime?: string | null; // "YYYY-MM-DD HH:MM"
  endTime?: string | null; // appointment duration / shift end
  place?: string | null; // "NYP Allen Hospital"
  placeCode?: string | null; // drive-time key, e.g. "WRK", "NYP"

  // Where the driver starts this job: the three-letter site of the parking
  // space the vehicle is assigned to. The list-wide driveMinutes table is keyed
  // by destination alone, which only works from a single origin — but the start
  // really varies (in the owner's own assignments, 107 from Warwick and 37 from
  // Fishkill), and Warwick→EWR is 75 minutes where Fishkill→EWR is 90. So a job
  // may carry its own drive time, and it wins over the table when present.
  originCode?: string | null;
  driveMinutes?: number | null;

  // Pickup metadata. Lives on the list record, never on the shared flight record,
  // so passenger details can't leak between list codes tracking the same flight.
  passenger?: string | null;
  pax?: number | null;
  dropOff?: string | null;
  note?: string | null;
}

/** Legacy alias — every pre-Phase-1 row is a Job of kind "arrival". */
export type TrackedFlight = Job;

export function kindOf(job: Job): JobKind {
  return job.kind ?? "arrival";
}

/** A job that genuinely identifies a flight. Everything that touches the shared
 *  status / trackers / history records requires this, not a bare Job. */
export interface FlightRef {
  flightNumber: string;
  date: string;
}

// How long before the next leg event a poll is worth spending a unit on. The
// assignment email already gives a usable scheduled time, so a poll only earns
// its keep when the answer could still change what the driver does:
//   6h  replan the day
//   3h  inbound aircraft is positioning; delays become real
//   2h  the decision window — last point that changes whether you leave
//  45m  gate, terminal and belt firm up while you're driving
//  15m  final position before you're standing in the hall
const POLL_OFFSETS_MS = [6, 3, 2, 0.75, 0.25].map((h) => h * 3600 * 1000);

// One more poll after the event, which is the only time a baggage belt is
// knowable. Arrivals need it; nothing else does.
const POST_EVENT_POLL_MS = 15 * 60 * 1000;

/** Explicit "nothing more to learn about this flight" marker. Distinct from an
 *  absent schedule, which means due — conflating them polls every landed
 *  flight on every tick. */
export const DONE_POLLING = "done";

/** The next leg event worth anchoring a schedule to: the departure while the
 *  flight is still on the ground, the arrival once it is airborne. Kind-free on
 *  purpose — one flight can be someone's departure and someone else's arrival. */
export function nextLegInstant(status: FlightStatus, now: number): number | null {
  const times = [
    status.departure.estimatedTimeUtc || status.departure.scheduledTimeUtc,
    status.arrival.estimatedTimeUtc || status.arrival.scheduledTimeUtc,
  ]
    .filter(Boolean)
    .map((t) => new Date(t as string).getTime())
    .filter((t) => !Number.isNaN(t));
  if (!times.length) return null;
  const upcoming = times.filter((t) => t > now);
  return upcoming.length ? Math.min(...upcoming) : Math.max(...times);
}

/**
 * When to next poll this flight. `unsettled` tightens the cadence because a
 * flight that just moved is likely to move again — that is where the units
 * genuinely buy something.
 */
export function computeNextPollAt(
  status: FlightStatus,
  now: number,
  unsettled: boolean
): string {
  const event = nextLegInstant(status, now);
  if (event === null) return new Date(now + 60 * 60 * 1000).toISOString();

  const until = event - now;

  // Past the event: one belt-confirmation poll, then stop scheduling. The
  // existing landed-grace logic removes it from the poll set entirely.
  if (until <= 0) {
    return -until < POST_EVENT_POLL_MS
      ? new Date(event + POST_EVENT_POLL_MS).toISOString()
      : DONE_POLLING;
  }

  if (unsettled) {
    // Don't let escalation push a poll past the next scheduled one.
    const soon = Math.min(now + 30 * 60 * 1000, event);
    return new Date(soon).toISOString();
  }

  // Sleep until the next offset that is still ahead of us. Beyond the widest
  // offset that means a long sleep, which is the whole point: a flight a day
  // out tells us nothing we can act on, and dispatch re-sends if it moves.
  const next = POLL_OFFSETS_MS.find((offset) => offset < until);
  return new Date(next === undefined ? event : event - next).toISOString();
}

// A type guard rather than a boolean, so a call site that checks it can then use
// flightNumber and date without re-asserting they exist.
export function isFlightJob(job: Job): job is Job & FlightRef {
  return FLIGHT_KINDS.includes(kindOf(job)) && !!job.flightNumber && !!job.date;
}

export function jobId(job: Job): string {
  return job.id ?? `${job.flightNumber}:${job.date}`;
}

// Feeds the "leave by" computation and the list-wide display choices. Density and
// theme are deliberately NOT here — those are per-device (a dispatcher's tablet and
// a driver's phone can share a list code and want different views).
// Defaults follow the department's own written guidelines rather than being
// invented here — see docs/spec-assignments.md for the quoted rules.
export interface ListSettings {
  driveMinutes: Record<string, number>; // place code -> minutes, e.g. { JFK: 75 }
  // "Drivers should arrive at the airport approximately 15 minutes before the
  // arrival time of the flight" — dept guidelines. This is that margin, and it
  // doubles as the general pad for non-flight jobs.
  bufferMinutes: number;
  // Departures only: how early the passenger must be at the terminal. TSA
  // PreCheck guidance as cited by the department — 1.5h domestic, 2h
  // international. Arrival pickups count back from touchdown; departures count
  // back from wheels-up minus this, which is what makes them a second formula.
  checkInLeadMinutes: number; // domestic
  checkInLeadIntlMinutes: number;
  showPassengerNames: boolean;
}

// Values the app previously shipped as defaults, before the department's
// manuals were consulted. A list still carrying one of these never chose it —
// it inherited a guess — so it is upgraded to the documented figure on read.
// Anything else is a deliberate choice by the owner and is left alone.
export const SUPERSEDED_DEFAULTS: Partial<Record<keyof ListSettings, number>> = {
  bufferMinutes: 10,
  checkInLeadMinutes: 120,
};

/** Fills in defaults, and replaces values that were only ever an old default. */
export function resolveSettings(stored?: ListSettings): ListSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  for (const [key, superseded] of Object.entries(SUPERSEDED_DEFAULTS)) {
    const k = key as keyof ListSettings;
    if (merged[k] === superseded) {
      (merged as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
    }
  }
  return merged;
}

export const DEFAULT_SETTINGS: ListSettings = {
  driveMinutes: {},
  bufferMinutes: 15,
  checkInLeadMinutes: 90,
  checkInLeadIntlMinutes: 120,
  showPassengerNames: true,
};

// How long the driver waits airside after touchdown before the passenger is
// actually in the car: "For Domestic arrivals add 45 minutes for the return
// time to account for waiting for luggage. For International arrivals add one
// hour to account for baggage claim and customs."
export const DEPLANE_DOMESTIC_MINUTES = 45;
export const DEPLANE_INTL_MINUTES = 60;

// One private per-person list, keyed by an opaque list code the client holds
// in localStorage.
export interface ListData {
  flights: TrackedFlight[];
  settings?: ListSettings;
}

export interface FlightLeg {
  airport: string;
  airportCode: string | null; // IATA, e.g. "HPN"
  timeZone: string | null; // IANA, e.g. "America/New_York"
  scheduledTime: string | null;
  estimatedTime: string | null;
  scheduledTimeUtc: string | null; // ISO instant, for real time-math (countdowns etc.)
  estimatedTimeUtc: string | null;
  terminal: string | null;
  gate: string | null;
  // Arriving flights only, and null where the airport doesn't publish it.
  baggageBelt: string | null;
}

export interface FlightStatus {
  flightNumber: string;
  date: string;
  status: string; // e.g. "Scheduled", "Delayed", "Cancelled", "Landed"
  airline: string | null; // e.g. "JetBlue Airways"
  departure: FlightLeg;
  arrival: FlightLeg;
  fetchedAt: string;
}

export function flightKey(flight: FlightRef): string {
  return `flight:${flight.flightNumber}:${flight.date}`;
}

// Reverse index: which list codes are currently tracking this flight, so cron
// can route notifications without scanning every list on every poll.
export function trackersKey(flight: FlightRef): string {
  return `${flightKey(flight)}:trackers`;
}

// The change lines cron already computes for ntfy, kept instead of discarded so
// the flight detail screen can show what moved and when.
export function historyKey(flight: FlightRef): string {
  return `${flightKey(flight)}:history`;
}

/** When cron should next spend a unit on this flight. Deliberately its OWN key
 *  rather than a field on the shared poll set: cron would otherwise rewrite that
 *  whole array on every tick, and with no compare-and-swap in KV a concurrent
 *  add would be silently dropped from polling. Cron now only READS the poll set.
 *  An absent value means due — a flight whose schedule failed to compute must
 *  cost a unit, never go unpolled. */
export function scheduleKey(flight: FlightRef): string {
  return `${flightKey(flight)}:sched`;
}

export interface HistoryEntry {
  at: string; // ISO instant
  changes: string[];
}

export const HISTORY_LIMIT = 20;

// How far back the home screen counts a change as still worth flagging.
export const RECENT_CHANGE_WINDOW_MS = 60 * 60 * 1000;

export function listKey(code: string): string {
  return `list:${code}`;
}

// The list code is already an unguessable secret, so the ntfy topic is derived
// from it directly instead of being a second independently-generated secret.
export function ntfyTopicFor(listCode: string): string {
  return `flightwatch-${listCode}`;
}

// Deduped union of every flight anyone is tracking — the set cron actually polls.
export const ALL_TRACKED_KEY = "all-tracked-flights";
