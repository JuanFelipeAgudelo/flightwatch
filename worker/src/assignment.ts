/**
 * The assignment model: what dispatch actually sends, kept whole.
 *
 * The old model flattened an assignment into a list of jobs, which destroys the
 * itinerary. In real assignment 369736 a passenger appears twice -- once at the
 * LGA pickup and once at their own Wallkill drop-off -- and a flat list can only
 * hold one of them. That second appearance is not a duplicate; it is the other
 * half of the work.
 *
 * Four levels, taken from the owner's own markup of the assignment sheet:
 *
 *   Assignment   the run: number, window, vehicle, parking, driver, assistants
 *   └─ Step      a place and a time. The grey bar.
 *      └─ Action what happens there -- Pickup or Drop-off, and where exactly.
 *         └─ Entity  who, and what they are travelling on. The black bar's rows.
 */

/** A passenger, or a party travelling together. */
export interface Entity {
  /** Display name. A party is one entity: "Boeck, Christian & Heidi". */
  name: string;
  /** How many people this row represents. 1 unless it is a party. */
  pax: number;
  /** Where they are coming from and going to, as the row itself states them. */
  origin?: string | null;
  destination?: string | null;

  /** Airport rows. Resolved to an IATA-prefixed number, or null when the
   *  airline could not be resolved -- never guessed. */
  flightNumber?: string | null;
  /** The scheduled time and city as printed, kept even when the flight number
   *  could not be resolved, because it is still useful to a driver. */
  scheduledText?: string | null;

  /** Fixed-time rows: medical appointments, embassy arrivals. */
  appointmentTime?: string | null;
  duration?: string | null;
  /** Shuttle rows. */
  route?: string | null;

  /** The passenger's number, as printed. Operationally required: assignments
   *  arrive at 5pm and the driver must reach every passenger before 9pm the
   *  night before, then again from the kerb until they are in the car.
   *
   *  Null is a real and common value -- 61 of 411 entities in the sample have
   *  none, and 29 of those have a `Phone:` label printed with nothing after it.
   *  The UI should say there is no number rather than show an empty space,
   *  because the driver still has to reach them somehow. */
  phone?: string | null;

  bags?: number | null;
  /** Per-passenger note. 76 across the sample, and they change the work:
   *  "I will be bringing a small cart with me", "Cell is WhatsApp#". */
  note?: string | null;

  /** The row's own tag: A, D, GBA, GBD, MED, S, TD, HO. */
  tag?: string | null;
  /** True for GBA/GBD. Governing Body runs have their own rules -- curbside is
   *  permitted, they are never combined without oversight, and they should
   *  reach the driver soonest. */
  gb?: boolean;
  /** Set when the row type is not yet supported (TD, HO), so it is visible as
   *  an unsupported row rather than silently missing. */
  unsupported?: string | null;
}

export interface Action {
  /** "Pickup" or "Drop-off". Others may exist; this is not a closed set. */
  verb: string;
  /** Where at the place -- "Baggage Claim", "A Front", "Curbside". Dispatch
   *  genuinely leaves this blank sometimes (24 across the sample), so null is a
   *  real value and the UI says so rather than showing a gap. */
  where?: string | null;
  entities: Entity[];
}

export interface Step {
  /** The site code where it is one ("WRK", "EWR"), else null. 28 assignments
   *  have a stop named in free text ("Dispatch", "Enterprise Rent"), and using
   *  those as a drive-time key looks up nothing. */
  code?: string | null;
  /** Always present: the place as printed. */
  place: string;
  address?: string | null;
  /** Wall-clock as printed. A first step has no eta; a last step has no etd. */
  eta?: string | null;
  etd?: string | null;
  /** Resolved calendar date of the DEPARTURE (etd), walked forward across
   *  midnight. The itinerary is ordered by this. */
  date: string; // YYYY-MM-DD
  /** Resolved date of the ARRIVAL (eta), which is not always the same day.
   *  LGA in 369736 is reached at 11:00 PM and left at 12:00 AM, so its eta is
   *  the 31st and its etd the 1st. Anything about arriving -- a flight's date
   *  above all -- must use this, or the flight is tracked a day out and never
   *  resolves. */
  etaDate?: string; // YYYY-MM-DD
  actions: Action[];
}

export interface Assistant {
  name: string;
  role?: string | null;
  note?: string | null;
}

export interface Assignment {
  /** IDENTITY. The same number updates in place; a different number is a new
   *  assignment. The helper receives the same run under the same number, so the
   *  driver is deliberately NOT part of identity. */
  number: string;

  /** Wall-clock window. `start` is dispatch's own departure time -- they have
   *  already done that calculation, so the app's leave-by is a cross-check
   *  rather than a replacement. `end` is when the driver should be back at the
   *  start site. */
  start: string; // "YYYY-MM-DD HH:MM"
  end: string;

  driver?: string | null;
  /** Vehicle id and description, present in 183 of 186 real assignments, and
   *  what the driver needs when collecting it. */
  vehicle?: string | null;
  /** Parking space as printed, e.g. "FKL-NBD-003". */
  parking?: string | null;
  /** The three-letter prefix of the parking space: where the day starts. The
   *  start really varies -- Warwick 107 times, Fishkill 37 -- and Warwick to
   *  Newark is 75 minutes where Fishkill to Newark is 90. */
  originCode?: string | null;

  /** Free text, often several lines, sometimes a whole timed itinerary. */
  driverNotes?: string | null;
  assistants?: Assistant[];

  steps: Step[];

  /** True when any row is GBA/GBD. */
  gb?: boolean;
  /** Anything the importer could not do, surfaced rather than swallowed: an
   *  unresolved airline, an unsupported row type, a date that disagrees with
   *  the document's own end date. */
  issues?: string[];

  /** The page-footer timestamp: when dispatch printed this copy. Re-sends do
   *  not always arrive in order, so this -- not arrival -- decides which copy
   *  wins. */
  printedAt?: string | null;
  /** When this copy was imported. */
  importedAt: string;
  source?: string | null;
}

/** One key per assignment, under the owning list. Deliberately not a field on
 *  the list record: an assignment is a large object and a day holds several, so
 *  a shared blob would be rewritten constantly -- the same read-modify-write
 *  hazard that cost the poll set its writes. */
export const ASSIGN_PREFIX = "assign:";

export function assignmentKey(listCode: string, number: string): string {
  return `${ASSIGN_PREFIX}${listCode}:${number}`;
}

export function assignmentPrefixFor(listCode: string): string {
  return `${ASSIGN_PREFIX}${listCode}:`;
}

export function numberFromAssignmentKey(key: string): string | null {
  const at = key.lastIndexOf(":");
  return at > 0 && at < key.length - 1 ? key.slice(at + 1) : null;
}

/**
 * Which copy of an assignment to keep.
 *
 * Latest wins by the PRINTED footer, not by arrival: a re-send can reach the
 * driver after a newer copy, and the footer is the only reliable clock in the
 * document. A copy with no footer never displaces one that has a readable date.
 */
export function isNewerCopy(incoming: Assignment, existing: Assignment | null): boolean {
  if (!existing) return true;
  if (!incoming.printedAt) return false;
  if (!existing.printedAt) return true;
  return incoming.printedAt > existing.printedAt;
}

/** Every entity in an assignment, flattened — for counting and for finding the
 *  flights that need tracking. */
export function entitiesOf(assignment: Assignment): Entity[] {
  return assignment.steps.flatMap((s) => s.actions.flatMap((a) => a.entities));
}

/** The flights an assignment needs polled. Deduped: a passenger appears at both
 *  their pickup and their drop-off, and that is one flight, not two. */
export function flightsOf(assignment: Assignment): { flightNumber: string; date: string }[] {
  const seen = new Set<string>();
  const out: { flightNumber: string; date: string }[] = [];
  for (const step of assignment.steps) {
    // A flight belongs to the day it ARRIVES, which is not always the day the
    // driver leaves that stop. Using step.date here tracked an overnight
    // flight a day out, and a flight tracked on the wrong date never resolves
    // and never says why.
    const date = step.etaDate ?? step.date;
    for (const action of step.actions) {
      for (const entity of action.entities) {
        if (!entity.flightNumber) continue;
        const key = `${entity.flightNumber}:${date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ flightNumber: entity.flightNumber, date });
      }
    }
  }
  return out;
}
