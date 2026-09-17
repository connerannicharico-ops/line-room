"""Fetch current NFL game lines from The Odds API (optional).

Needs an ODDS_API_KEY environment variable (free tier: 500 credits/month).
One call with spreads, totals, and moneylines for US books costs 3 credits,
so running every 6 hours uses about 360 credits a month.

Writes data/raw/odds.json: [{home, away, commence, spread, total, hml, aml, books, fetched}]
spread follows the nflverse convention: positive means the home team is favored.
"""
import json, os, statistics, sys, urllib.request, datetime as dt

RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "raw")
NAMES = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL", "Buffalo Bills": "BUF",
    "Carolina Panthers": "CAR", "Chicago Bears": "CHI", "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE",
    "Dallas Cowboys": "DAL", "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX", "Kansas City Chiefs": "KC",
    "Los Angeles Rams": "LA", "Los Angeles Chargers": "LAC", "Las Vegas Raiders": "LV", "Miami Dolphins": "MIA",
    "Minnesota Vikings": "MIN", "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
    "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT", "Seattle Seahawks": "SEA",
    "San Francisco 49ers": "SF", "Tampa Bay Buccaneers": "TB", "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}


def main():
    key = os.environ.get("ODDS_API_KEY")
    if not key:
        print("ODDS_API_KEY not set, skipping odds refresh (nflverse lines will be used)", file=sys.stderr)
        return
    url = ("https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds"
           f"?apiKey={key}&regions=us&markets=h2h,spreads,totals&oddsFormat=american")
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            events = json.load(r)
            remaining = r.headers.get("x-requests-remaining")
    except Exception as e:
        print("odds fetch failed, keeping nflverse lines:", e, file=sys.stderr)
        return
    out = []
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for ev in events:
        home, away = NAMES.get(ev.get("home_team")), NAMES.get(ev.get("away_team"))
        if not home or not away:
            continue
        spreads, totals, hml, aml = [], [], [], []
        for bk in ev.get("bookmakers", []):
            for m in bk.get("markets", []):
                oc = {o["name"]: o for o in m.get("outcomes", [])}
                if m["key"] == "spreads" and ev["home_team"] in oc and "point" in oc[ev["home_team"]]:
                    spreads.append(-oc[ev["home_team"]]["point"])  # home -3.5 -> +3.5 (home favored)
                elif m["key"] == "totals" and "Over" in oc and "point" in oc["Over"]:
                    totals.append(oc["Over"]["point"])
                elif m["key"] == "h2h" and ev["home_team"] in oc and ev["away_team"] in oc:
                    hml.append(oc[ev["home_team"]]["price"]); aml.append(oc[ev["away_team"]]["price"])
        if not spreads or not totals:
            continue
        out.append(dict(home=home, away=away, commence=ev.get("commence_time"),
                        spread=statistics.median(spreads), total=statistics.median(totals),
                        hml=int(statistics.median(hml)) if hml else None, aml=int(statistics.median(aml)) if aml else None,
                        books=len(ev.get("bookmakers", [])), fetched=now))
    os.makedirs(RAW, exist_ok=True)
    with open(os.path.join(RAW, "odds.json"), "w") as f:
        json.dump(out, f)
    print(f"odds: {len(out)} games, {remaining} API credits left", file=sys.stderr)


if __name__ == "__main__":
    main()
