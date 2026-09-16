import { diffFlightStatus, fetchFlightStatus } from "./aerodatabox";
import { sendNtfyNotification } from "./ntfy";
import {
  ALL_TRACKED_KEY,
  DEFAULT_SETTINGS,
  DONE_POLLING,
  resolveSettings,
  FLIGHT_KINDS,
  Env,
  FlightStatus,
  HISTORY_LIMIT,
  HistoryEntry,
  ListData,
  Job,
  ListSettings,
  FlightRef,
  RECENT_CHANGE_WINDOW_MS,
  computeNextPollAt,
  flightKey,
  historyKey,
  isFlightJob,
  jobId,
  kindOf,
  listKey,
  ntfyTopicFor,
  trackersKey,
} from "./types";

function sameFlight(a: FlightRef, b: FlightRef): boolean {
  return a.flightNumber === b.flightNumber && a.date === b.date;
}

type PickupFields = Pick<Job, "passenger" | "pax" | "dropOff" | "note">;

// Only copies keys the caller actually sent, so a PATCH that omits `note` leaves
// the stored note alone instead of blanking it.
function pickupFieldsFrom(body: Partial<Job>): Partial<PickupFields> {
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

async function getAllTracked(env: Env): Promise<FlightRef[]> {
  return getJSON<FlightRef[]>(env, ALL_TRACKED_KEY, []);
}

async function saveAllTracked(env: Env, flights: FlightRef[]): Promise<void> {
  return putJSON(env, ALL_TRACKED_KEY, flights);
}

async function getTrackers(env: Env, flight: FlightRef): Promise<string[]> {
  return getJSON<string[]>(env, trackersKey(flight), []);
}

async function saveTrackers(env: Env, flight: FlightRef, codes: string[]): Promise<void> {
  const key = trackersKey(flight);
  if (codes.length === 0) {
    await env.FLIGHT_DATA.delete(key);
  } else {
    await putJSON(env, key, codes);
  }
}

async function addToAllTracked(env: Env, flight: FlightRef): Promise<void> {
  const all = await getAllTracked(env);
  if (!all.some((f) => sameFlight(f, flight))) {
    all.push(flight);
    await saveAllTracked(env, all);
  }
}

async function removeFromAllTracked(env: Env, flight: FlightRef): Promise<void> {
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
  flight: FlightRef,
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

async function stopPollingIfLongLanded(env: Env, flight: FlightRef, status: FlightStatus): Promise<void> {
  if (!isLanded(status)) return;
  const arrivalUtc = status.arrival.estimatedTimeUtc ?? status.arrival.scheduledTimeUtc;
  if (!arrivalUtc) return;
  if (Date.now() - new Date(arrivalUtc).getTime() > LANDED_POLL_GRACE_MS) {
    await removeFromAllTracked(env, flight);
  }
}

// Re-reads the poll set and writes every flight's new schedule in one go. Doing
// it once at the end rather than per-flight means a tick that polls several
// flights can't have each write clobber the last.
async function applySchedules(env: Env, byKey: Map<string, string>): Promise<void> {
  if (!byKey.size) return;
  const all = await getAllTracked(env);
  let touched = false;
  for (const flight of all) {
    const next = byKey.get(flightKey(flight));
    if (next === undefined) continue; // not polled this tick
    if (flight.nextPollAt !== next) {
      flight.nextPollAt = next;
      touched = true;
    }
  }
  if (touched) await saveAllTracked(env, all);
}

async function getHistory(env: Env, flight: FlightRef): Promise<HistoryEntry[]> {
  return getJSON<HistoryEntry[]>(env, historyKey(flight), []);
}

async function appendHistory(env: Env, flight: FlightRef, changes: string[]): Promise<void> {
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
        list.flights.map(async (job) => {
          // Only flight jobs have a live record to look up. Appointments and
          // shifts carry their own fixed target time and never touch these keys.
          if (!isFlightJob(job)) {
            return { flight: job, status: null, recentChanges: [] };
          }
          const [raw, history] = await Promise.all([
            env.FLIGHT_DATA.get(flightKey(job)),
            getHistory(env, job),
          ]);
          return {
            flight: job,
            status: raw ? (JSON.parse(raw) as FlightStatus) : null,
            recentChanges: history.filter((h) => new Date(h.at).getTime() >= since),
          };
        })
      );
      return json({
        ntfyTopic: ntfyTopicFor(listCode),
        settings: resolveSettings(list.settings),
        entries,
      });
    }

    // POST /api/flights — add a job to a list. Flights need { flightNumber, date };
    // appointments and shifts need { kind, targetTime } instead.
    if (request.method === "POST" && url.pathname === "/api/flights") {
      const body = (await request.json()) as Job & { listCode?: string };
      if (!body.listCode) return json({ error: "listCode is required" }, 400);

      const kind = kindOf(body);
      if (!(FLIGHT_KINDS as string[]).concat("appointment", "shift").includes(kind)) {
        return json({ error: `Unknown kind "${kind}"` }, 400);
      }
      const wantsFlight = (FLIGHT_KINDS as string[]).includes(kind);
      if (wantsFlight && (!body.flightNumber || !body.date)) {
        return json({ error: "flightNumber and date are required for a flight job" }, 400);
      }
      if (!wantsFlight && !body.targetTime) {
        return json({ error: `targetTime is required for a ${kind} job` }, 400);
      }

      const list = await getList(env, body.listCode);
      if (!list) return json({ error: "Unknown listCode" }, 404);

      // Non-flight jobs get an explicit id; flights derive theirs, which is what
      // keeps every row written before Phase 1 working without a migration.
      const flight: Job = wantsFlight
        ? {
            kind,
            flightNumber: body.flightNumber,
            date: body.date,
            ...pickupFieldsFrom(body),
          }
        : {
            kind,
            id: randomHex(6),
            targetTime: body.targetTime,
            endTime: body.endTime ?? null,
            place: body.place ?? null,
            placeCode: body.placeCode ?? null,
            ...pickupFieldsFrom(body),
          };

      if (!wantsFlight) {
        list.flights.push(flight);
        await saveList(env, body.listCode, list);
        return json({ flight, status: null });
      }

      // Validated above, so this is a real flight identity from here down.
      const ref: FlightRef = { flightNumber: body.flightNumber!, date: body.date! };
      const existing = list.flights.find((f) => isFlightJob(f) && sameFlight(f, ref));
      if (existing) {
        // Re-adding fills in details rather than duplicating — but only ones
        // actually supplied. Clearing a field is PATCH's job; a re-add that
        // happens to leave the optional inputs blank must not wipe what's there.
        Object.assign(existing, definedOnly(pickupFieldsFrom(body)));
      } else {
        list.flights.push(flight);
      }
      await saveList(env, body.listCode, list);

      await addToAllTracked(env, ref);
      const trackers = await getTrackers(env, ref);
      if (!trackers.includes(body.listCode)) {
        trackers.push(body.listCode);
        await saveTrackers(env, ref, trackers);
      }

      // Fetch immediately so the UI has something to show without waiting for the next cron
      // tick. The flight is already tracked at this point regardless of how this goes, so a
      // failure here (rate limit, AeroDataBox outage) shouldn't fail the whole request — cron
      // will pick up a real status once the lookup starts working again.
      let status: FlightStatus | null = null;
      try {
        status = await fetchFlightStatus(env.AERODATABOX_KEY, ref);
        if (status) {
          await env.FLIGHT_DATA.put(flightKey(ref), JSON.stringify(status));
        }
        // The add already paid a unit, so bank it: without a schedule this
        // flight reads as "due" and the next cron tick would spend another.
        if (status) {
          await applySchedules(
            env,
            new Map([[flightKey(ref), computeNextPollAt(status, Date.now(), false)]])
          );
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
      const flight: FlightRef = { flightNumber, date };
      if (!list.flights.some((f) => isFlightJob(f) && sameFlight(f, flight))) {
        return json({ error: "Flight is not on this list" }, 404);
      }

      return json({ history: await getHistory(env, flight) });
    }

    // PATCH /api/flights — edit pickup details without re-adding the job.
    // Addressed by job id: "NUMBER:DATE" for a flight, the stored id otherwise.
    if (request.method === "PATCH" && url.pathname === "/api/flights") {
      const body = (await request.json()) as Job & { listCode?: string; id?: string };
      if (!body.listCode) return json({ error: "listCode is required" }, 400);

      const wanted = body.id ?? (body.flightNumber && body.date
        ? `${body.flightNumber}:${body.date}`
        : null);
      if (!wanted) return json({ error: "id, or flightNumber and date, are required" }, 400);

      const list = await getList(env, body.listCode);
      if (!list) return json({ error: "Unknown listCode" }, 404);

      const entry = list.flights.find((f) => jobId(f) === wanted);
      if (!entry) return json({ error: "Job is not on this list" }, 404);

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

      const current = resolveSettings(list.settings);
      const settings: ListSettings = {
        driveMinutes: body.driveMinutes ?? current.driveMinutes,
        bufferMinutes: body.bufferMinutes ?? current.bufferMinutes,
        checkInLeadMinutes: body.checkInLeadMinutes ?? current.checkInLeadMinutes,
        checkInLeadIntlMinutes: body.checkInLeadIntlMinutes ?? current.checkInLeadIntlMinutes,
        showPassengerNames: body.showPassengerNames ?? current.showPassengerNames,
      };

      list.settings = settings;
      await saveList(env, body.listCode, list);
      return json({ settings });
    }

    // DELETE /api/flights — stop tracking a job, addressed by job id.
    if (request.method === "DELETE" && url.pathname === "/api/flights") {
      const body = (await request.json()) as Job & { listCode?: string; id?: string };
      if (!body.listCode) return json({ error: "listCode is required" }, 400);

      const wanted = body.id ?? (body.flightNumber && body.date
        ? `${body.flightNumber}:${body.date}`
        : null);
      if (!wanted) return json({ error: "id, or flightNumber and date, are required" }, 400);

      const list = await getList(env, body.listCode);
      if (!list) return json({ error: "Unknown listCode" }, 404);

      const removed = list.flights.find((f) => jobId(f) === wanted);
      list.flights = list.flights.filter((f) => jobId(f) !== wanted);
      await saveList(env, body.listCode, list);

      // Only flight jobs hold shared records that need unwinding.
      if (removed && isFlightJob(removed)) {
        const trackers = (await getTrackers(env, removed)).filter((c) => c !== body.listCode);
        await saveTrackers(env, removed, trackers);
        await removeFromAllTrackedIfOrphaned(env, removed, trackers);
      }

      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const tracked = await getAllTracked(env);
    const now = Date.now();

    // Cron still wakes every 20 minutes — that part is free — but it now asks
    // which flights are actually DUE rather than polling all of them. The
    // assignment email already supplies a usable scheduled time, so a unit is
    // only worth spending when the answer could still change what the driver does.
    // An absent nextPollAt means due: never skip a flight because a schedule
    // failed to compute.
    // An ABSENT nextPollAt means due — never skip a flight whose schedule
    // failed to compute. But computeNextPollAt returns null to mean "done, stop
    // scheduling", and null is also falsy, so the two must not be conflated:
    // treating "done" as "due" polls every landed flight on every tick until
    // the landed-grace sweep removes it, which is exactly the waste this whole
    // mechanism exists to avoid. DONE_POLLING is the explicit sentinel.
    const due = tracked.filter((f) => {
      if (f.nextPollAt === DONE_POLLING) return false;
      return !f.nextPollAt || new Date(f.nextPollAt).getTime() <= now;
    });
    if (!due.length) return;

    // Each flight's next poll time, applied in one write at the end so a burst
    // of concurrent polls can't lose each other's updates.
    const rescheduled = new Map<string, string>();

    // Independent per-flight, so poll and notify for all of them concurrently
    // instead of paying each flight's KV + AeroDataBox round-trip in sequence.
    await Promise.all(
      due.map(async (flight) => {
        try {
          const key = flightKey(flight);
          const prevRaw = await env.FLIGHT_DATA.get(key);
          const prev: FlightStatus | null = prevRaw ? JSON.parse(prevRaw) : null;

          const next = await fetchFlightStatus(env.AERODATABOX_KEY, flight);
          if (!next) {
            // Unknown to AeroDataBox — back off rather than retrying every tick.
            rescheduled.set(key, new Date(now + 6 * 3600 * 1000).toISOString());
            return;
          }

          const changes = diffFlightStatus(prev, next);
          await env.FLIGHT_DATA.put(key, JSON.stringify(next));

          // A flight that just moved is likely to move again, so tighten the
          // cadence. That is where the units genuinely buy something.
          rescheduled.set(key, computeNextPollAt(next, now, changes.length > 0));

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
                  const entry = list && list.flights.find((f) => isFlightJob(f) && sameFlight(f, flight));
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
          // A failed poll must not leave the flight due forever, re-spending a
          // unit every tick on something that is erroring.
          rescheduled.set(flightKey(flight), new Date(now + 30 * 60 * 1000).toISOString());
        }
      })
    );

    await applySchedules(env, rescheduled);
  },
};
