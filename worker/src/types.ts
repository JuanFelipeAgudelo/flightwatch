export interface Env {
  FLIGHT_DATA: KVNamespace;
  AERODATABOX_KEY: string;
}

export interface TrackedFlight {
  flightNumber: string; // e.g. "QF12"
  date: string; // YYYY-MM-DD, local departure date
}

// One private per-person list, keyed by an opaque list code the client holds
// in localStorage.
export interface ListData {
  flights: TrackedFlight[];
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
