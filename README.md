# Line Room

Fantasy football projections built from Vegas lines, usage data, and my own adjustments.

- `docs/` is the website (served by GitHub Pages): `index.html`, `engine.js` (projection engine), `data.json` (built data), and optional `defaults.json` (my default settings for visitors).
- `scripts/prep.py` downloads free nflverse data and builds `docs/data.json`.
- `scripts/odds.py` pulls current lines from The Odds API when the `ODDS_API_KEY` secret is set.
- `.github/workflows/update.yml` runs both every 6 hours and commits the new data.

## Setting my defaults
In the site, open **Save and share → Copy settings**, then create `docs/defaults.json` in this repo and paste. Visitors (and any new browser) start from those settings.

Data: nflverse (nflverse-data, nfldata). Lines: nflverse and The Odds API.
