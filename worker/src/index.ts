import { diffFlightStatus, fetchFlightStatus } from "./aerodatabox";
import { sendNtfyNotification } from "./ntfy";
import {
  ALL_TRACKED_KEY,
  DEFAULT_SETTINGS,
  Env,
  FlightStatus,
  HISTORY_LIMIT,
  HistoryEntry,
  ListData,
  ListSettings,
  RECENT_CHANGE_WINDOW_MS,
  TrackedFlight,
  flightKey,
  historyKey,
  listKey,
  ntfyTopicFor,
  trackersKey,
} from "./types";

function sameFlight(a: TrackedFlight, b: TrackedFlight): boolean {
  return a.flightNumber === b.flightNumber && a.date === b.date;
}

type PickupFields = Pick<TrackedFlight, "passenger" | "pax" | "dropOff" | "note">;

// Only copies keys the caller actually sent, so a PATCH that omits `note` leaves
// the stored note alone instead of blanking it.
function pickupFieldsFrom(body: Partial<TrackedFlight>): Partial<PickupFields> {
  const out: Partial<PickupFields> = {};
  if ("passenger" in body) out.passenger = body.passenger ?? null;
  if ("pax" in body) out.pax = body.pax ?? null;
  if ("dropOff" in body) out.dropOff = body.dropOff ?? null;
  if ("note" in body) out.note = body.note ?? null;
  return out;
}

// Drops keys whose value is null, for the paths where "not supplied" must not
// mean "clear it".
function definedOnly(fields: Partial<PickupFields>): Partial<PickupFields> {
  const out: Partial<PickupFields> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function getJSON<T>(env: Env, key: string, fallback: T): Promise<T> {
  const raw = await env.FLIGHT_DATA.get(key);
  return raw ? (JSON.parse(raw) as T) : fallback;
}

async function putJSON(env: Env, key: string, value: unknown): Promise<void> {
  await env.FLIGHT_DATA.put(key, JSON.stringify(value));
}

async function getList(env: Env, code: string): Promise<ListData | null> {
  return getJSON<ListData | null>(env, listKey(code), null);
}

async function saveList(env: Env, code: string, data: ListData): Promise<void> {
  return putJSON(env, listKey(code), data);
}

async function getAllTracked(env: Env): Promise<TrackedFlight[]> {
  return getJSON<TrackedFlight[]>(env, ALL_TRACKED_KEY, []);
}

async function saveAllTracked(env: Env, flights: TrackedFlight[]): Promise<void> {
  return putJSON(env, ALL_TRACKED_KEY, flights);
}

async function getTrackers(env: Env, flight: TrackedFlight): Promise<string[]> {
  return getJSON<string[]>(env, trackersKey(flight), []);
}

async function saveTrackers(env: Env, flight: TrackedFlight, codes: string[]): Promise<void> {
  const key = trackersKey(flight);
  if (codes.length === 0) {
    await env.FLIGHT_DATA.delete(key);
  } else {
    await putJSON(env, key, codes);
  }
}

async function addToAllTracked(env: Env, flight: TrackedFlight): Promise<void> {
  const all = await getAllTracked(env);
  if (!all.some((f) => sameFlight(f, flight))) {
    all.push(flight);
    await saveAllTracked(env, all);
  }
}

async function removeFromAllTracked(env: Env, flight: TrackedFlight): Promise<void> {
  const all = await getAllTracked(env);
  const remaining = all.filter((f) => !sameFlight(f, flight));
  if (remaining.length !== all.length) {
    await saveAllTracked(env, remaining);
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
  await removeFromAllTracked(env, flight);
  await env.FLIGHT_DATA.delete(flightKey(flight));
  await env.FLIGHT_DATA.delete(historyKey(flight));
}

// A landed/arrived flight's status won't change again, so keep polling for a
// grace window (in case of a late correction) and then stop for good — this is
// the single biggest lever on AeroDataBox quota, since nothing previously ever
// stopped cron from polling a flight that landed weeks ago.
const LANDED_POLL_GRACE_MS = 2 * 60 * 60 * 1000; // 2 hours past arrival

function isLanded(status: FlightStatus): boolean {
  return /landed|arrived/i.test(status.status);
}

async function stopPollingIfLongLanded(env: Env, flight: TrackedFlight, status: FlightStatus): Promise<void> {
  if (!isLanded(status)) return;
  const arrivalUtc = status.arrival.estimatedTimeUtc ?? status.arrival.scheduledTimeUtc;
  if (!arrivalUtc) return;
  if (Date.now() - new Date(arrivalUtc).getTime() > LANDED_POLL_GRACE_MS) {
    await removeFromAllTracked(env, flight);
  }
}

async function getHistory(env: Env, flight: TrackedFlight): Promise<HistoryEntry[]> {
  return getJSON<HistoryEntry[]>(env, historyKey(flight), []);
}

async function appendHistory(env: Env, flight: TrackedFlight, changes: string[]): Promise<void> {
  const history = await getHistory(env, flight);
  history.unshift({ at: new Date().toISOString(), changes });
  await putJSON(env, historyKey(flight), history.slice(0, HISTORY_LIMIT));
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
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
      let listCode = randomHex(4);
      while (await getList(env, listCode)) {
        listCode = randomHex(4); // extremely unlikely, but don't silently clobber an existing list
      }
      await saveList(env, listCode, { flights: [] });
      return json({ listCode, ntfyTopic: ntfyTopicFor(listCode) });
    }

    // GET /api/flights?listCode=xxx — this list's tracked flights + last known status
    if (request.method === "GET" && url.pathname === "/api/flights") {
      const listCode = url.searchParams.get("listCode");
      if (!listCode) return json({ error: "listCode is required" }, 400);

      const list = await getList(env, listCode);
      if (!list) return json({ error: "Unknown listCode" }, 404);

      // Recent changes come from the stored history rather than a client-side
      // diff, so a driver who closed the app still sees what moved while it
      // was shut.
      const since = Date.now() - RECENT_CHANGE_WINDOW_MS;
      const entries = await Promise.all(
        list.flights.map(async (f) => {
          const [raw, history] = await Promise.all([
            env.FLIGHT_DATA.get(flightKey(f)),
            getHistory(env, f),
          ]);
          return {
            flight: f,
            status: raw ? (JSON.parse(raw) as FlightStatus) : null,
            recentChanges: history.filter((h) => new Date(h.at).getTime() >= since),
          };
        })
      );
      return json({
        ntfyTopic: ntfyTopicFor(listCode),
        settings: { ...DEFAULT_SETTINGS, ...(list.settings ?? {}) },
        entries,
      });
    }

    // POST /api/flights — add a flight to a list: { listCode, flightNumber, date }
    if (request.method === "POST" && url.pathname === "/api/flights") {
      const body = (await request.json()) as TrackedFlight & { listCode?: string };
      if (!body.listCode || !body.flightNumber || !body.date) {
        return json({ error: "listCode, flightNumber and date are required" }, 400);
      }

      const list = await getList(env, body.listCode);
      if (!list) return json({ error: "Unknown listCode" }, 404);

      const flight: TrackedFlight = {
        flightNumber: body.flightNumber,
        date: body.date,
        ...pickupFieldsFrom(body),
      };
      const existing = list.flights.find((f) => sameFlight(f, flight));
      if (existing) {
        // Re-adding fills in details rather than duplicating — but only ones
        // actually supplied. Clearing a field is PATCH's job; a re-add that
        // happens to leave the optional inputs blank must not wipe what's there.
        Object.assign(existing, definedOnly(pickupFieldsFrom(body)));
      } else {
        list.flights.push(flight);
      }
      await saveList(env, body.listCode, list);

      await addToAllTracked(env, flight);
      const trackers = await getTrackers(env, flight);
      if (!trackers.includes(body.listCode)) {
        trackers.push(body.listCode);
        await saveTrackers(env, flight, trackers);
      }

      // Fetch immediately so the UI has something to show without waiting for the next cron
      // tick. The flight is already tracked at this point regardless of how this goes, so a
      // failure here (rate limit, AeroDataBox outage) shouldn't fail the whole request — cron
      // will pick up a real status once the lookup starts working again.
      let status: FlightStatus | null = null;
      try {
        status = await fetchFlightStatus(env.AERODATABOX_KEY, flight);
        if (status) {
          await env.FLIGHT_DATA.put(flightKey(flight), JSON.stringify(status));
        }
      } catch (err) {
        console.error(`Immediate status fetch failed for ${flight.flightNumber} (${flight.date}):`, err);
      }

      return json({ flight, status });
    }

    // GET /api/history?listCode=&flightNumber=&date= — what has moved on this flight
    if (request.method === "GET" && url.pathname === "/api/history") {
      const listCode = url.searchParams.get("listCode");
      const flightNumber = url.searchParams.get("flightNumber");
      const date = url.searchParams.get("date");
      if (!listCode || !flightNumber || !date) {
        return json({ error: "listCode, flightNumber and date are required" }, 400);
      }

      // Only serve history for a flight the caller's own list is tracking.
      const list = await getList(env, listCode);
      if (!list) return json({ error: "Unknown listCode" }, 404);
      const flight: TrackedFlight = { flightNumber, date };
      if (!list.flights.some((f) => sameFlight(f, flight))) {
        return json({ error: "Flight is not on this list" }, 404);
      }

      return json({ history: await getHistory(env, flight) });
    }

    // PATCH /api/flights — edit pickup details without re-adding the flight
    if (request.method === "PATCH" && url.pathname === "/api/flights") {
      const body = (await request.json()) as TrackedFlight & { listCode?: string };
      if (!body.listCode || !body.flightNumber || !body.date) {
        return json({ error: "listCode, flightNumber and date are required" }, 400);
      }

      const list = await getList(env, body.listCode);
      if (!list) return json({ error: "Unknown listCode" }, 404);

      const entry = list.flights.find((f) =>
        sameFlight(f, { flightNumber: body.flightNumber, date: body.date })
      );
      if (!entry) return json({ error: "Flight is not on this list" }, 404);

      Object.assign(entry, pickupFieldsFrom(body));
      await saveList(env, body.listCode, list);
      return json({ flight: entry });
    }

    // PUT /api/settings — write this list's drive times, buffer and display prefs
    if (request.method === "PUT" && url.pathname === "/api/settings") {
      const body = (await request.json()) as Partial<ListSettings> & { listCode?: string };
      if (!body.listCode) return json({ error: "listCode is required" }, 400);

      const list = await getList(env, body.listCode);
      if (!list) return json({ error: "Unknown listCode" }, 404);

      const current = { ...DEFAULT_SETTINGS, ...(list.settings ?? {}) };
      const settings: ListSettings = {
        driveMinutes: body.driveMinutes ?? current.driveMinutes,
        bufferMinutes: body.bufferMinutes ?? current.bufferMinutes,
        showPassengerNames: body.showPassengerNames ?? current.showPassengerNames,
      };

      list.settings = settings;
      await saveList(env, body.listCode, list);
      return json({ settings });
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

    // Independent per-flight, so poll and notify for all of them concurrently
    // instead of paying each flight's KV + AeroDataBox round-trip in sequence.
    await Promise.all(
      tracked.map(async (flight) => {
        try {
          const key = flightKey(flight);
          const prevRaw = await env.FLIGHT_DATA.get(key);
          const prev: FlightStatus | null = prevRaw ? JSON.parse(prevRaw) : null;

          const next = await fetchFlightStatus(env.AERODATABOX_KEY, flight);
          if (!next) return;

          const changes = diffFlightStatus(prev, next);
          await env.FLIGHT_DATA.put(key, JSON.stringify(next));

          if (changes.length > 0) {
            await appendHistory(env, flight, changes);
            const trackerCodes = await getTrackers(env, flight);

            // Each list gets its own push, titled with that list's own passenger
            // name when it has one — the name is what tells a driver whose job
            // just moved. Topics derive from the list code, so no lookup is
            // needed to address them; the list read is only to personalise, and
            // only happens on an actual change.
            await Promise.all(
              trackerCodes.map(async (code) => {
                let title = `${flight.flightNumber} — ${next.status}`;
                try {
                  const list = await getList(env, code);
                  const entry = list && list.flights.find((f) => sameFlight(f, flight));
                  if (entry && entry.passenger) {
                    title = `${entry.passenger} · ${title}`;
                  }
                } catch (err) {
                  console.error(`Couldn't personalise notification for ${code}:`, err);
                }
                return sendNtfyNotification(ntfyTopicFor(code), title, changes.join("\n"));
              })
            );
          }

          await stopPollingIfLongLanded(env, flight, next);
        } catch (err) {
          console.error(`Failed to poll ${flight.flightNumber} (${flight.date}):`, err);
        }
      })
    );
  },
};
