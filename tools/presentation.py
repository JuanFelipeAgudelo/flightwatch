"""Render real assignments as a Curbside preview, as a LOCAL file.

    python tools/presentation.py "<pdf dir or file>" [--date YYYY-MM-DD] [--out PATH]

Why this exists
---------------
The published design mockup is deliberately de-identified: it lives on a hosted
URL, and one forwarded link would be an unauthorised disclosure of a passenger's
travel -- which for a GB run is exactly the confidential information the
department's guidelines name.

For showing oversight, though, real names read better than plausible ones. So
this renders the same screens from the real documents to a file **on this
machine**, which is never committed and never published. Presenting from a
laptop discloses nothing; publishing does.

The output path defaults to `curbside-preview.local.html`, which .gitignore
excludes. Delete it when the meeting is over.
"""
import argparse
import glob
import html
import os
import re
import sys
from collections import defaultdict
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from import_assignment import (  # noqa: E402
    ACTION_LINE, APPT_RE, ARRIVAL_TIME_RE, EXCLUDED_TAGS, FLIGHT_RE, ROUTE_RE,
    TIME_CITY_RE, dropoff_points, parse_assignment, parse_flight, party_key,
    party_label,
)

E = html.escape


def esc(v):
    return E(str(v)) if v is not None else ""


def entities_between(doc, start_line, end_line):
    """Passenger rows in a line range, collapsed into parties."""
    rows = [r for r in doc["rows"]
            if start_line < r["line"] < end_line and r.get("name")]
    doors = dropoff_points(doc)
    groups = defaultdict(list)
    for r in rows:
        groups[party_key(doc, r, doors)].append(r)
    out = []
    for key, members in groups.items():
        names, seen = [], set()
        for m in members:
            if m["name"] not in seen:
                seen.add(m["name"])
                names.append(m["name"])
        first = members[0]
        tag = first.get("tag")
        info = ""
        fm = FLIGHT_RE.search(first["raw"])
        if fm:
            number, airline, _why = parse_flight(fm.group("rest"))
            tc = TIME_CITY_RE.search(first["window"])
            bits = [b for b in [tc.group("city").strip() if tc else None,
                                tc.group("time").strip() if tc else None] if b]
            info = " · ".join(bits)
            flight = number or f"{airline} ?"
        else:
            am = APPT_RE.search(first["window"]) or ARRIVAL_TIME_RE.search(first["window"])
            rm = ROUTE_RE.search(first["window"])
            flight = am.group("time").strip() if am else ""
            info = f"Route: {rm.group('route').strip()}" if rm else ""
        out.append({
            "label": party_label(names), "count": len(names),
            "flight": flight, "info": info, "tag": tag,
            "excluded": EXCLUDED_TAGS.get(tag),
        })
    return out


def actions_for_step(doc, stop, next_line):
    """Every action under this stop, with the entities that belong to each.

    A step really can hold more than one: in 369736 two passengers off the same
    flight are dropped at A Front and B Carport. Returning only the first action
    merges two doors into one."""
    found = []
    for i in range(stop["line"] + 1, min(next_line, len(doc["lines"]))):
        m = ACTION_LINE.match(doc["lines"][i])
        if m:
            found.append({"line": i, "verb": m.group(1).upper(),
                          "where": m.group("where") or ""})
    for n, act in enumerate(found):
        end = found[n + 1]["line"] if n + 1 < len(found) else next_line
        act["entities"] = entities_between(doc, act["line"], end)
    return found


def is_gb(doc):
    return any((r.get("tag") or "").startswith("GB") for r in doc["rows"])


# ------------------------------------------------------------------ rendering
CSS = """
:root{--page:#EFECE4;--panel:#fff;--panel-raised:#F6F3EB;--card:#fff;--leaveby-bg:#FBF3E3;
--hairline:#DBD6C9;--hairline-strong:#C3BCAA;--dashed:#B9B2A2;--ink:#101E36;--ink-2:#5A6880;
--ink-warn:#6B4E17;--ink-dim:#8A7358;--brass:#8A5A06;--brass-fill:#E8A33D;--brass-ink:#1A1206;
--ok:#1E7A4F;--alert:#B4321C;--mono-w:700;--page-2:#E5E1D6;
--gb-a:#F0B45A;--gb-b:#B9761A;--gb-plate:#2A1B04;}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){
--page:#0E1B30;--panel:#16294A;--panel-raised:#1C3459;--card:#142545;--leaveby-bg:#1A3055;
--hairline:#1E3252;--hairline-strong:#2E4571;--dashed:#3B517A;--ink:#F4F1EA;--ink-2:#8FA1C0;
--ink-warn:#D8C9A8;--ink-dim:#C0A08E;--brass:#E8A33D;--brass-fill:#E8A33D;--brass-ink:#1A1206;
--ok:#4FC38A;--alert:#FF7A62;--mono-w:600;--page-2:#0A1526;
--gb-a:#F5C071;--gb-b:#C4821F;--gb-plate:#1A1206;}}
*{box-sizing:border-box}
body{margin:0;background:var(--page-2);color:var(--ink);font-size:15px;line-height:1.55;
font-family:"Instrument Sans",system-ui,-apple-system,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding-inline:20px;padding-block:36px 56px}
h1{margin:0 0 6px;font-size:clamp(24px,4vw,32px);letter-spacing:-.02em}
.sub{color:var(--ink-2);margin:0 0 6px;max-width:62ch}
.warn{margin:14px 0 0;padding:10px 12px;border:1px solid var(--alert);border-radius:6px;
color:var(--alert);font-size:13px;max-width:62ch}
.eyebrow{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:11px;font-weight:600;
letter-spacing:.16em;text-transform:uppercase;color:var(--ink-2)}
.screens{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:26px;
align-items:start;margin-top:30px}
.screen{display:flex;flex-direction:column;gap:11px}
.screen b{font-size:15px}
.phone{background:var(--page);border:1px solid var(--hairline-strong);border-radius:14px;
overflow:hidden;box-shadow:0 10px 30px rgb(0 0 0/.13)}
.bar{display:flex;gap:8px;align-items:center;padding:9px 13px;border-bottom:1px solid var(--hairline);
background:var(--panel);font-family:"IBM Plex Mono",monospace;font-size:10px;font-weight:600;
letter-spacing:.14em;color:var(--ink-2)}
.bar .name{color:var(--brass)}.bar .sp{flex:1}
.body{padding:13px;display:flex;flex-direction:column;gap:11px}
.daygroup{font-family:"IBM Plex Mono",monospace;font-size:10px;font-weight:600;
letter-spacing:.16em;color:var(--ink-2)}
.acard{background:var(--card);border:1px solid var(--hairline);border-radius:7px;
padding:11px 12px;display:flex;flex-direction:column;gap:7px}
.acard.gb{position:relative;padding-left:15px}
.acard.gb::before{content:"";position:absolute;left:0;top:7px;bottom:7px;width:4px;
border-radius:0 3px 3px 0;background:linear-gradient(180deg,var(--gb-a),var(--gb-b))}
.arow{display:flex;align-items:baseline;gap:9px}
.atime{font-family:"IBM Plex Mono",monospace;font-weight:var(--mono-w);font-size:15px;
font-variant-numeric:tabular-nums}
.adash{color:var(--ink-2);font-size:12px}.asp{flex:1}
.aroute{font-weight:600;font-size:14px}.ameta{color:var(--ink-2);font-size:12.5px}
.chip{font-family:"IBM Plex Mono",monospace;font-size:9.5px;font-weight:600;letter-spacing:.1em;
padding:2.5px 6px;border-radius:3px;border:1px solid var(--hairline-strong);color:var(--ink-2)}
.chip.brass{border-color:var(--brass);color:var(--brass);letter-spacing:.14em}
.leaveline{display:flex;align-items:baseline;gap:8px;background:var(--leaveby-bg);
border-radius:5px;padding:7px 9px}
.leaveline .lbl{font-family:"IBM Plex Mono",monospace;font-size:9.5px;font-weight:600;
letter-spacing:.14em;color:var(--ink-warn)}
.leaveline .val{font-family:"IBM Plex Mono",monospace;font-weight:var(--mono-w);font-size:17px;
font-variant-numeric:tabular-nums}
.leaveline .s{color:var(--ink-2);font-size:11.5px;margin-left:auto}
.nowband{background:var(--brass-fill);color:var(--brass-ink);border-radius:7px;padding:10px 12px;
display:flex;flex-direction:column;gap:2px}
.nowhead{display:flex;align-items:center;gap:9px;margin-bottom:3px}
.nowband .k{font-family:"IBM Plex Mono",monospace;font-size:9.5px;font-weight:700;
letter-spacing:.16em;opacity:.72}
.nowband .v{font-weight:700;font-size:15.5px;line-height:1.3}
.nowband .why{font-size:12.5px;opacity:.82}
.gbtag{font-family:"IBM Plex Mono",monospace;font-size:9px;font-weight:700;letter-spacing:.18em;
background:var(--gb-plate);color:var(--gb-a);padding:4px 9px;border-radius:3px;
box-shadow:inset 0 1px 0 rgb(255 255 255/.13);white-space:nowrap}
.step{display:grid;grid-template-columns:62px 1fr}
.rail{position:relative}
.rail::before{content:"";position:absolute;left:52px;top:0;bottom:0;width:1px;
background:var(--hairline-strong)}
.step:first-child .rail::before{top:12px}
.step:last-child .rail::before{bottom:calc(100% - 12px)}
.dot{position:absolute;left:47px;top:7px;width:11px;height:11px;border-radius:50%;
background:var(--page);border:2px solid var(--hairline-strong)}
/* Option (b): the hit area is 44px and entirely invisible. */
.dot::after{content:"";position:absolute;left:50%;top:50%;width:44px;height:44px;
transform:translate(-50%,-50%)}
.step.current .dot{border-color:var(--brass);background:var(--brass)}
.rtime{position:absolute;left:0;top:4px;width:42px;text-align:right;font-family:"IBM Plex Mono",
monospace;font-size:10.5px;font-weight:600;color:var(--ink-2);font-variant-numeric:tabular-nums}
.stepbody{padding:4px 0 16px;min-width:0}
.sthead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.scode{font-family:"IBM Plex Mono",monospace;font-weight:700;font-size:14px}
.splace{color:var(--ink-2);font-size:12.5px}
.stimes{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--ink-2);margin-left:auto;
font-variant-numeric:tabular-nums}
.action{margin-top:9px;border-left:2px solid var(--brass);padding-left:10px;display:flex;
flex-direction:column;gap:7px}
.averb{font-family:"IBM Plex Mono",monospace;font-size:10.5px;font-weight:700;letter-spacing:.12em;
color:var(--brass)}
.awhere{font-weight:600;font-size:13.5px}
.entity{background:var(--panel);border:1px solid var(--hairline);border-radius:5px;padding:8px 9px;
display:flex;flex-direction:column;gap:3px}
.erow{display:flex;align-items:baseline;gap:7px}
.ename{font-weight:600;font-size:13.5px}
.eflight{font-family:"IBM Plex Mono",monospace;font-size:11.5px;font-weight:600;color:var(--ink-2);
margin-left:auto;font-variant-numeric:tabular-nums}
.estat{font-size:12px;color:var(--ink-2)}
.notes{background:var(--leaveby-bg);border-radius:6px;padding:10px 11px;font-size:12.5px;
white-space:pre-wrap;color:var(--ink-2)}
.notes b{display:block;font-family:"IBM Plex Mono",monospace;font-size:9.5px;font-weight:700;
letter-spacing:.14em;color:var(--ink-warn);margin-bottom:5px}
"""


def fmt12(t):
    return t.strftime("%-I:%M%p").lower() if os.name != "nt" else t.strftime("%#I:%M%p").lower()


def render_card(doc, jobs):
    gb = " gb" if is_gb(doc) else ""
    chips = []
    if is_gb(doc):
        chips.append('<span class="chip brass">GB</span>')
    kinds = {j.get("kind") for j in jobs}
    label = ("ARR" if "arrival" in kinds else "DEP" if "departure" in kinds
             else "MED" if "appointment" in kinds else "SHIFT")
    chips.append(f'<span class="chip">{label}</span>')
    seq = []
    for st in doc["stops"]:
        if not seq or seq[-1] != st["label"]:
            seq.append(st["label"])
    route = " → ".join(seq) or "—"
    pax = sum(j.get("pax") or 1 for j in jobs if j.get("passenger"))
    meta = [f"{pax} passenger{'s' if pax != 1 else ''}" if pax else None]
    leave = ""
    drive = next((j.get("driveMinutes") for j in jobs
                  if isinstance(j.get("driveMinutes"), int)), None)
    if drive:
        at = doc["start"].timestamp() - (drive + 15) * 60
        leave = (f'<div class="leaveline"><span class="lbl">LEAVE BY</span>'
                 f'<span class="val">{fmt12(datetime.fromtimestamp(at))}</span>'
                 f'<span class="s">{drive}m drive + 15m</span></div>')
    return f"""<div class="acard{gb}">
  <div class="arow"><span class="atime">{fmt12(doc['start'])}</span>
  <span class="adash">→</span><span class="atime">{fmt12(doc['end'])}</span>
  <span class="asp"></span>{''.join(chips)}</div>
  <div class="aroute">{esc(route)}</div>
  <div class="ameta">{esc(' · '.join(m for m in meta if m))}</div>
  {leave}
</div>"""


def render_itinerary(doc):
    lines_total = len(doc["lines"])
    parts = []
    for i, stop in enumerate(doc["stops"]):
        nxt = doc["stops"][i + 1]["line"] if i + 1 < len(doc["stops"]) else lines_total
        blocks = ""
        for act in actions_for_step(doc, stop, nxt):
            rows = ""
            for e in act["entities"]:
                if e["excluded"]:
                    rows += (f'<div class="entity"><div class="erow"><span class="ename">'
                             f'{esc(e["label"])}</span></div><div class="estat">'
                             f'{esc(e["excluded"])} — not imported</div></div>')
                    continue
                rows += (f'<div class="entity"><div class="erow"><span class="ename">'
                         f'{esc(e["label"])}</span><span class="eflight">{esc(e["flight"])}</span>'
                         f'</div><div class="estat">{esc(e["info"])}</div></div>')
            blocks += (f'<div class="action"><div><span class="averb">{esc(act["verb"])}</span> '
                       f'<span class="awhere">{esc(act["where"])}</span></div>{rows}</div>')
        times = " – ".join(t for t in (stop.get("eta"), stop.get("etd")) if t) or ""
        cur = " current" if i == 0 else ""
        parts.append(f"""<div class="step{cur}">
  <div class="rail"><span class="dot"></span><span class="rtime">{esc(stop.get('etd') or stop.get('eta') or '')}</span></div>
  <div class="stepbody">
    <div class="sthead"><span class="scode">{esc(stop['label'])}</span>
      <span class="splace">{esc(stop['place'])}</span>
      <span class="stimes">{esc(times)}</span></div>
    {blocks}
  </div>
</div>""")
    notes = (f'<div class="notes"><b>DRIVER NOTES</b>{esc(doc["driver_notes"])}</div>'
             if doc.get("driver_notes") else "")
    gbtag = '<span class="gbtag">GOVERNING BODY</span>' if is_gb(doc) else ""
    first = doc["stops"][0] if doc["stops"] else None
    return f"""<div class="phone">
  <div class="bar"><span>‹ ASSIGNMENTS</span><span class="sp"></span><span>{esc(doc.get('parking') or '')}</span></div>
  <div class="body">
    <div class="nowband">
      <div class="nowhead"><span class="k">RIGHT NOW</span>{gbtag}</div>
      <span class="v">Leave {esc((first or {}).get('place') or 'base')} at {esc((first or {}).get('etd') or '')}</span>
      <span class="why">Assignment {esc(doc['assignment'])} · {esc(doc['driver'])}</span>
    </div>
    {''.join(parts)}
    {notes}
  </div>
</div>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path")
    ap.add_argument("--date", help="only assignments starting on this YYYY-MM-DD")
    ap.add_argument("--out", default="curbside-preview.local.html")
    args = ap.parse_args()

    files = (sorted(glob.glob(os.path.join(args.path, "*.pdf")))
             if os.path.isdir(args.path) else [args.path])
    latest = {}
    for f in files:
        try:
            doc = parse_assignment(f)
        except Exception:  # noqa: BLE001
            continue
        if not doc:
            continue
        prev = latest.get(doc["assignment"])
        if prev is None or (doc["printed"] and prev["printed"] and doc["printed"] > prev["printed"]):
            latest[doc["assignment"]] = doc

    docs = sorted(latest.values(), key=lambda d: d["start"])
    if args.date:
        want = datetime.strptime(args.date, "%Y-%m-%d").date()
        docs = [d for d in docs if d["start"].date() == want]
    if not docs:
        print("No assignments matched.")
        return 1

    from import_assignment import build_jobs
    cards, day = [], None
    for d in docs[:6]:
        if d["start"].date() != day:
            day = d["start"].date()
            cards.append(f'<div class="daygroup">{day.strftime("%a %-d %b").upper() if os.name != "nt" else day.strftime("%a %#d %b").upper()}</div>')
        cards.append(render_card(d, build_jobs(d)[0]))

    subject = next((d for d in docs if d["stops"] and len(d["rows"]) > 0), docs[0])
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Curbside — preview</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap">
<style>{CSS}</style></head><body><div class="wrap">
<span class="eyebrow">Curbside · preview from real assignments</span>
<h1>Your Assignments</h1>
<p class="sub">Rendered from the actual assignment PDFs on this machine.</p>
<div class="warn"><b>Local file — do not upload, email or publish.</b> This page contains real
passenger names and travel details. Present it from this laptop and delete it afterwards.</div>
<div class="screens">
  <div class="screen"><b>The list</b>{f'<div class="phone"><div class="bar"><span class="name">CURBSIDE</span><span class="sp"></span><span>TODAY</span></div><div class="body">{"".join(cards)}</div></div>'}</div>
  <div class="screen"><b>Assignment {esc(subject['assignment'])}</b>{render_itinerary(subject)}</div>
</div></div></body></html>"""

    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(page)
    print(f"wrote {os.path.abspath(args.out)}")
    print(f"  {len(docs)} assignment(s); itinerary shows {subject['assignment']}")
    print("  LOCAL ONLY — contains real passenger data. Do not publish.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
