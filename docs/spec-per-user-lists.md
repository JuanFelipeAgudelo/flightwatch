# Spec: Private per-person flight lists

## Problem

FlightWatch currently has exactly one shared list and one notification channel, both
hardcoded into a single deployment:

- One KV key (`tracked-flights`) holds every tracked flight, globally.
- One `NTFY_TOPIC` secret means every push goes to every device subscribed to that topic.

If Ash shares the app URL with friends, everyone sees everyone's flights and gets
notified about everyone else's trips too. Fine for "we're all on the same trip,"
wrong for "we all just want our own personal tracker on the same app."

Ash chose **private per-person lists** over the shared-board default.

## Goal

Each person gets their own private flight list and their own notifications, while
still using the exact same deployed app/URL — no separate deployments per person,
no accounts/passwords to manage.

## Approach: a private "list code"

On first visit, the app generates a random list code (e.g. `7f3a9c2e`) and stores it
in `localStorage`. That code becomes part of every API call. No login, no email,
no password — losing the code just means starting a fresh empty list (acceptable
for a personal utility tool).

A person who wants to view their list on a second device (e.g. iPhone + iPad) needs
to manually copy their code across — worth a small "your code: XXXX — copy" UI
affordance so this isn't a dead end.

### Data model changes

- KV key changes from a single global `tracked-flights` to `list:<code>` per person,
  storing that person's tracked flights.
- Flight status cache key changes from `flight:<number>:<date>` to
  `flight:<number>:<date>` **unchanged** — status data itself isn't personal, so it's
  fine (and more efficient) to keep sharing the AeroDataBox lookup cache across all
  users tracking the same flight. Only the *list of who's tracking what* becomes
  per-person.
- Need a new top-level KV key `all-tracked-flights` (a deduped union across every
  person's list) for the cron job to know what to actually poll — cron doesn't care
  whose list a flight is on, it just needs one deduped set to check against
  AeroDataBox and diff.

### Notification routing — the hard part

Right now `NTFY_TOPIC` is one secret shared by the whole Worker. For private
per-person notifications, each person needs their **own** ntfy topic, and the
Worker needs to know which topic(s) to notify when a given flight's status changes
(since multiple people could be tracking the same flight).

Changes needed:

- Each person sets their own ntfy topic once (stored alongside their list code in
  `localStorage`, sent to the Worker, stored server-side against their list code).
- `scheduled()` handler changes from "diff this flight, notify the one global topic"
  to "diff this flight, then look up every list-code currently tracking it, and
  notify each of their topics individually."
- This requires a reverse index: `flight:<number>:<date>:trackers` → array of list
  codes currently tracking that flight, so the cron job doesn't have to scan every
  person's list on every poll.

### API changes

- `GET /api/flights` → needs a `listCode` query param or header, returns only that
  list's flights.
- `POST /api/flights` → same, plus registers the list code against the flight's
  tracker index.
- `DELETE /api/flights` → same, plus removes the list code from the tracker index
  (and if no one's left tracking a flight, drop it from `all-tracked-flights` too so
  cron stops polling it — avoids wasting AeroDataBox quota on abandoned flights).
- New: `POST /api/register` (or similar) → first-visit call that generates a list
  code + accepts an ntfy topic, returns the code to store client-side.

### Frontend changes

- On load: check `localStorage` for an existing list code; if none, call the
  register endpoint and store what comes back.
- Settings affordance: show the person their code (so they can share it or write
  it down), and let them re-enter a code manually (for "I want to see my list on a
  second device").
- Every existing fetch call needs the list code attached.

## What does NOT need to change

- The board UI, countdown logic, time formatting, pull-to-refresh — none of that is
  list-specific, it all keeps working exactly as-is per person.
- The AeroDataBox polling/diffing logic itself doesn't change — it still operates on
  one deduped set of real-world flights. Only the "who gets told" part changes.

## Open questions for Ash

1. Should list codes ever expire / clean up automatically (e.g. if untouched for
   90 days), to avoid orphaned KV entries piling up? AeroDataBox free-tier quota is
   the real constraint here, not storage.
2. Any interest in a lightweight "share my list with a friend" (read-only) mode
   later, distinct from "everyone tracks independently"? Not needed for this spec,
   but the tracker-index design above would make it easy to add later if wanted.
3. Confirm: losing/clearing localStorage = losing your list permanently, with no
   recovery. Acceptable for a personal tool, but worth Ash explicitly signing off on
   before this ships to friends.
