export interface Env {
  FLIGHT_DATA: KVNamespace;
  AERODATABOX_KEY: string;
}

export interface TrackedFlight {
  flightNumber: string; // e.g. "QF12"
  date: string; // YYYY-MM-DD, local departure date
  // Pickup metadata. Lives on the list record, never on the shared flight record,
  // so passenger details can't leak between list codes tracking the same flight.
  passenger?: string | null;
  pax?: number | null;
  dropOff?: string | null;
  note?: string | null;
}

// Feeds the "leave by" computation and the list-wide display choices. Density and
// theme are deliberately NOT here — those are per-device (a dispatcher's tablet and
// a driver's phone can share a list code and want different views).
export interface ListSettings {
  driveMinutes: Record<string, number>; // arrival IATA -> minutes, e.g. { MCO: 25 }
  bufferMinutes: number;
  showPassengerNames: boolean;
}

export const DEFAULT_SETTINGS: ListSettings = {
  driveMinutes: {},
  bufferMinutes: 10,
  showPassengerNames: true,
};

// One private per-person list, keyed by an opaque list code the client holds
// in localStorage.
export interface ListData {
  flights: TrackedFlight[];
  settings?: ListSettings;
}

export interface FlightStatus {
  flightNumber: string;
  date: string;
  status: string; // e.g. "Scheduled", "Delayed", "Cancelled", "Landed"
  airline: string | null; // e.g. "JetBlue Airways"
  departure: {
    airport: string;
    airportCode: string | null; // IATA, e.g. "HPN"
    timeZone: string | null; // IANA, e.g. "America/New_York"
    scheduledTime: string | null;
    estimatedTime: string | null;
    scheduledTimeUtc: string | null; // ISO instant, for real time-math (countdowns etc.)
    estimatedTimeUtc: string | null;
    terminal: string | null;
    gate: string | null;
  };
  arrival: {
    airport: string;
    airportCode: string | null;
    timeZone: string | null;
    scheduledTime: string | null;
    estimatedTime: string | null;
    scheduledTimeUtc: string | null;
    estimatedTimeUtc: string | null;
    terminal: string | null;
    gate: string | null;
  };
  fetchedAt: string;
}

export function flightKey(flight: TrackedFlight): string {
  return `flight:${flight.flightNumber}:${flight.date}`;
}

// Reverse index: which list codes are currently tracking this flight, so cron
// can route notifications without scanning every list on every poll.
export function trackersKey(flight: TrackedFlight): string {
  return `${flightKey(flight)}:trackers`;
}

// The change lines cron already computes for ntfy, kept instead of discarded so
// the flight detail screen can show what moved and when.
export function historyKey(flight: TrackedFlight): string {
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
