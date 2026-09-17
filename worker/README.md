# flightwatch-worker

The Cloudflare Worker behind Curbside: the API the PWA talks to, and the cron
that polls AeroDataBox.

```bash
npm run typecheck        # tsc --noEmit
npx wrangler deploy      # ship it
npx wrangler tail        # live logs, including cron ticks
```

Requires **Node 22 or newer** (wrangler 4). Node 18 installs wrangler 4 fine and
then refuses to run it.

## Reading production KV — always pass `--remote`

**Wrangler 4 defaults every `kv key` command to a LOCAL stub.** Wrangler 3
defaulted to remote. There is no error and no prompt; the command succeeds
against a local store and prints a quiet `Resource location: local`.

```bash
# WRONG — reads a local stub, says nothing about production
npx wrangler kv key get "all-tracked-flights" --namespace-id <id> --text

# RIGHT
npx wrangler kv key get "all-tracked-flights" --namespace-id <id> --text --remote
```

This cost a session a wrong conclusion: production state was compared against a
local stub, the mismatch looked like data loss, and a bug was reported that did
not exist. If a KV reading ever looks surprising, **check for `--remote` before
believing it.**

`kv key put` also needs a non-empty value from the CLI, even though the Workers
runtime accepts `put(key, "")` happily.

## Key layout

| Key | Holds |
|---|---|
| `list:<code>` | one person's private list — jobs plus settings |
| `flight:<num>:<date>` | last known status for a flight, shared across lists |
| `flight:<num>:<date>:trackers` | which list codes track it, so cron can route pushes |
| `flight:<num>:<date>:history` | the change lines cron computed, for the detail screen |
| `flight:<num>:<date>:sched` | when cron should next spend a unit on it |
| `poll:<num>:<date>` | membership of the poll set — **one key per flight** |

`poll:` is listed by prefix rather than read as one array. It used to be a
single `all-tracked-flights` key rewritten by every add and remove: KV has no
compare-and-swap and eventually-consistent reads, so two adds close together
could both read the same array and the second write would silently drop the
first. The flight stayed on the user's list, showed the status from its add-time
fetch, and was never polled again — with nothing to surface the loss. A key per
flight removes the shared write entirely.

The retired key is migrated and deleted on the first cron tick that sees it.

## Quota

AeroDataBox bills in monthly **API units**. Polling follows an offset ladder
before the next leg event (6h / 3h / 2h / 45m / 15m) plus one post-event poll,
which is the only moment a baggage belt is knowable — roughly 12 units per
flight rather than the ~90 an unbounded 5-minute cron was spending.

A poll that throws backs off by evidence: a flight we have held a status for had
a blip and retries in 30 minutes; one we have never had a status for is not a
blip and backs off six hours.
