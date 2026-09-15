import { diffFlightStatus, fetchFlightStatus } from "./aerodatabox";
import { sendNtfyNotification } from "./ntfy";
import {
  ALL_TRACKED_KEY,
  Env,
  FlightStatus,
  ListData,
  TrackedFlight,
  flightKey,
  listKey,
  trackersKey,
} from "./types";

function sameFlight(a: TrackedFlight, b: TrackedFlight): boolean {
  return a.flightNumber === b.flightNumber && a.date === b.date;
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function getList(env: Env, code: string): Promise<ListData | null> {
  const raw = await env.FLIGHT_DATA.get(listKey(code));
  return raw ? (JSON.parse(raw) as ListData) : null;
}

async function saveList(env: Env, code: string, data: ListData): Promise<void> {
  await env.FLIGHT_DATA.put(listKey(code), JSON.stringify(data));
}

async function getAllTracked(env: Env): Promise<TrackedFlight[]> {
  const raw = await env.FLIGHT_DATA.get(ALL_TRACKED_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function saveAllTracked(env: Env, flights: TrackedFlight[]): Promise<void> {
  await env.FLIGHT_DATA.put(ALL_TRACKED_KEY, JSON.stringify(flights));
}

async function getTrackers(env: Env, flight: TrackedFlight): Promise<string[]> {
  const raw = await env.FLIGHT_DATA.get(trackersKey(flight));
  return raw ? JSON.parse(raw) : [];
}

async function saveTrackers(env: Env, flight: TrackedFlight, codes: string[]): Promise<void> {
  const key = trackersKey(flight);
  if (codes.length === 0) {
    await env.FLIGHT_DATA.delete(key);
  } else {
    await env.FLIGHT_DATA.put(key, JSON.stringify(codes));
  }
}

async function addToAllTracked(env: Env, flight: TrackedFlight): Promise<void> {
  const all = await getAllTracked(env);
  if (!all.some((f) => sameFlight(f, flight))) {
    all.push(flight);
    await saveAllTracked(env, all);
  }
}

// Drops a flight from the global poll set once nobody's list references it anymore,
// so cron stops burning AeroDataBox quota on abandoned flights. Takes the caller's
// already-fetched remaining trackers list rather than re-reading the same KV key.
async function removeFromAllTrackedIfOrphaned(
  env: Env,
  flight: TrackedFlight,
  remainingTrackers: string[]
): Promise<void> {
  if (remainingTrackers.length > 0) return;
  const all = await getAllTracked(env);
  const remaining = all.filter((f) => !sameFlight(f, flight));
  if (remaining.length !== all.length) {
    await saveAllTracked(env, remaining);
  }
  await env.FLIGHT_DATA.delete(flightKey(flight));
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

    // POST /api/register — first-visit call: creates a private list + its own ntfy topic
    if (request.method === "POST" && url.pathname === "/api/register") {
      const listCode = randomHex(4);
      const ntfyTopic = `flightwatch-${randomHex(5)}`;
      await saveList(env, listCode, { ntfyTopic, flights: [] });
      return json({ listCode, ntfyTopic });
    }

    // GET /api/flights?listCode=xxx — this list's tracked flights + last known status
    if (request.method === "GET" && url.pathname === "/api/flights") {
      const listCode = url.searchParams.get("listCode");
      if (!listCode) return json({ error: "listCode is required" }, 400);

      const list = await getList(env, listCode);
      if (!list) return json({ error: "Unknown listCode" }, 404);

      const entries = await Promise.all(
        list.flights.map(async (f) => {
          const raw = await env.FLIGHT_DATA.get(flightKey(f));
          return { flight: f, status: raw ? (JSON.parse(raw) as FlightStatus) : null };
        })
      );
      return json({ ntfyTopic: list.ntfyTopic, entries });
    }

    // POST /api/flights — add a flight to a list: { listCode, flightNumber, date }
    if (request.method === "POST" && url.pathname === "/api/flights") {
      const body = (await request.json()) as TrackedFlight & { listCode?: string };
      if (!body.listCode || !body.flightNumber || !body.date) {
        return json({ error: "listCode, flightNumber and date are required" }, 400);
      }

      const list = await getList(env, body.listCode);
      if (!list) return json({ error: "Unknown listCode" }, 404);

      const flight: TrackedFlight = { flightNumber: body.flightNumber, date: body.date };
      if (!list.flights.some((f) => sameFlight(f, flight))) {
        list.flights.push(flight);
        await saveList(env, body.listCode, list);
      }

      await addToAllTracked(env, flight);
      const trackers = await getTrackers(env, flight);
      if (!trackers.includes(body.listCode)) {
        trackers.push(body.listCode);
        await saveTrackers(env, flight, trackers);
      }

      // Fetch immediately so the UI has something to show without waiting for the next cron tick.
      const status = await fetchFlightStatus(env.AERODATABOX_KEY, flight);
      if (status) {
        await env.FLIGHT_DATA.put(flightKey(flight), JSON.stringify(status));
      }

      return json({ flight, status });
    }

    // DELETE /api/flights — stop tracking: { listCode, flightNumber, date }
    if (request.method === "DELETE" && url.pathname === "/api/flights") {
      const body = (await request.json()) as TrackedFlight & { listCode?: string };
      if (!body.listCode || !body.flightNumber || !body.date) {
        return json({ error: "listCode, flightNumber and date are required" }, 400);
      }

      const list = await getList(env, body.listCode);
      if (!list) return json({ error: "Unknown listCode" }, 404);

      const flight: TrackedFlight = { flightNumber: body.flightNumber, date: body.date };
      list.flights = list.flights.filter((f) => !sameFlight(f, flight));
      await saveList(env, body.listCode, list);

      const trackers = (await getTrackers(env, flight)).filter((c) => c !== body.listCode);
      await saveTrackers(env, flight, trackers);
      await removeFromAllTrackedIfOrphaned(env, flight, trackers);

      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const tracked = await getAllTracked(env);

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
          const trackerCodes = await getTrackers(env, flight);
          // Multiple list codes can share (or independently land on) the same topic —
          // dedupe so people don't get the same push twice.
          const topics = new Set<string>();
          for (const code of trackerCodes) {
            const list = await getList(env, code);
            if (list?.ntfyTopic) topics.add(list.ntfyTopic);
          }

          await Promise.all(
            Array.from(topics).map((topic) =>
              sendNtfyNotification(topic, `${flight.flightNumber} — ${next.status}`, changes.join("\n"))
            )
          );
        }
      } catch (err) {
        console.error(`Failed to poll ${flight.flightNumber} (${flight.date}):`, err);
      }
    }
  },
};
