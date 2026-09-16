# Spec: assignment ingest, and generalising beyond flights

Status: **planned, nothing built.** Phase 0 is the next step.

## Why

FlightWatch tracks flights. The actual job is broader: Oversight (TRNP Passenger
Dispatch) emails a PDF assignment, and the driver retypes the parts that matter
into the app. Airport runs are only part of the work — there are also medical
appointment runs, inter-site shuttles, and plain shifts.

The reframe that drives this spec: **FlightWatch is not a flight app, it is a
"when do I leave" app.** A medical appointment at 6:00 AM with a known drive time
is the same computation as a flight arrival — target time, minus drive, minus
buffer. Flights are just the case where the target time moves on its own.

## What the real data says

Sample: 251 PDFs from 250 automated "Transportation Assignment ###" emails,
**186 unique assignments** after collapsing re-sends. Source zip lives in the
owner's `Downloads` as `TRNP Assigments.zip` (the extracted copy was in a
session scratchpad and will not have survived).

| Category | Assignments | Share |
|---|---|---|
| No passengers (shift, standby, Flex Time, wash & fuel) | 90 | 48% |
| Airport run (`Airline/Flight`) | 71 | 38% |
| Medical (`Appointment time` + `Duration`) | 13 | 7% |
| Shuttle (`Route:` between sites) | 12 | 6% |

Airport runs are 38% of assignments but **74% of passenger-carrying work**.

**Types never mix within one assignment** — 71/13/12/90 with no combinations.
That makes the discriminator reliable.

## Document structure

Two templates: `TransportationAssignmentReport.pdf` (220) and
`Assignment Details.pdf` (30). Both open with the same header block.

```
Assignment number 369736      Driver Agudelo, Juan Felipe
Start date and time Monday, August 31, 2026 9:30 PM
End date and time   Tuesday, September 1, 2026 3:00 AM
Vehicle Branch (72436) 2017 Toyota Sienna (8 Seats)
Parking space FKL-NBD-008
Driver notes LGA pickup. Take arriving passenger to WKL
```

Then an ordered list of **stops**, each `CODE ETA: <time> ETD: <time> Name | Address`,
optionally followed by `Pickup:` / `Drop-off:` and a passenger table.

Passenger rows carry a category tag in the left column: **`A`** airport,
**`MED`** medical, **`S`** shuttle.

### Airport row
```
A  Trevis, Mitchell | LGA LaGuardia -> Wallkill
   Airline/Flight: United Airlines UA1503
   Time/City: 11:15 PM Houston, Texas (IAH)
   Phone: +1 323-580-4884        Bags: 0
```
Everything FlightWatch needs: flight number, scheduled arrival, origin, and the
pickup point (`Pickup: Baggage Claim`).

### Medical row
```
MED  Chang, Melisa | Warwick -> NYP Allen Hospital
     Appointment time: 6:00 AM      Duration: 6 hours
     Phone: +1 845-793-4275
```

### Shuttle row
```
S  Boseovski, Alethea | Warwick -> Newburgh Center B
   Route: Warwick > Patterson       Bags: 0
```

### Field vocabulary (occurrences across all 251)
`Phone` 1012 · `Time/City` 717 · `Airline/Flight` ~544 · `Route` ~212 ·
`Notes` 150 · `Duration` 98 · `Appointment time` 42

### Site codes
`WRK` Warwick (base, 1 Kings Drive) · `FKL` Fishkill · `TUX` Tuxedo ·
`NCB`/`NCA` Newburgh Center · `WKL` Wallkill · `PAT` Patterson · `STF`
Airports seen: `EWR` 60, `JFK` 35, `LGA` 32.

Driver covers seven airports in total — ALB, BDL, EWR, HPN, JFK, LGA, SWF —
though only EWR/JFK/LGA appear in this sample. **All seven are US/Eastern**, so
the arrival side of a leave-by never crosses a timezone in practice.

`(Unavailable)` lines are the driver's own calendar blocks (meetings, Flex Time),
not trips. Do not parse them as stops.

---

## Phase 0 — parser spike (do this first)

A standalone script that reads the PDFs and emits JSON. **No app changes, no
production risk, no model decisions.** It exists to answer the questions that
make the later phases safe:

1. Does the format hold across all 251, or does the tail get messy?
2. Do both templates parse, or do the 30 `Assignment Details` files need
   separate handling?
3. **Can the flight date be inferred reliably?** It is never stated. A stop
   reads `LGA ETA: 11:00 PM` on an assignment spanning Aug 31 → Sep 1; the date
   has to come from sequence against the assignment start. Midnight rollover is
   the sharp edge.
4. **What do the update re-sends change?** 36 assignments were emailed more than
   once; 371135 fourteen times. Some are marked *Updated Passenger*. If updates
   move times or swap passengers, reconciling them is the real ingest problem —
   not the first parse.
5. Do flight numbers normalise? They arrive zero-padded (`DL0114`, `DL0053`) and
   AeroDataBox likely expects `DL114`.

Success bar: ~95% clean parse with the failures named and understood.

`pypdf` handles these files (verified — 251/251 extracted with no errors).

## Phase 1 — generalise leave-by to a target time

A tracked thing gains a `kind`: `flight` | `appointment` | `shift`. Leave-by
stops reading `arrival.estimatedTime` directly and reads a resolver instead:

- `flight` → live AeroDataBox arrival (today's behaviour)
- `appointment` → the fixed `Appointment time`
- `shift` → `Start date and time`

Most of the app is already indifferent: hero, countdown, alert state and offline
handling all work off a target time. The real work is that non-flights have no
AeroDataBox status, so rendering needs an honest branch rather than a null-shaped
hole.

This is the phase that takes coverage from 38% of assignments to 100%.

## Phase 2 — import

Owner hands the PDFs over in a session; the assistant creates the jobs. This was
a deliberate choice over automation: no email infrastructure, no parser running
in production, and no email-as-a-write-path security surface.

## Phase 3 — rename, only once earned

"FlightWatch" is wrong for an app covering medical and shuttle work. Candidates
discussed: **LeaveBy** (favoured — names the one question the app answers, true
for a flight and a hospital appointment alike), Curbside, Dispatch, Callsign.
Cost is low now and rises with every user, but renaming before the scope
actually broadens is churn.

## Explicitly not doing

- **Rebuilding this as a dispatch system.** Oversight already has one. The app
  does not need to be a second source of truth; it needs to answer "when do I
  leave".
- **Email ingest automation.** Considered and declined — see Phase 2.

## Privacy

These documents carry passenger names, mobile numbers, and named hospitals. The
medical rows are health-adjacent data about third parties. The redesign already
treats passenger names as sensitive enough to warrant a hide-on-list toggle; a
destination of "NYP Allen Hospital" raises that bar. If the app becomes the place
this data lives, that should be a deliberate decision with a retention answer,
not something it drifts into.
