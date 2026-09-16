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
  // When cron should next spend an AeroDataBox unit on this flight. Absent means
  // "due now" — a flight that somehow missed a schedule computation must cost a
  // unit, never go silently unpolled.
  nextPollAt?: string | null; // ISO instant
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
): string | null {
  const event = nextLegInstant(status, now);
  if (event === null) return new Date(now + 60 * 60 * 1000).toISOString();

  const until = event - now;

  // Past the event: one belt-confirmation poll, then stop scheduling. The
  // existing landed-grace logic removes it from the poll set entirely.
  if (until <= 0) {
    return -until < POST_EVENT_POLL_MS
      ? new Date(event + POST_EVENT_POLL_MS).toISOString()
      : null;
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
export interface ListSettings {
  driveMinutes: Record<string, number>; // place code -> minutes, e.g. { JFK: 75 }
  bufferMinutes: number;
  // Departures only: how early the passenger must be at the terminal. Arrival
  // pickups count back from touchdown; departures count back from that, minus
  // this. It is the term that makes the two directions different formulas.
  checkInLeadMinutes: number;
  showPassengerNames: boolean;
}

export const DEFAULT_SETTINGS: ListSettings = {
  driveMinutes: {},
  bufferMinutes: 10,
  checkInLeadMinutes: 120,
  showPassengerNames: true,
};

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
