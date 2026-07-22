export interface Env {
  FLIGHT_DATA: KVNamespace;
  AERODATABOX_KEY: string;
  NTFY_TOPIC: string;
}

export interface TrackedFlight {
  flightNumber: string; // e.g. "QF12"
  date: string; // YYYY-MM-DD, local departure date
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
