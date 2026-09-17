"""Parser regression suite.

    python tools/test_parser.py

stdlib unittest only -- no pytest, no pypdf, no real documents. Every fixture in
tools/fixtures/ is redacted layout text of a real assignment, named for the
structural fact it pins.

Each test below corresponds to a bug that actually shipped. The parser has never
been wrong about *content*; it has been wrong about *structure* -- a timestamp
wrapping mid-value, an empty table cell, a row printed twice, a greedy `\\s+`
reaching across a column gap. Those are exactly the failures that survive a
casual read and that manual checking missed.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from airlines import lookup  # noqa: E402
from import_assignment import (  # noqa: E402
    actions_in, build_assignment, build_jobs, code_for_place, dropoff_points,
    leg_minutes,
    parse_assignment, parse_flight, party_key, party_label, row_endpoints,
)

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def fixture(stem):
    for name in os.listdir(FIXTURES):
        if name.startswith(stem):
            return parse_assignment(os.path.join(FIXTURES, name))
    raise AssertionError(f"no fixture starting {stem!r}")


def jobs_of(stem):
    doc = fixture(stem)
    return doc, *build_jobs(doc)


class Fixtures(unittest.TestCase):
    def test_every_fixture_parses(self):
        names = [n for n in os.listdir(FIXTURES) if n.endswith(".txt")]
        self.assertGreaterEqual(len(names), 12, "fixtures are missing")
        for name in names:
            with self.subTest(name):
                doc = parse_assignment(os.path.join(FIXTURES, name))
                self.assertIsNotNone(doc, "returned None")
                self.assertTrue(doc["assignment"].isdigit())
                self.assertIsNotNone(doc["printed"], "no page-footer timestamp")

    def test_fixtures_carry_no_obvious_pii(self):
        for name in os.listdir(FIXTURES):
            body = open(os.path.join(FIXTURES, name), encoding="utf-8").read()
            with self.subTest(name):
                self.assertNotIn("@bethel", body)
                self.assertNotRegex(body, r"\+1 (?!555)\d{3}-\d{3}-\d{4}")


class Header(unittest.TestCase):
    def test_timestamp_wrapping_mid_value_still_parses(self):
        """'...September 16, 2026 12:00' / newline / 'PM'. A literal space in
        the date pattern skipped the whole assignment -- both copies of this
        one, on the day it was the live job."""
        doc = fixture("375126")
        self.assertEqual(doc["start"].strftime("%Y-%m-%d %H:%M"), "2026-09-16 07:45")
        self.assertEqual(doc["end"].strftime("%Y-%m-%d %H:%M"), "2026-09-16 12:00")

    def test_empty_parking_cell_is_not_the_next_row(self):
        """A dispatch shift has no vehicle, so the label sits alone at line end.
        A `\\s+` after it captured the following row and reported a parking
        space of 'Driver notes' or 'Sprinter 350'."""
        doc = fixture("373621")
        self.assertIsNone(doc["origin"])
        for bad in ("Driver notes", "Sprinter", "Seats"):
            if doc["parking"]:
                self.assertNotIn(bad, doc["parking"])

    def test_parking_prefix_is_the_origin_site(self):
        doc = fixture("369736")
        self.assertTrue(doc["parking"].startswith("FKL-NBD"))
        self.assertEqual(doc["origin"], "FKL")


class Notes(unittest.TestCase):
    def test_notes_are_not_truncated_to_one_line(self):
        """96 of 186 real notes run to several lines. Reading only the first
        made '10% of notes contain a time' look true when it is 34%."""
        doc = fixture("334184")
        self.assertIn("\n", doc["driver_notes"])
        self.assertIn("7:45a", doc["driver_notes"])
        self.assertIn("Depart WRK Lobby for HUB", doc["driver_notes"])

    def test_notes_stop_before_the_next_section(self):
        doc = fixture("353328")
        self.assertIsNotNone(doc["driver_notes"])
        self.assertNotIn("Assistant", doc["driver_notes"])
        self.assertNotIn("ETA:", doc["driver_notes"])


class Steps(unittest.TestCase):
    def test_unavailable_rows_are_not_stops(self):
        doc = fixture("369736")
        for s in doc["stops"]:
            self.assertNotIn("Unavailable", s["label"])

    def test_first_step_has_no_eta_and_last_no_etd(self):
        doc = fixture("369736")
        self.assertIsNone(doc["stops"][0]["eta"])
        self.assertIsNone(doc["stops"][-1]["etd"])

    def test_overnight_assignment_rolls_the_date_forward(self):
        """9:30 PM to 3:00 AM. The clock going backwards means the next day."""
        doc = fixture("369736")
        self.assertEqual(doc["stops"][0]["date"].isoformat(), "2026-08-31")
        self.assertEqual(doc["stops"][-1]["date"].isoformat(), "2026-09-01")
        self.assertTrue(doc["date_ok"], "last stop should match the stated end date")

    def test_a_disagreeing_rollover_is_reported_not_hidden(self):
        doc = fixture("361028")
        _jobs, issues = build_jobs(doc)
        self.assertTrue(any("end date" in i for i in issues),
                        f"expected a flagged date disagreement, got {issues}")


class Assignments(unittest.TestCase):
    """The four-level record the app stores: Assignment -> Step -> Action ->
    Entity. The flat job list it replaces could not hold an itinerary."""

    def test_the_itinerary_survives(self):
        a = build_assignment(fixture("369736"))
        self.assertEqual([s["code"] for s in a["steps"]], ["FKL", "LGA", "WKL", "FKL"])
        lga = a["steps"][1]
        wkl = a["steps"][2]
        self.assertEqual(len(lga["actions"]), 1, "one pickup at LGA")
        self.assertEqual(len(wkl["actions"]), 2, "two drop-offs, two doors")
        self.assertEqual({act["where"] for act in wkl["actions"]},
                         {"A Front", "B Carport"})

    def test_a_passenger_appears_at_pickup_and_at_their_own_drop_off(self):
        a = build_assignment(fixture("369736"))
        names = [e["name"] for s in a["steps"] for act in s["actions"]
                 for e in act["entities"]]
        self.assertEqual(len(names), 4, "two people, each twice — not a duplicate")
        for door in a["steps"][2]["actions"]:
            self.assertEqual(len(door["entities"]), 1, "one person per door")

    def test_arrival_and_departure_dates_can_differ(self):
        """LGA is reached at 11:00 PM and left at 12:00 AM, so its eta belongs
        to the 31st and its etd to the 1st. Anchoring the stop on one of them
        dated the other wrongly — and a flight's date came from the stop, so the
        flight was tracked a day out and would never have resolved."""
        a = build_assignment(fixture("369736"))
        lga = next(s for s in a["steps"] if s["code"] == "LGA")
        self.assertEqual(lga["eta"], "11:00 PM")
        self.assertEqual(lga["etd"], "12:00 AM")
        self.assertEqual(lga["etaDate"], "2026-08-31")
        self.assertEqual(lga["date"], "2026-09-01")

    def test_every_passenger_keeps_their_phone_number(self):
        """Operationally required, not a nicety: assignments arrive at 5pm and
        the driver must reach every passenger before 9pm the night before, then
        again from the kerb until they are in the car. A number the driver has
        to retype from a PDF at 11pm is a number they will not use."""
        a = build_assignment(fixture("369736"))
        entities = [e for s in a["steps"] for act in s["actions"]
                    for e in act["entities"]]
        self.assertTrue(entities)
        for e in entities:
            with self.subTest(e["name"]):
                self.assertTrue(e.get("phone"), "no phone captured")

    def test_a_field_resolves_the_same_at_every_step(self):
        """Each pattern is searched against a MULTI-LINE window, so `$` without
        re.M means end-of-string: a field only matched when its line happened to
        be last in the window. The same passenger showed a flight time at one
        step and not at the other."""
        a = build_assignment(fixture("369736"))
        seen = {}
        for step in a["steps"]:
            for act in step["actions"]:
                for e in act["entities"]:
                    prev = seen.setdefault(e["name"], e.get("scheduledText"))
                    self.assertEqual(prev, e.get("scheduledText"),
                                     f"{e['name']} differs between steps")
                    self.assertTrue(e.get("scheduledText"),
                                    f"{e['name']} lost its scheduled time")

    def test_a_flight_resolves_to_exactly_one_date(self):
        """A passenger appears at TWO steps — the airport and their own door —
        and once those fall on different days, keying a flight on the enclosing
        step tracked the same flight twice, on two dates, with half of it never
        resolving. Seen in production: poll:UA1503:2026-08-31 AND
        poll:UA1503:2026-09-01 for one arrival."""
        a = build_assignment(fixture("369736"))
        dates = {}
        for step in a["steps"]:
            for act in step["actions"]:
                for e in act["entities"]:
                    if e.get("flightNumber"):
                        dates.setdefault(e["flightNumber"], set()).add(e.get("flightDate"))
        self.assertTrue(dates)
        for number, seen in dates.items():
            with self.subTest(number):
                self.assertEqual(len(seen), 1, f"{number} resolved to {seen}")

    def test_an_arrival_is_dated_by_when_the_plane_lands(self):
        a = build_assignment(fixture("369736"))
        e = next(e for s in a["steps"] for act in s["actions"]
                 for e in act["entities"] if e.get("flightNumber") == "UA1503")
        # LGA's eta is 11:00 PM on the 31st; its etd rolls to the 1st.
        self.assertEqual(e["flightDate"], "2026-08-31")

    def test_the_header_fields_real_data_added(self):
        a = build_assignment(fixture("369736"))
        self.assertIn("Sienna", a["vehicle"])
        self.assertTrue(a["parking"].startswith("FKL-NBD"))
        self.assertEqual(a["originCode"], "FKL")
        self.assertIsNotNone(a["printedAt"])
        self.assertFalse(a["gb"])

    def test_an_all_excluded_assignment_keeps_its_shape(self):
        a = build_assignment(fixture("366824"))
        self.assertTrue(a["steps"], "the embassy run still has its stops")
        self.assertTrue(any("not yet supported" in i for i in a["issues"]))

    def test_assistants_are_captured_when_present(self):
        a = build_assignment(fixture("353328"))
        self.assertTrue(a["assistants"], "353328 has an assistant table")
        self.assertIn("role", a["assistants"][0])


class Rows(unittest.TestCase):
    def test_row_endpoints_beat_the_enclosing_stop(self):
        """A passenger row is printed under the pickup stop AND the drop-off
        stop. Using the enclosing stop put a JFK departure under the Warwick
        pickup and gave it a 15-minute drive to an airport two hours away."""
        doc, jobs, _ = jobs_of("340343")
        flights = [j for j in jobs if j.get("flightNumber")]
        self.assertTrue(flights)
        for j in flights:
            self.assertEqual(j["originCode"], "WRK")
            self.assertEqual(j["driveMinutes"], 120, "WRK->JFK, not a nearby stop")

    def test_combo_keeps_both_passengers(self):
        doc, jobs, _ = jobs_of("369736")
        names = {j["passenger"] for j in jobs if j.get("passenger")}
        self.assertEqual(len(names), 2, f"combo should have two people, got {names}")
        for j in jobs:
            if j.get("flightNumber"):
                self.assertEqual(j["kind"], "arrival")

    def test_dedupe_is_within_a_step_not_across_steps(self):
        """The same person at a pickup and at their own drop-off is two pieces
        of work, not a duplicate -- this is the whole argument for the
        assignment model."""
        doc = fixture("369736")
        lga = [s for s in doc["stops"] if s["label"] == "LGA"]
        wkl = [s for s in doc["stops"] if s["label"] == "WKL"]
        self.assertTrue(lga and wkl)
        rows_at = lambda stop: [r for r in doc["rows"]
                                if r["line"] > stop["line"] and r["name"]]
        self.assertTrue(rows_at(lga[0]), "no passenger rows under the LGA stop")
        self.assertTrue(rows_at(wkl[0]), "no passenger rows under the WKL stop")

    def test_endpoint_columns_are_readable(self):
        doc = fixture("369736")
        row = next(r for r in doc["rows"] if r["name"])
        origin, dest = row_endpoints(row["raw"])
        self.assertTrue(origin, "Origin cell lost -- check the redactor's padding")
        self.assertTrue(dest)
        self.assertEqual(code_for_place(doc, origin), "LGA")


class Jobs(unittest.TestCase):
    def test_shift_with_no_passengers_becomes_one_job(self):
        doc, jobs, issues = jobs_of("373621")
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["kind"], "shift")
        self.assertEqual(jobs[0]["targetTime"], "2026-09-16 13:00")
        self.assertEqual(jobs[0]["endTime"], "2026-09-16 17:00")
        self.assertEqual(issues, [])

    def test_excluded_rows_are_named(self):
        doc, jobs, issues = jobs_of("350568")
        self.assertTrue(any("excluded HO" in i for i in issues), issues)

    def test_an_all_excluded_assignment_still_appears(self):
        """366824 is a real run to the German embassy — out at 8:00 AM, back by
        3:00 PM. Every row is HO, and excluding them used to produce NO jobs at
        all, so the driver would have opened the app to an empty screen on a
        working day. The assignment itself becomes the job, and the rows are
        reported as unsupported rather than silently dropping the whole day."""
        doc = fixture("366824") if any(n.startswith("366824") for n in os.listdir(FIXTURES)) else None
        if doc is None:
            self.skipTest("366824 fixture not generated")
        jobs, issues = build_jobs(doc)
        self.assertTrue(jobs, "an all-excluded assignment must still produce something")
        self.assertEqual(jobs[0]["kind"], "shift")
        self.assertTrue(any("excluded" in i for i in issues))

    def test_free_text_stop_labels_are_not_drive_time_keys(self):
        """28 assignments have a stop called "Dispatch" or "Enterprise Rent" —
        and one that extracts as "Dr y LGA, JFK &" through a PDF spacing fault.
        Used as a placeCode those look up nothing and put a fragment on screen
        where a site code belongs."""
        from import_assignment import place_code_of
        self.assertIsNone(place_code_of({"label": "Enterprise Rent"}))
        self.assertIsNone(place_code_of({"label": "Dr y LGA, JFK &"}))
        self.assertIsNone(place_code_of({"label": "Dispatch"}))
        self.assertEqual(place_code_of({"label": "WRK"}), "WRK")
        self.assertEqual(place_code_of({"label": "EWR"}), "EWR")

    def test_non_flight_pickup_still_produces_a_job(self):
        """The passenger made their own way; the driver still makes the trip."""
        doc, jobs, _ = jobs_of("356385")
        self.assertTrue(jobs, "a non-flight pickup was dropped entirely")
        self.assertTrue(any(j["kind"] == "appointment" for j in jobs))
        self.assertFalse(any((j.get("note") or "").startswith("Non-Flight")
                             and j.get("flightNumber") for j in jobs))

    def test_shuttle_rows_become_timed_jobs(self):
        doc, jobs, _ = jobs_of("339460")
        shuttles = [j for j in jobs if "Shuttle" in (j.get("note") or "")]
        self.assertTrue(shuttles, f"no shuttle jobs from S rows: {jobs}")
        for j in shuttles:
            self.assertEqual(j["kind"], "appointment")
            self.assertRegex(j["targetTime"], r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")

    def test_headcount_shuttle_has_no_named_passengers_and_keeps_its_notes(self):
        """366222 moves workers by count, not by name -- 'submit passenger count
        to the scheduling inbox'. So it legitimately yields no passenger rows,
        and the itinerary lives entirely in the notes. Losing those notes would
        lose the whole assignment."""
        doc, jobs, _ = jobs_of("366222")
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["kind"], "shift")
        self.assertIn("Stage at NCB by 5:50am", jobs[0]["note"])
        self.assertGreaterEqual(len(doc["stops"]), 2, "a shuttle still has stops")


class Parties(unittest.TestCase):
    """Half the passenger groups in the sample are parties, not individuals —
    103 of 203, every one on the same flight. Without grouping, a couple is two
    near-identical rows differing only in a given name."""

    @staticmethod
    def _row(name, flight):
        return {"name": name, "line": 0,
                "raw": f"  {name}   LGA LaGuardia   Wallkill   Airline/Flight: {flight}"}

    def test_same_surname_same_flight_same_door_is_one_party(self):
        rows = [self._row("Boeck, Christian", "Lufthansa LH7603"),
                self._row("Boeck, Heidi", "Lufthansa LH7603")]
        doors = {"Boeck, Christian": "A Front", "Boeck, Heidi": "A Front"}
        keys = {party_key(None, r, doors) for r in rows}
        self.assertEqual(len(keys), 1, "a couple to one door should be one row")

    def test_different_drop_off_doors_never_merge(self):
        """The owner confirms a passenger can be set down somewhere of their own.
        It does not occur in the sample — 88 of 88 same-surname same-flight
        groups share a door — so this is tested directly rather than through a
        fixture that cannot exercise it. Merging two people who part at the kerb
        would send the driver to one door with someone who belongs at another."""
        rows = [self._row("Boeck, Christian", "Lufthansa LH7603"),
                self._row("Boeck, Heidi", "Lufthansa LH7603")]
        doors = {"Boeck, Christian": "A Front", "Boeck, Heidi": "B Carport"}
        keys = {party_key(None, r, doors) for r in rows}
        self.assertEqual(len(keys), 2, "different doors must stay separate rows")

    def test_different_flights_never_merge(self):
        rows = [self._row("Boeck, Christian", "Lufthansa LH7603"),
                self._row("Boeck, Heidi", "United Airlines UA995")]
        doors = {"Boeck, Christian": "A Front", "Boeck, Heidi": "A Front"}
        self.assertEqual(len({party_key(None, r, doors) for r in rows}), 2)

    def test_real_fixture_keeps_its_two_passengers_apart(self):
        doc = fixture("369736")
        doors = dropoff_points(doc)
        self.assertGreaterEqual(len(set(doors.values())), 2,
                                f"expected two distinct doors, got {doors}")
        rows = [r for r in doc["rows"] if r.get("name")]
        self.assertEqual(len({party_key(doc, r, doors) for r in rows}), 2)

    def test_drop_off_points_are_found_at_all(self):
        """Layout mode writes "Drop-off :" with a space before the colon. A
        startswith("Drop-off:") test matches nothing and every drop-off silently
        disappears."""
        doc = fixture("369736")
        verbs = {v for _line, v, _w in actions_in(doc)}
        self.assertIn("DROP-OFF", verbs)
        self.assertIn("PICKUP", verbs)

    def test_party_label_reads_as_one_party(self):
        self.assertEqual(party_label(["Boeck, Christian", "Boeck, Heidi"]),
                         "Boeck, Christian & Heidi")
        self.assertEqual(party_label(["Ruiz, Ana", "Ruiz, Ben", "Ruiz, Cleo"]),
                         "Ruiz, Ana, Ben & Cleo")
        self.assertEqual(party_label(["Ruiz, Ana"]), "Ruiz, Ana")


class LegTimes(unittest.TestCase):
    """Dispatch's own planned drive, taken from the document rather than a
    table. It is where the table came from, it is specific to this run, and it
    is the only answer for the four airports the table has no entry for."""

    def test_leg_time_comes_from_the_document(self):
        doc = fixture("369736")
        self.assertEqual(leg_minutes(doc, "LGA"), 90, "FKL 9:30p -> LGA 11:00p")

    def test_a_leg_spanning_midnight_is_not_discarded(self):
        """LGA's stored date is anchored on its ETD (12:00 AM, which rolls to
        the next day) while its ETA is 11:00 PM the night before. Subtracting
        the dated values gave 1530 minutes and the leg was silently thrown away,
        falling back to the table. Clock arithmetic with wraparound is correct
        here because a leg is never more than a few hours."""
        doc = fixture("369736")
        lga = next(s for s in doc["stops"] if s["label"] == "LGA")
        self.assertEqual(lga["eta"], "11:00 PM")
        self.assertEqual(lga["etd"], "12:00 AM")
        self.assertIsNotNone(leg_minutes(doc, "LGA"))
        self.assertLessEqual(leg_minutes(doc, "LGA"), 300)

    def test_the_document_wins_over_the_table(self):
        doc, jobs, _ = jobs_of("369736")
        flights = [j for j in jobs if j.get("flightNumber")]
        self.assertTrue(flights)
        for j in flights:
            self.assertEqual(j["driveMinutes"], leg_minutes(doc, "LGA"))

    def test_unknown_destination_yields_nothing(self):
        doc = fixture("369736")
        self.assertIsNone(leg_minutes(doc, "ALB"))
        self.assertIsNone(leg_minutes(doc, None))


class Flights(unittest.TestCase):
    def test_inline_iata_prefix(self):
        self.assertEqual(parse_flight("United Airlines UA 1068")[0], "UA1068")

    def test_bare_number_resolved_through_the_table(self):
        self.assertEqual(parse_flight("Delta Air Lines 114")[0], "DL114")
        self.assertEqual(parse_flight("Turkish 1")[0], "TK1")

    def test_zero_padding_is_stripped(self):
        self.assertEqual(parse_flight("Delta Air Lines DL0053")[0], "DL53")

    def test_bags_column_is_not_the_flight_number(self):
        self.assertEqual(parse_flight("United Airlines 2227                1")[0], "UA2227")

    def test_codeshare_prefers_the_named_carrier(self):
        self.assertEqual(parse_flight("United Airlines SN8807 or UA995")[0], "UA995")

    def test_caribbean_is_not_read_as_an_iata_prefix(self):
        """'Caribbean 550' ends in two letters before a number. A word boundary
        is what stops 'an' becoming a carrier code."""
        self.assertEqual(parse_flight("Caribbean 550")[0], "BW550")

    def test_unknown_carrier_refuses_rather_than_guesses(self):
        number, _name, why = parse_flight("Somewhere Airlines 123")
        self.assertIsNone(number)
        self.assertEqual(why, "unknown-airline")

    def test_non_flight_pickup_is_not_an_airline(self):
        self.assertEqual(parse_flight("Non-Flight Pickup 0")[2], "non-flight-pickup")
        self.assertEqual(parse_flight("Non-Flight Pickup / Drop off")[2], "non-flight-pickup")


class Airlines(unittest.TestCase):
    def test_iata_codes_containing_a_digit_are_not_dropped(self):
        """'B6'.isalpha() is False. Testing codes with isalpha() silently loses
        every carrier whose code has a digit in it."""
        self.assertEqual(lookup("JetBlue Airways B6")[0], "B6")
        self.assertEqual(lookup("jetblue airways")[0], "B6")

    def test_lowercase_inline_code(self):
        self.assertEqual(lookup("Asiana oz")[0], "OZ")

    def test_table_wins_over_a_disagreeing_inline_code(self):
        iata, why = lookup("United Airlines UA")
        self.assertEqual(iata, "UA")
        self.assertEqual(why, "table+inline-agree")

    def test_unknown_name_returns_none(self):
        self.assertEqual(lookup("Totally Made Up Air")[0], None)


if __name__ == "__main__":
    unittest.main(verbosity=2)
