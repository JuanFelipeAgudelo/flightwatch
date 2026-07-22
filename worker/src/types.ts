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
  departure: {
    airport: string;
    scheduledTime: string | null;
    estimatedTime: string | null;
    terminal: string | null;
    gate: string | null;
  };
  arrival: {
    airport: string;
    scheduledTime: string | null;
    estimatedTime: string | null;
    terminal: string | null;
    gate: string | null;
  };
  fetchedAt: string;
}

export function flightKey(flight: TrackedFlight): string {
  return `flight:${flight.flightNumber}:${flight.date}`;
}
