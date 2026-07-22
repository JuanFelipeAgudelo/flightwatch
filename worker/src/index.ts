import { diffFlightStatus, fetchFlightStatus } from "./aerodatabox";
import { sendNtfyNotification } from "./ntfy";
import { Env, FlightStatus, TrackedFlight, flightKey } from "./types";

const TRACKED_LIST_KEY = "tracked-flights";

async function getTrackedFlights(env: Env): Promise<TrackedFlight[]> {
  const raw = await env.FLIGHT_DATA.get(TRACKED_LIST_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function saveTrackedFlights(env: Env, flights: TrackedFlight[]): Promise<void> {
  await env.FLIGHT_DATA.put(TRACKED_LIST_KEY, JSON.stringify(flights));
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // GET /api/flights — list tracked flights + their last known status
    if (request.method === "GET" && url.pathname === "/api/flights") {
      const tracked = await getTrackedFlights(env);
      const withStatus = await Promise.all(
        tracked.map(async (f) => {
          const raw = await env.FLIGHT_DATA.get(flightKey(f));
          return { flight: f, status: raw ? (JSON.parse(raw) as FlightStatus) : null };
        })
      );
      return json(withStatus);
    }

    // POST /api/flights — add a flight to track: { flightNumber, date }
    if (request.method === "POST" && url.pathname === "/api/flights") {
      const body = (await request.json()) as TrackedFlight;
      if (!body.flightNumber || !body.date) {
        return json({ error: "flightNumber and date are required" }, 400);
      }

      const tracked = await getTrackedFlights(env);
      const exists = tracked.some(
        (f) => f.flightNumber === body.flightNumber && f.date === body.date
      );
      if (!exists) {
        tracked.push({ flightNumber: body.flightNumber, date: body.date });
        await saveTrackedFlights(env, tracked);
      }

      // Fetch immediately so the UI has something to show without waiting for the next cron tick.
      const status = await fetchFlightStatus(env.AERODATABOX_KEY, body);
      if (status) {
        await env.FLIGHT_DATA.put(flightKey(body), JSON.stringify(status));
      }

      return json({ flight: body, status });
    }

    // DELETE /api/flights — stop tracking: { flightNumber, date }
    if (request.method === "DELETE" && url.pathname === "/api/flights") {
      const body = (await request.json()) as TrackedFlight;
      const tracked = await getTrackedFlights(env);
      const remaining = tracked.filter(
        (f) => !(f.flightNumber === body.flightNumber && f.date === body.date)
      );
      await saveTrackedFlights(env, remaining);
      await env.FLIGHT_DATA.delete(flightKey(body));
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const tracked = await getTrackedFlights(env);

    for (const flight of tracked) {
      try {
        const key = flightKey(flight);
        const prevRaw = await env.FLIGHT_DATA.get(key);
        const prev: FlightStatus | null = prevRaw ? JSON.parse(prevRaw) : null;

        const next = await fetchFlightStatus(env.AERODATABOX_KEY, flight);
        if (!next) continue;

        const changes = diffFlightStatus(prev, next);
        await env.FLIGHT_DATA.put(key, JSON.stringify(next));

        if (changes.length > 0) {
          await sendNtfyNotification(
            env.NTFY_TOPIC,
            `${flight.flightNumber} — ${next.status}`,
            changes.join("\n")
          );
        }
      } catch (err) {
        console.error(`Failed to poll ${flight.flightNumber} (${flight.date}):`, err);
      }
    }
  },
};
