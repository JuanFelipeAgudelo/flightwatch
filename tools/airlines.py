"""Airline name -> IATA code.

Closed set, built from every distinct airline string in a 249-assignment sample
(23 of them). Deliberately NOT a general-purpose airline database: an unknown
name is reported for confirmation rather than guessed at, because a wrong IATA
code produces a *plausible* flight number for the wrong flight, which is worse
than no flight number at all.

Phase 0 established that ~81% of flight lines give the number as bare digits
qualified only by this free-text name ("United Airlines 1856"), so this table is
on the critical path for most airport rows. The remaining ~19% carry the prefix
inline ("United Airlines UA 1068") and don't need it.

Several entries are self-confirming: the source string embeds the code the table
maps to ("Korean Air Lines KE", "JetBlue Airways B6", "Asiana oz").
"""

AIRLINE_IATA = {
    "aero mexico": "AM",
    "air canada": "AC",
    "alaska airlines": "AS",
    "american airlines": "AA",
    "arajet": "DM",
    "asiana": "OZ",
    "asiana oz": "OZ",
    "british airways": "BA",
    "caribbean": "BW",  # Caribbean Airlines
    "cathay pacific airways": "CX",
    "delta": "DL",
    "delta air lines": "DL",
    "eva airways": "BR",
    "finnair": "AY",
    "jetblue": "B6",
    "jetblue airways": "B6",
    "korean air": "KE",
    "korean air lines": "KE",
    "lufthansa": "LH",
    "porter airlines": "PD",
    "qantas airways": "QF",
    "singapore airlines": "SQ",
    "southwest airlines": "WN",
    "sun country": "SY",
    "turkish": "TK",  # Turkish Airlines
    "turkish airlines": "TK",
    "united airlines": "UA",
}

# Not an airline: dispatch writes this in the Airline/Flight column when the
# pickup has no flight behind it. Several wordings appear ("Non-Flight Pickup",
# "Non-Flight Pickup / Drop off", "... NA"), so match on the stem.
NON_FLIGHT_STEM = "non-flight pickup"


def _is_iata(token: str) -> bool:
    """An IATA airline code is two chars, alphanumeric, at least one letter --
    B6, F9 and 9W are all real. `str.isalpha()` is the wrong test and silently
    dropped every carrier with a digit in its code."""
    return len(token) == 2 and token.isalnum() and any(c.isalpha() for c in token)


def lookup(name: str):
    """Returns (iata, reason). iata is None when we refuse to guess."""
    key = " ".join(name.lower().split())
    if not key:
        return None, "no-airline-name"
    if key.startswith(NON_FLIGHT_STEM):
        return None, "non-flight-pickup"
    if key in AIRLINE_IATA:
        return AIRLINE_IATA[key], "table"
    # "United Airlines UA" / "Asiana oz" — the string carries its own code as
    # the last token, in either case.
    tail = key.split()[-1].upper()
    if _is_iata(tail):
        stem = " ".join(key.split()[:-1])
        if stem in AIRLINE_IATA:
            return (tail, "table+inline-agree") if AIRLINE_IATA[stem] == tail \
                else (AIRLINE_IATA[stem], "table-wins-over-inline")
        return tail, "inline-code-only"
    return None, "unknown-airline"
