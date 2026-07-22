import type { FlightStatus, TrackedFlight } from "./types";

const API_HOST = "aerodatabox.p.rapidapi.com";

// AeroDataBox response shape is trimmed to the fields we actually use.
interface AeroDataBoxFlight {
  number: string;
  status: string;
  departure: {
    airport: { name: string };
    scheduledTime?: { local: string };
    revisedTime?: { local: string };
    terminal?: string;
    gate?: string;
  };
  arrival: {
    airport: { name: string };
    scheduledTime?: { local: string };
    revisedTime?: { local: string };
    terminal?: string;
    gate?: string;
  };
}

export async function fetchFlightStatus(
  apiKey: string,
  flight: TrackedFlight
): Promise<FlightStatus | null> {
  const url = `https://${API_HOST}/flights/number/${encodeURIComponent(
    flight.flightNumber
  )}/${flight.date}`;

  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": apiKey,
      "X-RapidAPI-Host": API_HOST,
    },
  });

  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`AeroDataBox request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as AeroDataBoxFlight[];
  if (!data.length) return null;

  const f = data[0];
  return {
    flightNumber: flight.flightNumber,
    date: flight.date,
    status: f.status,
    departure: {
      airport: f.departure.airport.name,
      scheduledTime: f.departure.scheduledTime?.local ?? null,
      estimatedTime: f.departure.revisedTime?.local ?? null,
      terminal: f.departure.terminal ?? null,
      gate: f.departure.gate ?? null,
    },
    arrival: {
      airport: f.arrival.airport.name,
      scheduledTime: f.arrival.scheduledTime?.local ?? null,
      estimatedTime: f.arrival.revisedTime?.local ?? null,
      terminal: f.arrival.terminal ?? null,
      gate: f.arrival.gate ?? null,
    },
    fetchedAt: new Date().toISOString(),
  };
}

/** Compares two statuses and returns a list of plain-language change lines, or [] if nothing changed. */
export function diffFlightStatus(
  prev: FlightStatus | null,
  next: FlightStatus
): string[] {
  if (!prev) return [];

  const changes: string[] = [];

  if (prev.status !== next.status) {
    changes.push(`Status changed: ${prev.status} → ${next.status}`);
  }

  for (const side of ["departure", "arrival"] as const) {
    const label = side === "departure" ? "Departure" : "Arrival";
    const p = prev[side];
    const n = next[side];

    if (p.estimatedTime !== n.estimatedTime && n.estimatedTime) {
      changes.push(`${label} time changed: ${p.estimatedTime ?? p.scheduledTime} → ${n.estimatedTime}`);
    }
    if (p.gate !== n.gate) {
      changes.push(`${label} gate changed: ${p.gate ?? "unknown"} → ${n.gate ?? "unknown"}`);
    }
    if (p.terminal !== n.terminal) {
      changes.push(`${label} terminal changed: ${p.terminal ?? "unknown"} → ${n.terminal ?? "unknown"}`);
    }
  }

  return changes;
}
