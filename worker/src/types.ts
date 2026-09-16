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
