"""Turn a TRNP assignment PDF into FlightWatch jobs.

Usage:
    python tools/import_assignment.py <pdf|dir> [...]           # print jobs as JSON
    python tools/import_assignment.py <pdf> --post <listCode>   # add them to a list
    python tools/import_assignment.py <dir> --audit             # coverage report

Design notes, all of them learned the hard way from the real documents:

* Extraction uses pypdf's `layout` mode. Plain mode interleaves the table
  columns -- it puts `Time/City:` on a line *above* the row it belongs to and
  splits "United Airlines UA 1068" so the carrier prefix looks absent. Every
  conclusion here is drawn from layout mode.

* The number in the FILENAME is an email thread label, not the assignment
  number. Six files named `373621_*` in the sample are six unrelated
  assignments from five different months. Identity always comes from
  "Assignment number" inside the document.

* Re-sends replace the whole record; there is no diff marker. Latest wins,
  ordered by the page-footer print timestamp, which is the only reliable clock
  in the document.

* `(Unavailable)` lines are the driver's own calendar (meetings, Flex Time),
  not trips.

* Anything uncertain is reported, never guessed: an unknown airline, an
  excluded row type, a date that disagrees with the document's stated end date.
  A confidently wrong pickup time is worse than an obvious gap.
"""
import argparse
import glob
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta

import pypdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from airlines import lookup as airline_lookup  # noqa: E402

API = "https://flightwatch-worker.juanfe02agu.workers.dev"

# The driver's home site. Drive times are only meaningful relative to one origin.
BASE = "WRK"  # Warwick, 1 Kings Drive

# Every airport this department drives to. Listed so --drive-times can say which
# ones it has NO evidence for, rather than leaving a silent hole in the table.
AIRPORTS = {"ALB", "BDL", "EWR", "HPN", "JFK", "LGA", "SWF"}

# Origin-aware drive times, written by --drive-times --save. Derived rather than
# transcribed by hand, so the numbers can be regenerated from the corpus instead
# of drifting out of sync with it.
DRIVE_TIMES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "drive_times.json")


def load_drive_times():
    try:
        with open(DRIVE_TIMES_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {"base": BASE, "fromBase": {}, "pairs": {}}


def drive_for(origin, dest):
    """Minutes from `origin` to `dest`, or None rather than a guess. The reverse
    leg stands in for a missing outbound -- the schedule is symmetric in this
    data -- but two unrelated legs are never averaged into a third number."""
    if not origin or not dest:
        return None
    t = load_drive_times()
    for key in (f"{origin}>{dest}", f"{dest}>{origin}"):
        if key in t["pairs"]:
            return t["pairs"][key]
    if origin == t.get("base"):
        return t["fromBase"].get(dest)
    return None

DT_FMT = "%A, %B %d, %Y %I:%M %p"

HEADER_RE = re.compile(
    r"Assignment number\s+(?P<num>\d+)\s+Driver\s+(?P<driver>.+?)\s*$", re.M)
# The AM/PM can wrap onto the next line when the cell is narrow ("...12:00\n
# PM"), so every gap inside a timestamp is \s+, not a literal space. parse_dt
# re-normalises the whitespace. Getting this wrong silently skipped whole
# assignments -- both copies of today's 375126 among them.
_DATE = r"[A-Za-z]+,\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s+[AP]M"
START_RE = re.compile(
    r"Start date and time\s+(?P<start>" + _DATE + r")"
    r"\s+End date and time\s+(?P<end>" + _DATE + r")")
FOOTER_RE = re.compile(r"(" + _DATE + r")\s+Page \d+ of \d+")
NOTES_LABEL_RE = re.compile(r"Driver notes[ \t]{2,}")
# Where the notes block ends: the next titled section, or a stop row.
NOTES_END_RE = re.compile(r"^\s*(Assistant|Passenger|\(Unavailable\))\b|ETA:|ETD:")


def parse_notes(text):
    """The notes cell, including its continuation lines.

    Notes are a wrapped table cell, not a single line: 96 of 186 real
    assignments run to several lines and 62 contain a time, some of them a full
    timed itinerary. Reading only the first line silently truncated every one of
    them -- and made "only 10% of notes have times" look true when it is 34%."""
    m = NOTES_LABEL_RE.search(text)
    if not m:
        return None
    lines = text[:m.start()].count("\n")
    col = m.end() - (text.rfind("\n", 0, m.start()) + 1)
    all_lines = text.split("\n")
    out = [all_lines[lines][m.end() - (text.rfind("\n", 0, m.start()) + 1):].strip()]
    # Blank lines occur INSIDE the notes -- dispatch separates paragraphs with
    # them. Breaking at the first one truncated the block and lost real
    # operational detail: 345852 kept an address and dropped the line after it,
    # "Drop off location: Main parking lot stairs in between the two buildings",
    # which is precisely what a driver needs at 5am.
    #
    # So blanks are allowed through. The block ends at a titled section or a
    # stop row, at a line indented further left than the notes column, or at a
    # run of blank lines long enough to mean the cell is over.
    blanks = 0
    for line in all_lines[lines + 1:]:
        if not line.strip():
            blanks += 1
            if blanks >= 3 and out:
                break
            out.append("")
            continue
        if NOTES_END_RE.search(line):
            break
        # A continuation sits under the notes column; anything starting further
        # left is a new field, not more notes.
        if len(line) - len(line.lstrip()) < col - 6:
            break
        blanks = 0
        out.append(line.strip())
    # Collapse the runs of blanks we let through, and drop any trailing ones.
    text = "\n".join(out)
    text = re.sub(r"\n{2,}", "\n", text).strip()
    return text or None

# "Parking space  WRK-RPG-BSMNT-065" -- the three-letter prefix is the site the
# vehicle is parked at, which is where the driver's day starts. The value is
# often EMPTY (dispatch and standby shifts have no vehicle), and then the label
# sits alone at the end of its line, so the gap must be [ \t] and never \s:
# crossing the newline silently captures the next row and reports a parking
# space of "Driver notes" or "Sprinter 350".
PARKING_RE = re.compile(r"Parking space[ \t]+(?P<code>\S[^\n]*?)[ \t]*$", re.M)

# "Vehicle   Branch (72398) 2020 Toyota Sienna (7 Seats)   Parking space  ..."
# Present in 183 of 186 assignments, and what the driver needs when collecting
# the van. Stops at the two-space gap before the next column, so it never eats
# the parking space beside it.
VEHICLE_RE = re.compile(r"Vehicle[ \t]{2,}(?P<v>\S[^\n]*?)[ \t]{2,}\S", re.M)

# "WKL   ETA: 10:00 AM   ETD: 10:00 AM   Wallkill | 900 Red Mills Rd."
STOP_RE = re.compile(
    r"^\s*(?P<label>\S.*?)\s{2,}ETA:\s*(?P<eta>\d{1,2}:\d{2}\s*[AP]M)?\s*"
    r"ETD:\s*(?P<etd>\d{1,2}:\d{2}\s*[AP]M)?\s*(?P<place>[^|]*?)\s*\|\s*(?P<addr>.*)$")

TAGS = ("GBA", "GBD", "MED", "HO", "TD", "A", "D", "S")
TAG_RE = re.compile(r"(?:^|\s{2,})(" + "|".join(TAGS) + r")(?=\s|$)")

# re.M on every one of these: they are searched against a multi-line window, and
# without it "$" means end-of-STRING, so a field only matched when its line
# happened to be the last one in the window. That is why the same passenger
# showed a flight time at one step and not at the other.
TIME_CITY_RE = re.compile(r"Time/City:\s*(?P<time>\d{1,2}:\d{2}\s*[AP]M)\s*(?P<city>.*?)\s*$", re.M)
APPT_RE = re.compile(r"Appointment time:\s*(?P<time>\d{1,2}:\d{2}\s*[AP]M)")
ARRIVAL_TIME_RE = re.compile(r"Arrival time:\s*(?P<time>\d{1,2}:\d{2}\s*[AP]M)")
DURATION_RE = re.compile(r"Duration:\s*(?P<dur>.+?)\s*$", re.M)
ROUTE_RE = re.compile(r"Route:\s*(?P<route>.+?)\s*$", re.M)
FLIGHT_RE = re.compile(r"Airline/Flight:\s*(?P<rest>.+?)\s*$", re.M)
# A per-passenger note: "I will be bringing a small cart with me",
# "Cell is WhatsApp#". 76 of them, and the driver needs them.
ENTITY_NOTE_RE = re.compile(r"Notes:\s*(?P<note>.+?)\s*$", re.M)
PICKUP_RE = re.compile(r"^\s*(Pickup|Drop-off)\s*:\s*(?P<detail>.*?)\s*$")

# Trailing "  1" / "  2" is the Bags column bleeding into the Information cell.
BAGS_TAIL_RE = re.compile(r"\s{2,}(\d{1,2})\s*$")

KIND_FOR_TAG = {
    "A": "arrival", "GBA": "arrival",
    "D": "departure", "GBD": "departure",
    "MED": "appointment",
    "S": "shuttle",
}
# Real, ~1% of rows, and deliberately out of scope -- but reported, never
# silently miscounted as a passenger-less shift.
EXCLUDED_TAGS = {"TD": "train", "HO": "embassy/consulate"}


def extract(path):
    reader = pypdf.PdfReader(path)
    return "\n".join((p.extract_text(extraction_mode="layout") or "") for p in reader.pages)


def parse_dt(s):
    return datetime.strptime(" ".join(s.split()), DT_FMT)


def parse_tod(s):
    return datetime.strptime(s.replace(" ", ""), "%I:%M%p").time()


def strip_bags(s):
    m = BAGS_TAIL_RE.search(s)
    return (s[:m.start()].strip(), int(m.group(1))) if m else (s.strip(), None)


def parse_flight(rest):
    """'United Airlines UA 1068' / 'Delta Air Lines 114' -> (number, airline, why)."""
    rest, _bags = strip_bags(rest)
    rest = re.sub(r"\s+", " ", rest).strip()

    # Check this before looking for a number: "Non-Flight Pickup / Drop off"
    # carries no digits at all, and would otherwise be reported as a missing
    # flight number rather than recognised as having no flight by design.
    if airline_lookup(rest)[1] == "non-flight-pickup":
        return None, rest, "non-flight-pickup"

    # Codeshare: "United Airlines SN8807 or UA995". Prefer the code whose
    # prefix matches the named airline; otherwise take the last one listed.
    alts = []
    m_or = re.search(r"\bor\b", rest)
    if m_or:
        head, tail = rest[:m_or.start()].strip(), rest[m_or.end():].strip()
        alts = [c for c in re.findall(r"\b([A-Z]{2})\s?(\d{1,5})\b", tail)]
        rest = head

    # Case-insensitive: "Asiana oz221" is how one carrier really appears. A
    # word boundary is required before the prefix, so the last two letters of
    # "Caribbean 550" can't be mistaken for one.
    m = re.search(r"\b(?P<pfx>[A-Za-z]\w)\s?(?P<num>\d{1,5})\s*$", rest)
    if m and any(c.isalpha() for c in m.group("pfx")):
        name = rest[:m.start()].strip()
        number = f"{m.group('pfx').upper()}{int(m.group('num'))}"
        why = "prefix-inline"
    else:
        m = re.search(r"\b(?P<num>\d{1,5})\s*$", rest)
        if not m:
            return None, rest, "no-flight-number"
        name = rest[:m.start()].strip()
        iata, why = airline_lookup(name)
        if not iata:
            return None, name, why
        number = f"{iata}{int(m.group('num'))}"

    if alts:
        pref = [f"{p}{int(n)}" for p, n in alts if number.startswith(p)]
        chosen = pref[0] if pref else f"{alts[-1][0]}{int(alts[-1][1])}"
        return chosen, name, why + "+codeshare"
    return number, name, why


def parse_assignment(path):
    """Parse a PDF. A `.txt` path is read as already-extracted layout text, which
    is what the redacted fixtures are — so the test suite needs neither pypdf nor
    the real documents."""
    if path.lower().endswith(".txt"):
        with open(path, encoding="utf-8") as fh:
            return parse_text(fh.read(), os.path.basename(path))
    return parse_text(extract(path), os.path.basename(path))


def parse_text(text, source="<text>"):
    hm = HEADER_RE.search(text)
    sm = START_RE.search(text)
    if not hm or not sm:
        return None
    lines = text.split("\n")
    footers = FOOTER_RE.findall(text)

    park = PARKING_RE.search(text)
    park_code = park.group("code").strip() if park else None
    origin = park_code.split("-")[0] if park_code and re.match(r"^[A-Z]{3}-", park_code) else None

    doc = {
        "assignment": hm.group("num"),
        "parking": park_code,
        "origin": origin,
        "vehicle": (VEHICLE_RE.search(text).group("v").strip()
                    if VEHICLE_RE.search(text) else None),
        "driver": hm.group("driver").strip(),
        "start": parse_dt(sm.group("start")),
        "end": parse_dt(sm.group("end")),
        "printed": parse_dt(footers[-1]) if footers else None,
        "driver_notes": parse_notes(text),
        "source": source,
    }

    # --- stops, with dates resolved by walking the clock forward -------------
    stops = []
    cur_date = doc["start"].date()
    last_tod = None
    for i, line in enumerate(lines):
        if "ETA:" not in line or "|" not in line:
            continue
        if "(Unavailable)" in line:
            continue  # driver's own calendar, not a trip
        m = STOP_RE.match(line)
        if not m:
            continue
        label = m.group("label").strip()

        # ARRIVING and LEAVING can fall on different days. LGA in 369736 is
        # reached at 11:00 PM and left at 12:00 AM, so its eta belongs to the
        # 31st and its etd to the 1st. Anchoring the whole stop on one of them
        # dated the other wrongly -- and since a flight's date came from the
        # stop, the flight was tracked a day out and would never have resolved.
        # So walk both times in document order and keep both dates.
        eta_date = etd_date = cur_date
        for fld in ("eta", "etd"):
            raw = m.group(fld)
            if not raw:
                continue
            tod = parse_tod(raw)
            if last_tod is not None and tod < last_tod:
                cur_date += timedelta(days=1)
            last_tod = tod
            if fld == "eta":
                eta_date = cur_date
            else:
                etd_date = cur_date
        if not m.group("eta"):
            eta_date = etd_date
        if not m.group("etd"):
            etd_date = eta_date

        stops.append({
            "line": i, "label": label,
            "eta": m.group("eta"), "etd": m.group("etd"),
            "place": m.group("place").strip() or label,
            "addr": (m.group("addr") or "").strip() or None,
            # `date` stays the departure date, which is what the itinerary is
            # ordered by; `etaDate` is what anything about arriving must use.
            "date": etd_date,
            "etaDate": eta_date,
        })

    doc["date_ok"] = (not stops) or stops[-1]["date"] == doc["end"].date()

    # --- passenger rows -----------------------------------------------------
    rows = []
    for i, line in enumerate(lines):
        info = None
        for rx, key in ((FLIGHT_RE, "flight"), (ROUTE_RE, "route"),
                        (APPT_RE, "appt"), (ARRIVAL_TIME_RE, "arrival_time")):
            m = rx.search(line)
            if m:
                info = (key, m)
                break
        if not info:
            continue

        # The tag sits in its own narrow left column, but not on a fixed line:
        # when the Destination cell wraps ("Enterprise Rent A / Car") it lands
        # two or three lines below the name. Scan forward, stopping at the next
        # row's own info line so we can't steal its tag.
        tag = None
        cands = [line]
        for j in range(i + 1, min(i + 4, len(lines))):
            if any(rx.search(lines[j]) for rx in (FLIGHT_RE, ROUTE_RE, APPT_RE, ARRIVAL_TIME_RE)):
                break
            cands.append(lines[j])
        if i:
            cands.append(lines[i - 1])
        for cand in cands:
            tm = TAG_RE.search(cand[:30])
            if tm:
                tag = tm.group(1)
                break

        name = re.split(r"\s{2,}", line.strip())[0]
        name = TAG_RE.sub("", name).strip()
        if not re.match(r"^[A-Za-z'\-\. ]+,\s*\S", name):
            name = None

        # Continuations: Time/City and codeshare alternates land on later lines.
        window = "\n".join(lines[i:i + 4])
        rows.append({"line": i, "tag": tag, "name": name,
                     "kind_src": info[0], "raw": line.strip(), "window": window})

    doc["stops"] = stops
    doc["rows"] = rows
    doc["lines"] = lines
    return doc


INFO_LABELS = ("Airline/Flight:", "Route:", "Appointment time:", "Arrival time:", "Number:")


def row_endpoints(raw):
    """The Origin and Destination cells of a passenger row, as written.

    These beat the enclosing stop for working out where the driver is going: a
    row is printed TWICE, once under the pickup stop and once under the
    drop-off, so the stop it happens to sit under is only right half the time.
    A JFK departure filed under the Warwick pickup stop yields a 15-minute
    drive to an airport two hours away."""
    parts = [p for p in re.split(r"\s{2,}", raw.strip()) if p]
    idx = next((i for i, p in enumerate(parts)
                if any(lbl in p for lbl in INFO_LABELS)), None)
    if idx is None or idx < 3:
        return None, None
    return parts[idx - 2], parts[idx - 1]


def place_codes(doc):
    """The document's own place-name -> site-code map, taken from its stops
    ("EWR Newark" -> EWR). Self-contained, so no hand-maintained gazetteer."""
    out = {}
    for s in doc["stops"]:
        if s.get("place") and re.fullmatch(r"[A-Z]{3}", s["label"] or ""):
            out[s["place"].strip().lower()] = s["label"]
    return out


def code_for_place(doc, name):
    if not name:
        return None
    key = name.strip().lower()
    codes = place_codes(doc)
    if key in codes:
        return codes[key]
    head = name.strip().split()[0]
    return head if re.fullmatch(r"[A-Z]{3}", head) else None


# "     Drop-off :          A Front" -- layout mode puts a SPACE before the
# colon, so a startswith("Drop-off:") test matches nothing and every drop-off
# silently disappears.
ACTION_LINE = re.compile(r"^\s*(Pickup|Drop-off)\s*:\s*(?P<where>.*?)\s*$")


def actions_in(doc):
    """Every action bar in the document, as (line, verb, where)."""
    out = []
    for i, line in enumerate(doc["lines"]):
        m = ACTION_LINE.match(line)
        if m:
            out.append((i, m.group(1).upper(), (m.group("where") or "").strip()))
    return out


def dropoff_points(doc):
    """passenger name -> the drop-off point their row sits under.

    Each passenger can be set down somewhere different, even off the same
    flight: assignment 369736 drops one at A Front and one at B Carport."""
    acts = actions_in(doc)
    out = {}
    for row in doc["rows"]:
        name = row.get("name")
        if not name:
            continue
        prior = [a for a in acts if a[0] < row["line"]]
        if not prior:
            continue
        _line, verb, where = prior[-1]
        if verb == "DROP-OFF" and where:
            out.setdefault(name, where)
    return out


def party_key(doc, row, dropoffs=None):
    """What makes two rows the same party: **same surname, same flight, same
    drop-off point.**

    Half the passenger groups in the sample are parties rather than
    individuals -- 103 of 203, all travelling on the same flight -- so without
    grouping, a couple is two near-identical rows differing only in a given
    name.

    The drop-off point is the test that keeps it honest. Across 88 same-surname
    same-flight groups with a known door, every one went to the same door, so
    the rule costs nothing today. But the owner confirms a passenger can be set
    down somewhere of their own, and merging two people who part at the kerb
    would send the driver to one door with someone who belongs at another."""
    name = row.get("name") or ""
    surname = name.split(",")[0].strip() if "," in name else name
    fm = FLIGHT_RE.search(row["raw"])
    flight = fm.group("rest").strip()[:40] if fm else ""
    door = (dropoffs or {}).get(name)
    return (surname, flight, door)


def party_label(names):
    """'Boeck, Christian & Heidi' -- one row, because it is one pickup."""
    first = names[0]
    surname = first.split(",")[0].strip() if "," in first else first
    givens = [n.split(",", 1)[1].strip() for n in names if "," in n]
    givens = [g for g in givens if g]
    if not givens:
        return surname
    if len(givens) == 1:
        return f"{surname}, {givens[0]}"
    return f"{surname}, {', '.join(givens[:-1])} & {givens[-1]}"


SITE_CODE = re.compile(r"^[A-Z]{2,5}$")


def place_code_of(stop):
    """The drive-time key for a stop, or None when its label is free text.

    28 of 186 assignments have a stop whose label is a name rather than a code
    -- "Dispatch", "Enterprise Rent", and one PDF-spacing casualty that extracts
    as "Dr y LGA, JFK &". Passing those through as a placeCode looks up nothing
    and shows a truncated fragment where a site code belongs."""
    label = (stop or {}).get("label") or ""
    return label if SITE_CODE.match(label) else None


# "Phone:" sits on its own line with the number wrapped onto the next, the same
# shape as every other cell in this document. 1012 across the corpus.
PHONE_RE = re.compile(r"(?P<phone>\+?\d[\d\-\(\)\. ]{7,}\d)")


def entity_window(doc, row):
    """The lines belonging to one passenger row: from the row itself up to the
    next one.

    A fixed-size window was wrong in both directions -- it could run past this
    passenger into the next one's phone number, and it could stop short of this
    passenger's own Time/City, which is why the same person showed a flight time
    at one step and not at the other."""
    starts = sorted(r["line"] for r in doc["rows"] if r.get("name"))
    after = [s for s in starts if s > row["line"]]
    end = after[0] if after else len(doc["lines"])
    return "\n".join(doc["lines"][row["line"]:end])


def entity_phone(doc, row):
    """The passenger's number, or None.

    Operationally required, not a nicety: assignments arrive at 5pm and the
    driver has to reach every passenger before 9pm the night before, then again
    from the kerb until they are in the car. A number the driver has to retype
    from a PDF at 11pm is a number they will not use."""
    window = entity_window(doc, row)
    at = window.find("Phone:")
    if at == -1:
        return None
    m = PHONE_RE.search(window[at:])
    return " ".join(m.group("phone").split()) if m else None


def leg_minutes(doc, dest_code):
    """Dispatch's own planned drive to `dest_code`, from this document.

    The gap between the previous stop's ETD and this stop's ETA IS the travel
    time dispatch allowed for that leg -- it is where the whole drive-time table
    was derived from in the first place. Taken per-assignment it is strictly
    better than the table: it is dispatch's number for this specific run, at
    this time of day, rather than a median across months.

    It is also the answer for the four airports with no table entry at all.
    ALB, BDL, HPN and SWF never appear in the sample, so there is nothing to
    derive -- but the moment an assignment goes to one, that document carries
    its own timing and no lookup is needed."""
    if not dest_code:
        return None
    stops = doc.get("stops") or []
    for i, stop in enumerate(stops):
        if i == 0 or stop.get("label") != dest_code or not stop.get("eta"):
            continue
        prev = stops[i - 1]
        if not prev.get("etd"):
            continue
        # Clock arithmetic with wraparound, NOT the stops' resolved dates. A
        # stop's date is anchored on whichever time drove the rollover walk, and
        # for LGA in 369736 that is the ETD (12:00 AM, next day) while its ETA
        # is 11:00 PM the night before. Subtracting the dated values gave 1530
        # minutes and the leg was silently discarded. A leg is never more than a
        # few hours, so wraparound is unambiguous and the dates are irrelevant.
        arrive = parse_tod(stop["eta"])
        depart = parse_tod(prev["etd"])
        mins = ((arrive.hour * 60 + arrive.minute)
                - (depart.hour * 60 + depart.minute))
        if mins < 0:
            mins += 1440
        # An absurd gap means the stop order is not chronological, which Phase 0
        # found does happen on multi-leg routes. Refuse rather than hand back a
        # nonsense drive time.
        if 0 < mins <= 300:
            return mins
    return None


def stop_for_line(doc, line_no):
    prev = [s for s in doc["stops"] if s["line"] < line_no]
    return prev[-1] if prev else (doc["stops"][0] if doc["stops"] else None)


def build_jobs(doc):
    """Returns (jobs, issues)."""
    jobs, issues, seen = [], [], set()

    for row in doc["rows"]:
        tag = row["tag"]
        if tag in EXCLUDED_TAGS:
            issues.append(f"excluded {tag} ({EXCLUDED_TAGS[tag]}) row: {row['name'] or '?'}")
            continue
        kind = KIND_FOR_TAG.get(tag)
        if kind is None:
            issues.append(f"unrecognised row tag {tag!r} near line {row['line']}")
            continue

        stop = stop_for_line(doc, row["line"])
        # A flight belongs to the day it ARRIVES, which is not always the day
        # the driver leaves that stop -- see the etaDate comment in parse_text.
        date = ((stop or {}).get("etaDate") or (stop or {}).get("date")
                or doc["start"].date())
        job = {"passenger": row["name"], "note": None}
        # The drive is from where the vehicle is parked to where this job is,
        # not from a fixed base -- a quarter of these assignments start at
        # Fishkill rather than Warwick, and that is 15 minutes to Newark.
        job["originCode"] = doc.get("origin")
        # Where this job actually takes the driver. For a drop-off that's the
        # row's Destination; for a pickup the passenger is coming FROM the
        # airport, so it's the Origin. Falls back to the enclosing stop only
        # when the row has no usable columns.
        from_col, to_col = row_endpoints(row["raw"])
        wanted = from_col if kind == "arrival" else to_col
        dest_code = code_for_place(doc, wanted) or (stop or {}).get("label")
        # The document's own leg time wins: it is dispatch's number for this
        # exact run. The derived table is the fallback, for a job typed in by
        # hand where there is no assignment to ask.
        dm = leg_minutes(doc, dest_code)
        if dm is None:
            dm = drive_for(doc.get("origin"), dest_code)
        if dm is not None:
            job["driveMinutes"] = dm

        if kind in ("arrival", "departure"):
            fm = FLIGHT_RE.search(row["raw"])
            if not fm:
                issues.append(f"{tag} row with no Airline/Flight: {row['name'] or '?'}")
                continue
            rest = fm.group("rest")
            # Codeshare second half wraps onto the following line.
            tail = re.search(r"^\s*(?:or\s+)?([A-Z]{2}\s?\d{1,5})\s*$",
                             row["window"].split("\n")[1] if "\n" in row["window"] else "")
            if rest.rstrip().endswith("or") and tail:
                rest = rest + " " + tail.group(1)
            number, airline, why = parse_flight(rest)
            if not number and why == "non-flight-pickup":
                # A real pickup with no flight behind it -- the passenger made
                # their own way to the airport. Still a trip the driver must
                # make, so it becomes a fixed-time job at the stop rather than
                # being dropped for lacking a flight.
                etd = (stop or {}).get("eta") or (stop or {}).get("etd")
                if not etd:
                    issues.append(f"{tag} {row['name'] or '?'}: non-flight pickup with no stop time")
                    continue
                job.update({
                    "kind": "appointment",
                    "targetTime": f"{date.isoformat()} {parse_tod(etd).strftime('%H:%M')}",
                    "place": (stop or {}).get("place"),
                    "placeCode": place_code_of(stop),
                    "note": "Non-flight pickup",
                })
                key = ("appointment", job["targetTime"], row["name"], job.get("place"))
                if key not in seen:
                    seen.add(key)
                    jobs.append(job)
                continue
            if not number:
                issues.append(f"{tag} {row['name'] or '?'}: no flight number ({why}) from {rest!r}")
                continue
            tc = TIME_CITY_RE.search(row["window"])
            job.update({
                "kind": kind,
                "flightNumber": number,
                "date": date.isoformat(),
                "note": f"{airline}{' · ' + tc.group('city').strip() if tc else ''}".strip(" ·") or None,
            })
            key = (kind, number, date.isoformat(), row["name"])
        else:
            if kind == "appointment":
                tm = APPT_RE.search(row["window"]) or ARRIVAL_TIME_RE.search(row["window"])
                if not tm:
                    issues.append(f"MED row with no appointment time: {row['name'] or '?'}")
                    continue
                tod = parse_tod(tm.group("time"))
                dur = DURATION_RE.search(row["window"])
                place = (stop or {}).get("place")
                job.update({
                    "kind": "appointment",
                    "targetTime": f"{date.isoformat()} {tod.strftime('%H:%M')}",
                    "place": place,
                    "placeCode": place_code_of(stop),
                    "note": f"Duration: {dur.group('dur').strip()}" if dur else None,
                })
            else:  # shuttle -> a fixed-time job at the stop's ETD
                rm = ROUTE_RE.search(row["window"])
                etd = (stop or {}).get("etd") or (stop or {}).get("eta")
                if not etd:
                    issues.append(f"S row with no stop time: {row['name'] or '?'}")
                    continue
                tod = parse_tod(etd)
                job.update({
                    "kind": "appointment",
                    "targetTime": f"{date.isoformat()} {tod.strftime('%H:%M')}",
                    "place": (stop or {}).get("place"),
                    "placeCode": place_code_of(stop),
                    "note": f"Shuttle: {rm.group('route').strip()}" if rm else "Shuttle",
                })
            key = (job["kind"], job["targetTime"], row["name"], job.get("place"))

        if key in seen:
            continue  # same passenger repeats under pickup AND drop-off stops
        seen.add(key)
        jobs.append(job)

    # No jobs yet -> the assignment itself becomes one, so it still appears.
    #
    # This used to be skipped when every row was an excluded type, and the
    # result was that an assignment made ENTIRELY of TD or HO rows produced
    # nothing and vanished from the app completely. Real case: 366824 is a run
    # to the German embassy -- leave Fishkill 8:00 AM, wait 10:45 to 1:00, back
    # by 3:00 PM. A real day's work, and the driver would have opened Curbside
    # to an empty screen. Showing the shape of the assignment with its rows
    # named as unsupported is far better than showing nothing.
    if not jobs:
        jobs.append({
            "kind": "shift",
            "targetTime": doc["start"].strftime("%Y-%m-%d %H:%M"),
            "endTime": doc["end"].strftime("%Y-%m-%d %H:%M"),
            "place": doc["stops"][0]["place"] if doc["stops"] else None,
            "placeCode": place_code_of(doc["stops"][0]) if doc["stops"] else None,
            "note": doc["driver_notes"],
            "passenger": None,
            "originCode": doc.get("origin"),
        })

    if not doc["date_ok"]:
        issues.append("last stop date disagrees with the document's stated end date "
                      "-- multi-day rollover is a guess here, check it")
    return jobs, issues


ASSISTANT_HEAD = re.compile(r"^\s*Assistant\s{2,}Role\b")


def parse_assistants(doc):
    """The Assistant / Role / Notes table. Present in 48 of 186 assignments --
    Helper 13, Trainer 10, Other 7 -- and a run with a trainer aboard is a
    different shift from driving alone."""
    lines = doc["lines"]
    start = next((i for i, l in enumerate(lines) if ASSISTANT_HEAD.match(l)), None)
    if start is None:
        return []
    out = []
    for line in lines[start + 1:]:
        if not line.strip():
            if out:
                break
            continue
        if STOP_RE.match(line) or "ETA:" in line:
            break
        parts = [p for p in re.split(r"\s{2,}", line.strip()) if p]
        if not parts or not re.match(r"^[A-Z][A-Za-z'\-]+,", parts[0]):
            break
        out.append({"name": parts[0],
                    "role": parts[1] if len(parts) > 1 else None,
                    "note": parts[2] if len(parts) > 2 else None})
    return out


def build_assignment(doc):
    """The full four-level record: Assignment -> Step -> Action -> Entity.

    The flat job list this replaces could not hold an itinerary: a passenger
    appears at their pickup AND at their own drop-off, and dedupe threw the
    second away. That second appearance is the other half of the work."""
    doors = dropoff_points(doc)
    acts = actions_in(doc)
    total = len(doc["lines"])
    issues = []
    steps = []

    for i, stop in enumerate(doc["stops"]):
        nxt = doc["stops"][i + 1]["line"] if i + 1 < len(doc["stops"]) else total
        here = [a for a in acts if stop["line"] < a[0] < nxt]
        actions = []
        for n, (line_no, verb, where) in enumerate(here):
            end = here[n + 1][0] if n + 1 < len(here) else nxt
            rows = [r for r in doc["rows"]
                    if line_no < r["line"] < end and r.get("name")]
            groups = {}
            for row in rows:
                groups.setdefault(party_key(doc, row, doors), []).append(row)

            entities = []
            for members in groups.values():
                names, seen = [], set()
                for m in members:
                    if m["name"] not in seen:
                        seen.add(m["name"])
                        names.append(m["name"])
                first = members[0]
                tag = first.get("tag")
                win = entity_window(doc, first)
                entity = {
                    "name": party_label(names),
                    "pax": len(names),
                    "tag": tag,
                    "gb": bool(tag and tag.startswith("GB")),
                }
                origin, dest = row_endpoints(first["raw"])
                entity["origin"], entity["destination"] = origin, dest
                entity["phone"] = entity_phone(doc, first)
                note = ENTITY_NOTE_RE.search(win)
                if note:
                    entity["note"] = note.group("note").strip()

                if tag in EXCLUDED_TAGS:
                    entity["unsupported"] = EXCLUDED_TAGS[tag]
                    issues.append(f"{tag} row not yet supported: {entity['name']}")
                    entities.append(entity)
                    continue

                # Bags: the trailing column strip_bags already finds and then
                # discarded. It decides whether a party fits the vehicle, so it
                # is not decoration.
                _rest, bags = strip_bags(first["raw"])
                if bags is not None:
                    entity["bags"] = bags

                fm = FLIGHT_RE.search(first["raw"])
                if fm:
                    number, airline, why = parse_flight(fm.group("rest"))
                    entity["flightNumber"] = number
                    if not number and why not in ("non-flight-pickup",):
                        issues.append(f"{entity['name']}: could not resolve "
                                      f"{airline!r} ({why})")
                    tc = TIME_CITY_RE.search(win)
                    if tc:
                        entity["scheduledText"] = (
                            f"{tc.group('time').strip()} {tc.group('city').strip()}").strip()
                am = APPT_RE.search(win) or ARRIVAL_TIME_RE.search(win)
                if am:
                    entity["appointmentTime"] = am.group("time").strip()
                dur = DURATION_RE.search(win)
                if dur:
                    entity["duration"] = dur.group("dur").strip()
                rt = ROUTE_RE.search(win)
                if rt:
                    entity["route"] = rt.group("route").strip()
                entities.append(entity)

            actions.append({"verb": verb.title(), "where": where or None,
                            "entities": entities})

        steps.append({
            "code": place_code_of(stop),
            "place": stop.get("place") or stop.get("label"),
            "address": stop.get("addr") or None,
            "eta": stop.get("eta"), "etd": stop.get("etd"),
            "date": stop["date"].isoformat(),
            "etaDate": stop.get("etaDate", stop["date"]).isoformat(),
            "actions": actions,
        })

    if not doc["date_ok"]:
        issues.append("last stop date disagrees with the document's stated end date "
                      "-- check the multi-day rollover")

    gb = any(e.get("gb") for s in steps for a in s["actions"] for e in a["entities"])
    return {
        "number": doc["assignment"],
        "start": doc["start"].strftime("%Y-%m-%d %H:%M"),
        "end": doc["end"].strftime("%Y-%m-%d %H:%M"),
        "driver": doc.get("driver"),
        "vehicle": doc.get("vehicle"),
        "parking": doc.get("parking"),
        "originCode": doc.get("origin"),
        "driverNotes": doc.get("driver_notes"),
        "assistants": parse_assistants(doc),
        "steps": steps,
        "gb": gb,
        "issues": issues,
        "printedAt": doc["printed"].strftime("%Y-%m-%d %H:%M") if doc.get("printed") else None,
        "source": doc.get("source"),
    }


def post_assignment(list_code, assignment):
    body = dict(assignment)
    body["listCode"] = list_code
    req = urllib.request.Request(
        f"{API}/api/assignments", method="POST",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": "flightwatch-import/1.0"})
    with urllib.request.urlopen(req) as r:
        return r.status, json.loads(r.read().decode())


def post_job(list_code, job):
    body = dict(job)
    body["listCode"] = list_code
    body = {k: v for k, v in body.items() if v is not None}
    # An explicit User-Agent is required: Cloudflare answers 403 to urllib's
    # default "Python-urllib/3.x" before the Worker ever sees the request, so
    # the failure looks like an auth error rather than a bot filter.
    req = urllib.request.Request(
        f"{API}/api/flights", method="POST",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": "flightwatch-import/1.0"})
    with urllib.request.urlopen(req) as r:
        return r.status, json.loads(r.read().decode())


def collect(paths):
    out = []
    for p in paths:
        if os.path.isdir(p):
            out += sorted(glob.glob(os.path.join(p, "*.pdf")))
            out += sorted(glob.glob(os.path.join(p, "*.txt")))
        else:
            out.append(p)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--post", metavar="LIST_CODE")
    ap.add_argument("--audit", action="store_true")
    ap.add_argument("--assignments", action="store_true",
                    help="emit the full Assignment hierarchy instead of flat jobs")
    ap.add_argument("--post-assignment", metavar="LIST_CODE",
                    help="import assignments into a list")
    ap.add_argument("--drive-times", action="store_true",
                    help="derive a driveMinutes table from scheduled stop gaps")
    ap.add_argument("--save", action="store_true",
                    help="with --drive-times, write tools/drive_times.json")
    ap.add_argument("--since", help="only assignments starting on/after YYYY-MM-DD")
    args = ap.parse_args()

    # Latest version wins, keyed on the in-document assignment number.
    latest = {}
    unparsed = []
    for path in collect(args.paths):
        try:
            doc = parse_assignment(path)
        except Exception as e:  # noqa: BLE001
            unparsed.append((os.path.basename(path), repr(e)))
            continue
        if not doc:
            unparsed.append((os.path.basename(path), "no assignment header"))
            continue
        prev = latest.get(doc["assignment"])
        if prev is None or (doc["printed"] and prev["printed"] and doc["printed"] > prev["printed"]):
            latest[doc["assignment"]] = doc

    docs = sorted(latest.values(), key=lambda d: d["start"])
    if args.since:
        cutoff = datetime.strptime(args.since, "%Y-%m-%d").date()
        docs = [d for d in docs if d["start"].date() >= cutoff]

    if args.drive_times:
        # The department keeps official "approved travel times" in HuB, which we
        # don't have. But dispatch BUILDS every assignment from that table, so
        # the gap between one stop's ETD and the next stop's ETA is that table
        # expressed as real schedules. Medians, because a handful of gaps span
        # an overnight or a wait rather than a drive.
        import statistics
        pairs = {}
        for d in docs:
            for a, b in zip(d["stops"], d["stops"][1:]):
                if not a.get("etd") or not b.get("eta"):
                    continue
                mins = ((parse_tod(b["eta"]).hour * 60 + parse_tod(b["eta"]).minute)
                        - (parse_tod(a["etd"]).hour * 60 + parse_tod(a["etd"]).minute))
                if mins < 0:
                    mins += 1440
                if 0 < mins <= 300:
                    pairs.setdefault((a["label"], b["label"]), []).append(mins)
        print(f"{'from':<12}{'to':<12}{'n':>4}{'median':>8}{'min':>6}{'max':>6}")
        for (f, t), v in sorted(pairs.items(), key=lambda kv: -len(kv[1])):
            if len(v) < 2:
                continue
            print(f"{f:<12}{t:<12}{len(v):>4}{statistics.median(v):>8.0f}{min(v):>6.0f}{max(v):>6.0f}")
        # The app keys driveMinutes by destination alone, which only means
        # anything relative to a single origin -- the driver's base. So build
        # the table from legs that start at BASE, falling back to the return
        # leg when the outbound is thin. Pooling every leg arriving at a place
        # would mix origins and be quietly wrong: Tuxedo is 10 minutes from
        # Warwick and 40 from Newburgh, and the average of those is a number
        # that is right for no journey anyone actually makes.
        table = {}
        for dest in {t for _, t in pairs} | {f for f, _ in pairs}:
            if dest == BASE:
                continue
            out = pairs.get((BASE, dest), [])
            back = pairs.get((dest, BASE), [])
            legs = out if len(out) >= 2 else (out + back)
            if legs:
                table[dest] = round(statistics.median(legs))
        print(f"\ndriveMinutes from {BASE} (legs out of base, falling back to the return leg):")
        print(json.dumps(dict(sorted(table.items())), indent=2))
        missing = sorted(AIRPORTS - set(table))
        if missing:
            print(f"\nNo data for: {', '.join(missing)} -- these never appear in the sample "
                  f"and must come from the department's own table, not from a guess.")

        # Persist the ORIGIN-AWARE table too. The per-destination one above is
        # only correct from base; this is what lets an imported job carry the
        # drive time for the site its vehicle is actually parked at.
        if args.save:
            pair_table = {f"{f}>{t}": round(statistics.median(v))
                          for (f, t), v in sorted(pairs.items()) if len(v) >= 2}
            out = {"base": BASE, "fromBase": dict(sorted(table.items())), "pairs": pair_table}
            with open(DRIVE_TIMES_PATH, "w", encoding="utf-8") as fh:
                json.dump(out, fh, indent=2)
            print(f"\nwrote {DRIVE_TIMES_PATH} ({len(pair_table)} origin-aware pairs)")
        return

    if args.assignments or args.post_assignment:
        for d in docs:
            assignment = build_assignment(d)
            if args.post_assignment:
                status, resp = post_assignment(args.post_assignment, assignment)
                applied = resp.get("applied")
                note = ("replaced an older copy" if resp.get("replaced") else "new")
                if not applied:
                    note = resp.get("reason", "not applied")
                print(f"  {assignment['number']}  HTTP {status}  {note}"
                      f"  ({resp.get('flightsTracked', 0)} flight(s) tracked)")
            else:
                print(json.dumps(assignment, indent=2))
            for issue in assignment["issues"]:
                print(f"     ! {issue}", file=sys.stderr)
        return 0

    if args.audit:
        kinds, issues_all, with_jobs = {}, [], 0
        for d in docs:
            jobs, issues = build_jobs(d)
            if jobs:
                with_jobs += 1
            for j in jobs:
                kinds[j["kind"]] = kinds.get(j["kind"], 0) + 1
            issues_all += [f"{d['assignment']}: {i}" for i in issues]
        print(f"files unparsed:      {len(unparsed)}")
        print(f"unique assignments:  {len(latest)}")
        print(f"produced jobs:       {with_jobs}")
        print("jobs by kind:")
        for k, v in sorted(kinds.items()):
            print(f"   {v:5d}  {k}")
        print(f"issues: {len(issues_all)}")
        for i in issues_all[:25]:
            print("   ", i)
        if len(issues_all) > 25:
            print(f"    ... and {len(issues_all) - 25} more")
        for fn, why in unparsed:
            print(f"   UNPARSED {fn}: {why}")
        return

    for d in docs:
        jobs, issues = build_jobs(d)
        print(json.dumps({
            "assignment": d["assignment"],
            "source": d["source"],
            "start": d["start"].strftime("%Y-%m-%d %H:%M"),
            "printed": d["printed"].strftime("%Y-%m-%d %H:%M") if d["printed"] else None,
            "jobs": jobs,
            "issues": issues,
        }, indent=2))
        if args.post:
            for job in jobs:
                status, resp = post_job(args.post, job)
                print(f"  POST {job['kind']} -> HTTP {status}", file=sys.stderr)


if __name__ == "__main__":
    main()
