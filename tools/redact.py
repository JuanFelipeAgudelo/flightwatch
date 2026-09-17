"""Turn real assignment PDFs into committable test fixtures.

    python tools/redact.py "<pdf dir>"            # regenerate tools/fixtures/
    python tools/redact.py "<pdf dir>" --check     # verify no PII slipped through

The real documents carry passenger names, mobile numbers, hospital destinations
and internal email addresses, so they can never be committed. The parser still
needs to be pinned against real structure, because every bug it has had came
from structure rather than content: a timestamp wrapping mid-value, an empty
parking cell, a passenger row printed twice, a codeshare split across lines.

So fixtures are the *layout-extracted text* with identities replaced, saved as
`.txt`. `parse_assignment()` reads a `.txt` path as already-extracted text, so
the suite needs neither pypdf nor the originals.

THE ONE RULE THAT MATTERS
-------------------------
Layout text is column-sensitive: the parser reads Origin and Destination by
splitting on runs of two-plus spaces, and decides a parking cell is empty by
whether anything follows the label on that line. So every replacement is padded
or truncated to **exactly the length of what it replaced**. A fake name one
character longer would shift a column and quietly stop reproducing the very bug
the fixture exists to pin.

WHAT IS KEPT, AND WHY
---------------------
Facility names (NYP Allen, NYU Langone) stay. They are drive-time keys and
operational structure, and once every passenger name and phone number is gone
they identify nobody. Sites, airports, flight numbers, times and airline strings
all stay -- they are the structure under test.
"""
import argparse
import glob
import hashlib
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")

# Stable fake identities. Same input always yields the same fake, so a
# regenerated fixture set produces a clean diff rather than noise.
# Ordinary surnames and given names, deliberately unremarkable. An earlier pool
# (Stallybrass, Ravensworth, Thorncroft) read as invented, which snags the eye
# in a fixture diff and looks wrong if a screen is ever shown to anyone. Short
# entries come first so a narrow cell still gets a whole name rather than a
# truncated one.
SURNAMES = ["Best", "Cole", "Diaz", "Ford", "Grant", "Hale", "Ibarra", "Jonas",
            "Keller", "Lucas", "Mendez", "Novak", "Owens", "Pratt", "Quinn",
            "Reyes", "Sutton", "Tanaka", "Vargas", "Warner", "Alvarez",
            "Brennan", "Okafor", "Whitaker", "Sandoval", "Donnelly"]
GIVENS = ["Ana", "Ben", "Cruz", "Dana", "Eli", "Faye", "Gil", "Hana", "Ivan",
          "Jude", "Kira", "Leon", "Mara", "Nils", "Omar", "Pia", "Rosa",
          "Sam", "Tess", "Vera", "Marcus", "Daniela", "Theo", "Noor"]


def _pick(pool, seed):
    h = int(hashlib.sha256(seed.strip().lower().encode()).hexdigest(), 16)
    return pool[h % len(pool)]


def fit(replacement, original):
    """Same-length replacement. Pad with spaces if short, truncate if long --
    but never leave a trailing comma or space inside the name itself, because a
    mangled 'Ostrowski, ' is re-matched by the next pass, which then reads the
    NEXT COLUMN as the given name and pads the real cell away. That bug cost a
    fixture its Origin cell before this rstrip existed."""
    n = len(original)
    if len(replacement) > n:
        replacement = replacement[:n].rstrip(" ,.-")
    return replacement + " " * (n - len(replacement))


def fake_person(original):
    """'Trevis, Mitchell' -> 'Harkaway, Bruno', in exactly the same width.

    Candidates are tried shortest-first so a narrow cell still gets a plausible
    whole name rather than a truncated one."""
    txt = original.strip()
    width = len(txt)
    if "," in txt:
        last, first = (p.strip() for p in txt.split(",", 1))
        seed_a, seed_b, sep = last, (first or last), ", "
    else:
        seed_a, seed_b, sep = txt, txt, " "
    # Rotate each pool from its seeded position, so the choice is stable per
    # input but we can still fall back to a shorter entry that fits.
    def rotated(pool, seed):
        i = int(hashlib.sha256(seed.strip().lower().encode()).hexdigest(), 16) % len(pool)
        return pool[i:] + pool[:i]

    surnames = rotated(SURNAMES, seed_a)
    givens = rotated(GIVENS, seed_b)
    for cand in (f"{s}{sep}{g}" for s in surnames for g in givens):
        if len(cand) <= width:
            return fit(cand, original)
    return fit(f"{surnames[0]}{sep}{givens[0]}", original)


# A person's name in the left column of a passenger row, after "Driver", or in
# the assistant table. One pattern covers all three -- two overlapping patterns
# is what let a half-redacted name get re-matched.
# `,[ ]{1,2}` and not `,\s+`: a greedy run of spaces reaches across the gap into
# the Origin column, and then "LGA" reads as a given name.
NAME_CELL = re.compile(r"(?<=\s)([A-Z][A-Za-z'\-]+,[ ]{1,2}[A-Z][A-Za-z'\-.]*(?:[ ][A-Z][A-Za-z'\-.]*)?)(?=[ ]{2,}|[ ]*$)")
DRIVER_LINE = re.compile(r"(Driver[ ]{2,})([A-Z][A-Za-z'\-]+,[ ]{1,2}[^\n]*?)([ ]*$)", re.M)
# Tight on purpose. A loose class like [\d\-\(\). ]{8,} spans the gap BETWEEN
# columns and swallows whatever is next -- it ate a vehicle id ("Branch (72398)")
# and a flight number ("UA 1503") on the first run. Only real phone shapes, and
# never more than one space.
PHONE = re.compile(
    r"\+\d{1,2} \d{3}[\-\. ]\d{3}[\-\. ]\d{4}"   # +1 323-580-4884
    r"|\(\d{3}\) ?\d{3}[\-\. ]\d{4}"             # (323) 580-4884
    r"|\b\d{3}[\-\.]\d{3}[\-\.]\d{4}\b")         # 323-580-4884
EMAIL = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")


def redact(text):
    out = text

    def _name(m):
        return fake_person(m.group(1))

    out = DRIVER_LINE.sub(lambda m: m.group(1) + fake_person(m.group(2)) + m.group(3), out)
    out = NAME_CELL.sub(_name, out)
    # Phone and email are replaced with same-length filler so the Information
    # column keeps its geometry.
    out = PHONE.sub(lambda m: fit("+1 555-0100-000", m.group(0)), out)
    out = EMAIL.sub(lambda m: fit("redacted@example.invalid", m.group(0)), out)
    return out


# The fixtures worth keeping: one per structural fact the parser has been wrong
# about, plus the ordinary cases. Keyed by in-document assignment number.
WANTED = {
    "369736": "combo-and-double-printed-rows",
    "375126": "timestamp-wraps-mid-value",
    "373621": "dispatch-shift-no-vehicle",
    "334184": "notes-are-a-timed-itinerary",
    "366222": "shuttle-with-notes-and-steps",
    "348400": "departure-with-inline-iata",
    "350568": "excluded-ho-and-non-flight",
    "352711": "airline-name-needs-table",
    "353328": "notes-multi-paragraph-with-email",
    "361028": "date-rollover-disagrees-with-end",
    "356385": "non-flight-pickup-drop-off",
    "340343": "row-endpoints-beat-enclosing-stop",
    "366824": "all-rows-excluded-must-still-appear",
    "341156": "action-with-no-location",
    "339460": "shuttle-with-named-passenger-rows",
}

LEAK = [
    ("phone", re.compile(r"\+1\s*(?!555)\d{3}[\-\. ]\d{3}[\-\. ]\d{4}")),
    ("email", re.compile(r"[A-Za-z0-9._%+\-]+@(?!example\.invalid)[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdfdir")
    ap.add_argument("--check", action="store_true",
                    help="scan existing fixtures for anything that looks like PII")
    args = ap.parse_args()

    if args.check:
        bad = 0
        for f in sorted(glob.glob(os.path.join(FIXTURES, "*.txt"))):
            body = open(f, encoding="utf-8").read()
            for label, rx in LEAK:
                for hit in rx.findall(body):
                    print(f"  LEAK {label} in {os.path.basename(f)}: {hit!r}")
                    bad += 1
        print("clean" if not bad else f"{bad} suspected leaks")
        return 0 if not bad else 1

    import pypdf  # only needed when regenerating

    os.makedirs(FIXTURES, exist_ok=True)
    seen = {}
    for p in sorted(glob.glob(os.path.join(args.pdfdir, "*.pdf"))):
        try:
            text = "\n".join((pg.extract_text(extraction_mode="layout") or "")
                             for pg in pypdf.PdfReader(p).pages)
        except Exception as e:  # noqa: BLE001
            print(f"  skip {os.path.basename(p)}: {e!r}")
            continue
        m = re.search(r"Assignment number\s+(\d+)", text)
        if not m or m.group(1) not in WANTED:
            continue
        num = m.group(1)
        # Several files can hold the same assignment; keep the longest, which is
        # the one with the most structure to test against.
        if num in seen and len(seen[num]) >= len(text):
            continue
        seen[num] = text

    for num, text in sorted(seen.items()):
        name = f"{num}-{WANTED[num]}.txt"
        with open(os.path.join(FIXTURES, name), "w", encoding="utf-8", newline="\n") as fh:
            fh.write(redact(text))
        print(f"  wrote {name}")

    missing = sorted(set(WANTED) - set(seen))
    if missing:
        print(f"  NOT FOUND in that directory: {', '.join(missing)}")
    print(f"{len(seen)} fixtures written to {FIXTURES}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
