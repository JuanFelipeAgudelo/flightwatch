# Spec: Curbside — the assignment-centric rebuild

Status: **agreed 2026-09-16. Phase 4 next.**
Supersedes the flight-centric framing in [`spec-assignments.md`](spec-assignments.md),
whose Phase 0–3 findings remain the factual basis for everything here.

UX direction, agreed with the owner:
<https://claude.ai/artifact/94T4tbv9egodyxCDW4n3qA>

## Why the reframe

FlightWatch treats a flight as the unit of work and renders a flat list of jobs.
That model **destroys information the driver needs**. In real assignment 369736 a
passenger appears twice — once at the LGA pickup, once at their own Wallkill
drop-off — and the importer discards the second appearance as a duplicate. It
isn't a duplicate. It is the other half of the work.

A driver does not do "a job". They follow a sequence: leave Fishkill 9:30 PM,
collect two people off separate flights at LaGuardia baggage claim, drop one at
A Front and one at B Carport, return by 3:00 AM. **That itinerary is the
product.**

### What the app is actually for

The department's own scheduling already computes a departure time — field #2 of
every assignment. So leave-by is **not** the app's unique contribution; it is a
cross-check. The unique contribution is narrower and sharper:

> Dispatch's 9:30 PM was computed when UA1503 was on time. When the flight
> moves, their number is stale and this app is the only thing that knows.

Everything else in this spec exists to make that sentence legible at 2 AM.

## Data model

Four levels, from the owner's own markup of the assignment sheet:

```
Assignment
├─ number          identity of the RUN, not of one person's copy
├─ start / end     #2 default depart time, #5 back at start location
├─ vehicle         id + make/model — present in 183/186
├─ parking         site code; the three letters say where the day starts
├─ driver
├─ assistants[]    name + role + note — present in 48/186 (25%)
├─ driverNotes     free text, often multi-line, sometimes a timed itinerary
└─ steps[]
   ├─ site code, place, address
   ├─ eta / etd    blank eta = first step, blank etd = last
   └─ actions[]
      ├─ verb      Pickup / Drop-off / others exist — do not assume a closed set
      ├─ where     "Baggage Claim", "A Front", "B Carport"
      └─ entities[]
         ├─ passenger, bags
         ├─ origin / destination (the row's own cells — authoritative)
         └─ info    flight, appointment time, route, or other
```

### Rules that are easy to get wrong

**Identity is the assignment number alone.** The helper receives the same
assignment under the same number, so `driver` is *not* part of identity. Two
people on one run should converge on one record, never two drifting copies.

**A passenger row is printed once per step it participates in.** Deduping across
steps is wrong. Dedupe only within a step.

**The row's Origin/Destination cells beat the enclosing stop.** A row appears
under both the pickup and drop-off stop, so the stop it sits under is only right
half the time.

**`(Unavailable)` rows are the driver's own calendar**, not trips.

**A combo is governed by the latest arrival.** Multiple entities under one action
are collected together, so the controlling flight is whoever lands *last*.
Getting this backwards sends the driver to wait an hour, or to miss someone.

**Origin matters for drive time.** The start is Warwick 107 times and Fishkill 37
in the sample, and Warwick→EWR is 75 minutes where Fishkill→EWR is 90.

## Updates and edits

Re-sends replace the whole record; there is no diff marker (Phase 0). So:

- Imports are **whole-record replace**, latest wins by the page-footer timestamp.
- Manual edits live in an **ordered patch log**, reapplied after each import —
  never merged into the record. Without this, a new email silently eats a
  driver's correction.
- That patch log **is the undo stack**. Undo pops the last patch.
- On update, show *what changed* in place (old time struck beside the new one)
  and an `UPDATED` chip on the list card. **Not** version history — the owner
  asked for "this changed", not a timeline.

## UX direction

Four data levels, **two screens**. Nesting is shown with a rail and indentation
on one scrolling page, never with navigation.

| Decision | Resolution |
|---|---|
| Screens | Two, plus one sheet. The sheet may only ever hold **live flight data for one entity** — history, terminal, gate, belt. Anything else goes on the itinerary. |
| Headline | **Right Now** once an assignment starts; leave-by before it does. |
| Depth | Managed by **time, not taps**. Past steps collapse to a dim line, current is open, future are compact. |
| Past steps | Reopenable by tap — **one at a time**, and the current step never collapses. |
| Density | The board/card toggle survives, **scoped to the list**. The itinerary is already at its floor. |
| Accent | One brass thing per screen. If three things glow, none of them mean anything. |
| Editing | **No edit mode.** Dashed affordances where a thing would go; tap any value to change it. |
| Undo | **In place and never expiring** — a removed step leaves a ghost row. No toast: five seconds to react at 2 AM is a promise the app cannot keep. |

### How a GB run is marked — settled

One accent, spent once. The mark changes **shape**, never hue.

| Where | What |
|---|---|
| Assignment card | A 4px brass bar down the left edge, vertical gradient (`#F5C071` → `#C4821F` night, `#F0B45A` → `#B9761A` day), **inset from the corners** |
| Assignment card | A brass-outlined `GB` chip, in the same vocabulary as `SHIFT` and `MED` |
| Right Now band | A `GOVERNING BODY` plate beside the `RIGHT NOW` eyebrow — near-black ground, brass text, 1px inset top highlight |
| Everywhere else | Nothing. Steps, times and entities are identical to any other run. |

The inset on the bar is load-bearing, not decoration: the **in-progress** card is
a full 1px outline in the same brass, so a bar that touched the corners would
read as a variant of it. A solid bar set *into* the edge is a different gesture,
which is what lets it share the colour without borrowing the meaning.

The stamp is **additive, never substitutive** — the eyebrow still reads
`RIGHT NOW` on a GB run, so the band's anatomy never changes underneath the
driver.

Two things were tried and cut. A **platinum second accent** looked good in
isolation and wrong in context: it split attention with the brass and made GB
runs feel like a different product. A **rules strip** (curbside permitted, do
not combine, approved drivers only) was rejected by the owner for the right
reason — a GB-approved driver already knows the rules, and printing them back is
a checklist for someone who needs one. Where a rule genuinely changes the work it
appears *in* the work: the pickup line reads `Curbside — requested`.

### Right Now belongs to the list, not the assignment

Assignments can overlap. Two cards both claiming `IN PROGRESS` is exactly the
confusion this design exists to avoid, so **Right Now is one band at the top of
the home screen** — the single next thing across everything. An open assignment
shows its own current step in its own header, with no competition.

### Progress: Automatic / Confirm / Manual

| Mode | Advances on the clock | Asks first |
|---|---|---|
| **Automatic** (default) | yes | no |
| **Confirm** | yes | yes |
| **Manual** | no | — |

Correction by tapping the rail dot exists in **all three**; the setting only
governs whether the app advances without you. Confirm is **never a modal** — the
Right Now band grows a non-blocking "Still at LGA? · Yes / Moved on" row.

Default is Automatic because a driver who never opens settings still gets a
working headline, and its failure mode is mild: wrong step, one tap to fix.
Manual's failure mode is worse — the headline silently does nothing until you
discover you were meant to be tapping.

Progress state and this setting are **per-device** (`localStorage`), for the same
reason density and theme are: two people on one list code must not fight over
whose progress is real.

## Archive and retention

Two mechanisms, deliberately separate:

- **Archive** 10 hours after a run completes. It leaves the home screen but stays
  readable behind an Archive control, still grouped by day. Ten hours means a
  3 AM finish is still on screen when you wake up.
- **Delete** after a user-chosen window: **2 / 7 / 14 / 30 days, default 7.**
  Long enough to check what happened last Tuesday, short enough that passenger
  names, mobile numbers and named hospitals are not sitting around for a month
  by default.

This is the retention answer the privacy section of `spec-assignments.md` asked
for. One cron rule now; a conversation nobody wants later.

## Offline is a data-layer constraint, not a polish item

The driver is standing in an LGA baggage hall at 11 PM. Airport garages and
terminals eat signal. A flight tracker degrades gracefully offline — it just
stops updating. **An assignment companion that cannot show the next stop is
useless at exactly the moment it matters most.**

So: the full assignment must be readable offline, and step taps and edits must be
**queued**, not dropped. This lands before the UI, not after.

## What the manuals say, and what it changes

Read properly at the owner's suggestion, rather than skimmed for timing rules.
Five documents: department guidelines, scheduling, dispatch, HuB essentials,
office skills.

### GB is the Governing Body. GBA rows are Governing Body Assistant.

96 of the passenger rows in the sample are `GBA`/`GBD` — 20%, not an edge case.
These runs have their own rules, and three of them reach the app:

- **Curbside is permitted for them.** "Curbside pick-ups are not scheduled in
  advance. The driver should always try and park first... **Exceptions:** when
  there is no airport parking available; when there is no parking space for a
  Sprinter or over-height vehicle; **for members of the GB, Helpers, or BC (if
  specifically requested)**." So for a GB row the pickup point genuinely may be
  the curb rather than baggage claim — the app should not assume otherwise.
- **Never combine without oversight.** "Never combine with other requests
  without consulting on-site overseer." A GB row must not be treated as a combo
  candidate the way an ordinary `A` row is.
- **Notifications go UP, not down.** The HuB guide's "if it is a GB member,
  always select NO NOTIFICATIONS" is a setting on the *passenger's* record: it
  stops HuB emailing them. Passengers never see Curbside. Read as a constraint
  on this app it would have suppressed exactly the alerts that matter most, so
  it is recorded here as the opposite: **a GB run should notify the driver more
  readily than an ordinary one**, and its changes deserve a louder push.

"Respect confidential information and do not share any details to those
unauthorized" still applies to data at rest -- it is an argument for the
retention rule, not for hiding anything from the driver, who is the authorized
party.

### Combining has written thresholds

- Same site: allowed when flights land **approximately 45 minutes apart**.
- Different sites: allowed when it does not adversely impact travel times.
- Older passengers: "typically, they should not be asked to wait more than 15 or
  20 minutes", and should not be asked to wait for a combination at all.

The app already knows a combo's controlling flight is the latest arrival. These
give it something to *say*: a combo whose flights are more than 45 minutes apart
is outside the guideline, and worth flagging rather than silently scheduling.

### Dispatch's departure time may be a deliberate exception

Scheduling enters both a **recommended departure time (RDT)** and the
passenger's **preferred departure time (PDT)**, and where the PDT is shorter
than the RDT, that is discussed with the requester and assigned anyway with a
note. For GB/Helpers/BC the PDT is not to be changed at all.

So an assignment's start time is sometimes a **considered exception, not an
oversight**. Curbside's own computation must therefore read as advice *beside*
dispatch's time — never as a correction of it. This sharpens the Right Now copy:
the app's job is to say when the world has moved since dispatch decided, not to
second-guess the decision.

### The check-in figures this app shipped were wrong

The guidelines give the rule — "Domestic: passengers should arrive at least
**2 hours** before their flight departs / International: at least **3 hours**" —
and separately quote TSA Pre-Check guidance of 1½ and 2 hours for passengers who
hold Pre-Check. Curbside shipped the Pre-Check pair as the default for everyone,
telling drivers to leave half an hour late domestically and an hour late
internationally. Only 4 of 186 assignments mention Pre-Check, so the default has
to be the longer lead and Pre-Check becomes a per-job shortening.

### Vehicle priority, for context

Approved requests are scheduled first-come first-served in this order: GB /
Helper / BC, then Passenger Transportation assignments, then Batch department,
then Medical Services, then other department requests. Not app behaviour, but it
explains why a GB run displaces other work.

## Phases

| Phase | What | Why this order |
|---|---|---|
| **4** | Redacted fixtures + parser test suite | Everything after is riskier without it |
| **5** | Assignment model end-to-end (Worker + Python importer emits the full hierarchy) | Extraction is already proven — the cheap half |
| **6** | Assignments list + itinerary UI | The visible payoff |
| **7** | Manual create/edit of steps and children, with undo | Makes the parser's gaps survivable |
| **8** | Self-serve upload — parser ported to JS, parsed in the browser | Only worth it once 5–7 are solid |
| **9** | Update + "this changed", on the edit overlay | Needs 7 to exist |
| **10** | Notes timeline — the 124 timed lines | Pure addition, safe late |
| later | Auth, replace the shared poll array, dispatch view | Gate on real users, not on one |

Phases 4–7 give a working personal app. 8–10 make it something you could hand to
another driver. The "later" row is what stands between that and 150 people.

### Why fixtures come first

Everything so far has shipped on manual verification. That has caught real bugs —
and it *missed* the truncated driver notes, the parking-space capture and the
double-counted passenger rows until someone happened to look. At four nested
levels with manual editing on top, that stops being good enough.

The 186 real PDFs are ideal fixtures and cannot be committed: they carry
passenger names, mobile numbers and hospital destinations. **Redacted fixtures,
generated from the real ones, are the deliverable.**

## Parsing decisions

**In the browser (pdf.js), not the Worker.** The PDF and its PII never leave the
device; Workers have hard CPU limits that PDF parsing would fight at 238
assignments a day; and it costs nothing per additional user. The Python importer
stays as the reference implementation to test the JS port against.

**Driver notes: parse the timed lines, not the prose.** 62 of 179 notes contain a
time and 124 lines *start* with one — `7:45a Load Mail for ALL Sites` splits
cleanly into a time and an instruction. What cannot be done reliably is inferring
a location or a type from the instruction: that line has none, and
`8:00a Depart WRK Lobby for HUB` has two. So timed lines become a checklist
attached to the enclosing step, verbatim, and prose is displayed as written with
a control to promote any line into a real step by hand.

**Import what is understood; hand the rest to the driver.** An unknown airline, an
excluded row type, a date that disagrees with the document's stated end date — all
reported, never guessed. A confidently wrong pickup time is worse than an obvious
gap.

## The name

**Curbside.** The owner's own reasoning: curbside is the pickup drivers prefer and
the guidelines discourage — park first, meet the passenger inside at baggage
claim. It is the simple path, the one that skips the parking and the walk. The app
does the same thing to a complicated email.

Noted so nobody is surprised: the department manual explicitly steers away from
curbside pickups. If this is ever shown to oversight, the name invites the
question. That may be the point.

The rename touches the manifest, the service-worker cache name, the title, the
icon and the theme color — cheap now, less cheap once other drivers have it
installed.

## Explicitly not doing

- **Rebuilding dispatch.** Oversight has a system. This app answers "what do I do
  next", not "who should drive what".
- **Email ingest automation.** Considered and declined — no email infrastructure,
  no parser in production, no email-as-a-write-path.
- **Version history.** "This changed" only.
- **Undo on step taps** — tapping another dot is the undo — **or on re-imports**,
  which the edit overlay already protects against.

## Open

- `TD` (train) and `HO` (embassy/consulate) rows remain excluded and reported.
- Other action verbs beyond Pickup/Drop-off exist and are not yet enumerated.
- ALB, BDL, HPN and SWF have no drive time from any site — they never appear in
  the sample and must come from the department's own table, not a guess.
- Warwick's address differs between the owner's table (40 Kings Dr, Tuxedo Park)
  and the assignment documents (`WRK ... Warwick | 1 Kings Drive`). Unresolved,
  and not to be reconciled by guessing.
