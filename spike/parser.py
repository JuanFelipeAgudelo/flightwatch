"""
FlightWatch Phase 0 parser spike.

Reads the TRNP assignment PDFs, emits JSON, and answers the five spike
questions. Throwaway script — not part of the shipped app.
"""
import csv
import glob
import json
import os
import re
import sys
from datetime import datetime, timedelta

import pypdf

ROOT = os.path.dirname(os.path.abspath(__file__))
PDF_DIR = os.path.join(ROOT, "pdfs", "TRNP Assigments")
MANIFEST = os.path.join(PDF_DIR, "_manifest.csv")

# ---------------------------------------------------------------- extraction

def extract_text(path):
    reader = pypdf.PdfReader(path)
    pages = [p.extract_text() or "" for p in reader.pages]
    return "\n".join(pages), pages


HEADER_RE = re.compile(
    r"Assignment number (?P<num>\d+)\s+Driver (?P<driver>.+?)\s*\n"
    r"Start date and time (?P<start>[A-Za-z]+, [A-Za-z]+ \d{1,2}, \d{4} \d{1,2}:\d{2} [AP]M)\s+"
    r"End date and time (?P<end>[A-Za-z]+, [A-Za-z]+ \d{1,2}, \d{4} \d{1,2}:\d{2} [AP]M)"
)

PRINT_FOOTER_RE = re.compile(
    r"([A-Za-z]+, [A-Za-z]+ \d{1,2}, \d{4} \d{1,2}:\d{2} [AP]M) Page \d+ of \d+"
)

DT_FMT = "%A, %B %d, %Y %I:%M %p"


def parse_dt(s):
    return datetime.strptime(s, DT_FMT)


def parse_header(text):
    m = HEADER_RE.search(text)
    if not m:
        return None
    return {
        "assignment_number": m.group("num"),
        "driver": m.group("driver").strip(),
        "start": parse_dt(m.group("start")),
        "end": parse_dt(m.group("end")),
    }


def parse_print_footer(text):
    # Last footer timestamp in the doc = when it was generated/sent.
    matches = PRINT_FOOTER_RE.findall(text)
    if not matches:
        return None
    try:
        return parse_dt(matches[-1])
    except ValueError:
        return None


# ------------------------------------------------------------------ classify

def classify(text):
    has_air = "Airline/Flight:" in text
    has_med = "Appointment time:" in text
    has_shuttle = "Route:" in text
    tags = [t for t, present in
            [("airport", has_air), ("medical", has_med), ("shuttle", has_shuttle)]
            if present]
    if len(tags) > 1:
        return "mixed:" + "+".join(tags)
    if tags:
        return tags[0]
    return "shift"


# --------------------------------------------------------------------- stops

STOP_LINE_RE = re.compile(
    r"^(?P<prefix>.*?)\s*ETA:\s*(?P<eta>\d{1,2}:\d{2}\s*[AP]M)?\s*"
    r"ETD:\s*(?P<etd>\d{1,2}:\d{2}\s*[AP]M)?\s*(?P<name>[^|]*?)\s*\|\s*(?P<address>.*)$"
)
CLEAN_CODE_RE = re.compile(r"^[A-Z]{2,5}$")


def parse_stops(text):
    stops = []
    for line in text.split("\n"):
        line = line.strip()
        if "ETA:" not in line or "|" not in line:
            continue
        m = STOP_LINE_RE.match(line)
        if not m:
            continue
        prefix = m.group("prefix").strip()
        name = m.group("name").strip() or prefix
        code = prefix if CLEAN_CODE_RE.match(prefix) else None
        stops.append({
            "code": code,
            "raw_prefix": prefix,
            "eta": m.group("eta").strip() if m.group("eta") else None,
            "etd": m.group("etd").strip() if m.group("etd") else None,
            "name": name,
            "address": m.group("address").strip(),
        })
    return stops


def resolve_stop_dates(stops, start_dt, end_dt):
    """Infer a full date for every stop time, walking in document order and
    rolling to the next day whenever the clock appears to go backwards.
    Returns (resolved_stops, matches_end_date: bool, rollovers: int)."""
    current_date = start_dt.date()
    last_tod = None
    resolved = []
    rollovers = 0
    for s in stops:
        for field in ("eta", "etd"):
            t = s.get(field)
            if not t:
                continue
            tod = datetime.strptime(t.replace(" ", ""), "%I:%M%p").time()
            if last_tod is not None and tod < last_tod:
                # clock went backwards -> assume next calendar day
                current_date += timedelta(days=1)
                rollovers += 1
            last_tod = tod
            resolved.append({
                "stop": s["code"] or s["name"],
                "field": field,
                "time": t,
                "resolved_date": current_date.isoformat(),
            })
    matches_end = bool(resolved) and resolved[-1]["resolved_date"] == end_dt.date().isoformat()
    return resolved, matches_end, rollovers


# ------------------------------------------------------------------ flights

# "Airline/Flight: <Airline Name...> <FlightCode>" where FlightCode is either
# an IATA-prefixed code (UA1992) or bare digits (1856) when the prefix is
# omitted. A trailing " <digit>" on the same line is the Bags column bleeding
# in from the table layout, not part of the flight code.
FLIGHT_LINE_RE = re.compile(
    r"Airline/Flight:\s*(?P<rest>.+)$"
)
FLIGHT_CODE_RE = re.compile(r"(?P<code>[A-Z]{1,2}\d{2,5}|\d{2,5})(?:\s+\d)?\s*$")

AIRLINE_IATA = {
    "united airlines": "UA",
    "american airlines": "AA",
    "delta": "DL",
    "delta air lines": "DL",
    "jetblue": "B6",
    "jetblue airways": "B6",
    "southwest airlines": "WN",
    "alaska airlines": "AS",
    "spirit airlines": "NK",
    "frontier airlines": "F9",
    "air canada": "AC",
}


def parse_flight_lines(text):
    out = []
    for line in text.split("\n"):
        if "Airline/Flight:" not in line:
            continue
        m = FLIGHT_LINE_RE.search(line)
        if not m:
            continue
        rest = m.group("rest").strip()
        code_m = FLIGHT_CODE_RE.search(rest)
        code = code_m.group("code") if code_m else None
        airline_part = rest[:code_m.start()].strip() if code_m else rest
        out.append({"raw": rest, "airline": airline_part, "code": code})
    return out


def normalize_flight_code(airline_name, code):
    """Best-effort DL0114 -> DL114 / 1856+United -> UA1856 normalisation."""
    if code is None:
        return None, "no-code"
    m = re.match(r"^([A-Z]{1,2})0*(\d+)$", code)
    if m:
        prefix, digits = m.groups()
        return f"{prefix}{digits}", "prefixed"
    if re.match(r"^\d+$", code):
        iata = AIRLINE_IATA.get(airline_name.lower().strip())
        if iata:
            return f"{iata}{code.lstrip('0') or '0'}", "inferred-from-airline-name"
        return code, "bare-digits-no-airline-match"
    return code, "unrecognised"


# --------------------------------------------------------------------- main

def load_manifest():
    with open(MANIFEST, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    return [r for r in rows if re.fullmatch(r"\d+", r["assignment"])]


def resolve_disk_path(filename, seen_counter):
    """Manifest rows can repeat the same filename for re-sends; disk uses
    ' (1)', ' (2)' suffixes for the 2nd, 3rd, ... occurrence."""
    n = seen_counter[filename]
    seen_counter[filename] += 1
    if n == 0:
        candidate = filename
    else:
        base, ext = os.path.splitext(filename)
        candidate = f"{base} ({n}){ext}"
    path = os.path.join(PDF_DIR, candidate)
    return path if os.path.exists(path) else None


def main():
    rows = load_manifest()
    seen_counter = {}
    for r in rows:
        seen_counter.setdefault(r["file"], 0)
    from collections import defaultdict
    counter = defaultdict(int)

    results = []
    failures = []

    for r in rows:
        path = resolve_disk_path(r["file"], counter)
        record = {
            "email_no": r["email_no"],
            "manifest_assignment": r["assignment"],
            "file": r["file"],
            "disk_path": path,
        }
        if path is None:
            record["error"] = "file-not-found-on-disk"
            failures.append(record)
            results.append(record)
            continue
        try:
            text, pages = extract_text(path)
        except Exception as e:
            record["error"] = f"extract-failed: {e}"
            failures.append(record)
            results.append(record)
            continue

        header = parse_header(text)
        if header is None:
            record["error"] = "header-parse-failed"
            failures.append(record)
            results.append(record)
            continue

        template = "AssignmentDetails" if "Assignment Details.pdf" in r["file"] else "TransportationAssignmentReport"
        kind = classify(text)
        stops = parse_stops(text)
        if not stops:
            record["error"] = "no-stops-found"
            failures.append(record)

        resolved, matches_end, rollovers = resolve_stop_dates(stops, header["start"], header["end"]) if stops else ([], False, 0)
        flights = parse_flight_lines(text) if kind == "airport" else []
        normalized_flights = [
            {**fl, **dict(zip(("normalized", "method"), normalize_flight_code(fl["airline"], fl["code"])))}
            for fl in flights
        ]
        print_footer = parse_print_footer(text)

        record.update({
            "template_by_filename": template,
            "assignment_number": header["assignment_number"],
            "assignment_number_matches_manifest": header["assignment_number"] == r["assignment"],
            "driver": header["driver"],
            "start": header["start"].isoformat(),
            "end": header["end"].isoformat(),
            "spans_midnight": header["start"].date() != header["end"].date(),
            "print_footer": print_footer.isoformat() if print_footer else None,
            "kind": kind,
            "num_stops": len(stops),
            "stops": stops,
            "date_resolution": resolved,
            "date_resolution_matches_end_date": matches_end,
            "rollovers_detected": rollovers,
            "flights": normalized_flights,
            "num_pages": len(pages),
        })
        results.append(record)

    out_path = os.path.join(ROOT, "parsed_results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, default=str)

    print(f"Total manifest assignment-PDF rows: {len(rows)}")
    print(f"Parsed with header+stops OK: {len(results) - len(failures)}")
    print(f"Failures: {len(failures)}")
    for f in failures:
        print("  FAIL", f["file"], "->", f.get("error"))
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
