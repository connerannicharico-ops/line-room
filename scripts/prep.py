"""Data prep for the fantasy projection engine.

Pulls free nflverse data (schedule + betting lines, weekly player stats,
snap counts, rosters, depth charts, injuries) and writes one compact
data.json that the browser engine uses to build projections.

Usage: python prep.py [--download] [--season 2026] [--asof WEEK]
  --asof WEEK  pretend only games before WEEK have been played (for backtests)
"""
import argparse, json, os, sys, datetime as dt
import numpy as np
import pandas as pd

RAW = os.path.join(os.path.dirname(__file__), "data", "raw")
REL = "https://github.com/nflverse/nflverse-data/releases/download"
GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
SKILL = {"QB", "RB", "WR", "TE", "FB", "K"}


def download(season):
    import urllib.request
    os.makedirs(RAW, exist_ok=True)
    files = {
        "games.csv": GAMES_URL,
        f"stats_player_week_{season}.csv": f"{REL}/stats_player/stats_player_week_{season}.csv",
        f"stats_player_week_{season-1}.csv": f"{REL}/stats_player/stats_player_week_{season-1}.csv",
        f"snap_counts_{season}.csv": f"{REL}/snap_counts/snap_counts_{season}.csv",
        f"snap_counts_{season-1}.csv": f"{REL}/snap_counts/snap_counts_{season-1}.csv",
        f"roster_{season}.csv": f"{REL}/rosters/roster_{season}.csv",
        f"depth_charts_{season}.csv": f"{REL}/depth_charts/depth_charts_{season}.csv",
        f"injuries_{season}.csv": f"{REL}/injuries/injuries_{season}.csv",
    }
    for name, url in files.items():
        print("downloading", name, file=sys.stderr)
        try:
            urllib.request.urlretrieve(url, os.path.join(RAW, name))
        except Exception as e:  # injuries/snaps can lag early in a season
            print("  failed:", e, file=sys.stderr)


def rd(name, **kw):
    p = os.path.join(RAW, name)
    return pd.read_csv(p, low_memory=False, **kw) if os.path.exists(p) else None


def r2(x, n=3):
    if x is None or (isinstance(x, float) and not np.isfinite(x)):
        return None
    return round(float(x), n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", action="store_true")
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--asof", type=int, default=None)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "site", "data.json"))
    a = ap.parse_args()
    S, P = a.season, a.season - 1
    if a.download:
        download(S)

    games = rd("games.csv")
    games = games[games.game_type == "REG"].copy()
    g_cur = games[games.season == S].copy()
    if a.asof:
        g_cur.loc[g_cur.week >= a.asof, ["home_score", "away_score"]] = np.nan
    # optional fresher lines from The Odds API (see odds.py); only for games not yet played
    g_cur["line_src"] = "nflverse"
    odds_path = os.path.join(RAW, "odds.json")
    if os.path.exists(odds_path) and not a.asof:
        with open(odds_path) as f:
            odds = json.load(f)
        n = 0
        for o in odds:
            m = (g_cur.home_team == o["home"]) & (g_cur.away_team == o["away"]) & g_cur.home_score.isna()
            if o.get("commence"):
                day = pd.to_datetime(o["commence"]).tz_convert("America/New_York").strftime("%Y-%m-%d")
                m &= (pd.to_datetime(g_cur.gameday) - pd.to_datetime(day)).abs() <= pd.Timedelta(days=3)
            if m.sum() == 1:
                i = g_cur.index[m][0]
                g_cur.loc[i, ["spread_line", "total_line"]] = [o["spread"], o["total"]]
                if o.get("hml") is not None:
                    g_cur.loc[i, ["home_moneyline", "away_moneyline"]] = [o["hml"], o["aml"]]
                g_cur.loc[i, "line_src"] = "odds-api"
                n += 1
        print(f"applied Odds API lines to {n} games", file=sys.stderr)
    played_ids = set(g_cur[g_cur.home_score.notna()].game_id)
    unplayed = g_cur[g_cur.home_score.isna()]
    cur_week = int(unplayed.week.min()) if len(unplayed) else 18

    # ---------- weekly player stats ----------
    def load_stats(season, keep_ids=None):
        s = rd(f"stats_player_week_{season}.csv")
        if s is None:
            return pd.DataFrame()
        s = s[s.season_type == "REG"].copy()
        if keep_ids is not None:
            s = s[s.game_id.isin(keep_ids)]
        return s.fillna({c: 0 for c in s.select_dtypes("number").columns})

    s_cur = load_stats(S, played_ids)
    s_prev = load_stats(P)

    num = dict(pa=("attempts", "sum"), cmp=("completions", "sum"), py=("passing_yards", "sum"),
               ptd=("passing_tds", "sum"), int=("passing_interceptions", "sum"), sk=("sacks_suffered", "sum"),
               ra=("carries", "sum"), ry=("rushing_yards", "sum"), rtd=("rushing_tds", "sum"),
               tgt=("targets", "sum"), rec=("receptions", "sum"), recy=("receiving_yards", "sum"),
               rectd=("receiving_tds", "sum"), fgm=("fg_made", "sum"), fga=("fg_att", "sum"),
               fg50=("fg_made_50_59", "sum"), fg60=("fg_made_60_", "sum"), xp=("pat_made", "sum"),
               dsk=("def_sacks", "sum"), dint=("def_interceptions", "sum"), dfr=("fumble_recovery_opp", "sum"),
               dtd=("def_tds", "sum"), sttd=("special_teams_tds", "sum"), fl=("fumbles_lost_total", "sum"),
               dsaf=("def_safeties", "sum"), blk=("def_fg_blocks", "sum"), blk2=("def_punt_blocks", "sum"), blk3=("def_pat_blocks", "sum"),
               fg40=("fg_made_40_49", "sum"))

    def team_game(s):
        if s.empty:
            return pd.DataFrame()
        tg = s.groupby(["game_id", "team", "opponent_team"]).agg(**num).reset_index()
        return tg

    # ---------- lines -> implied points ----------
    def implied_rows(g):
        rows = []
        for r in g.itertuples():
            if pd.isna(r.spread_line) or pd.isna(r.total_line):
                continue
            hi = (r.total_line + r.spread_line) / 2
            ai = (r.total_line - r.spread_line) / 2
            neutral = 1 if r.location == "Neutral" else 0
            rows.append(dict(game_id=r.game_id, season=r.season, week=r.week, team=r.home_team, opp=r.away_team,
                             imp=hi, fav=r.spread_line, home=0 if neutral else 1, pts=r.home_score))
            rows.append(dict(game_id=r.game_id, season=r.season, week=r.week, team=r.away_team, opp=r.home_team,
                             imp=ai, fav=-r.spread_line, home=0 if neutral else -1, pts=r.away_score))
        return pd.DataFrame(rows)

    L_prev = implied_rows(games[games.season == P])
    L_cur = implied_rows(g_cur)

    # ---------- coefficients fit on the previous season ----------
    tgp = team_game(s_prev).merge(L_prev, on=["game_id", "team"])
    for c in ["pa", "ra", "py", "ry", "imp", "fav", "sk"]:
        tgp[c + "_d"] = tgp[c] - tgp.groupby("team")[c].transform("mean")

    def fit(y, X):
        A = np.column_stack([tgp[x] for x in X])
        return [float(v) for v in np.linalg.lstsq(A, tgp[y], rcond=None)[0]]

    coef = {
        "pa": fit("pa_d", ["imp_d", "fav_d"]), "ra": fit("ra_d", ["imp_d", "fav_d"]),
        "py": fit("py_d", ["imp_d", "fav_d"]), "ry": fit("ry_d", ["imp_d", "fav_d"]),
        "tdPerPt": float((tgp.ptd + tgp.rtd).sum() / tgp.imp.sum()),
        "fgmPerPt": float(tgp.fgm.sum() / tgp.imp.sum()),
        "xpPerTd": float(tgp.xp.sum() / (tgp.ptd + tgp.rtd).sum()),
        "fg50Share": float((tgp.fg50.sum() + tgp.fg60.sum()) / max(tgp.fgm.sum(), 1)),
        "ptsSd": float((tgp.pts - tgp.imp).std()),
        "passTdShare": float(tgp.ptd.sum() / (tgp.ptd + tgp.rtd).sum()),
        "defTdPerG": float(tgp.dtd.sum() / len(tgp)), "stTdPerG": float(tgp.sttd.sum() / len(tgp)),
        "sackRate": float(tgp.sk.sum() / (tgp.pa.sum() + tgp.sk.sum())),
        "intRate": float(tgp.int.sum() / tgp.pa.sum()),
        "fumRecPerG": float(tgp.fl.sum() / len(tgp)),
        "safetyPerG": float(tgp.dsaf.sum() / len(tgp)),
        "blockPerG": float((tgp.blk + tgp.blk2 + tgp.blk3).sum() / len(tgp)),
        "twoPtPerG": 0.108, "twoPtPassShare": 0.6, "longTdShare": 0.09, "longRetTdShare": 0.6,
        "sd": {"passYd": 65, "compPct": 8.5, "yardK": 4.6},
        "lg": {k: float(tgp[k].mean()) for k in ["pa", "ra", "py", "ry", "sk", "imp"]},
    }

    # ---------- team ratings from market lines (for weeks without lines) ----------
    teams = sorted(set(g_cur.home_team) | set(g_cur.away_team))
    ti = {t: i for i, t in enumerate(teams)}
    obs = []
    for df, wgt in [(L_cur, 1.0), (L_prev[L_prev.week >= 12], 0.15)]:
        for r in df.itertuples():
            if r.team in ti and r.opp in ti:
                obs.append((ti[r.team], ti[r.opp], r.home, r.imp, wgt))
    n = len(teams)
    X = np.zeros((len(obs), 2 * n + 2)); y = np.zeros(len(obs)); w = np.zeros(len(obs))
    for k, (t, o, h, imp, wg) in enumerate(obs):
        X[k, 0] = 1; X[k, 1] = h / 2; X[k, 2 + t] = 1; X[k, 2 + n + o] = -1
        y[k] = imp; w[k] = wg
    lam = np.diag([0, 0] + [3.0] * (2 * n))
    W = np.diag(w)
    beta = np.linalg.solve(X.T @ W @ X + lam, X.T @ W @ y)
    mu, hfa = float(beta[0]), float(beta[1])
    ratings = {t: dict(off=r2(beta[2 + i]), deff=r2(beta[2 + n + i])) for t, i in ti.items()}

    # ---------- team base rates by season ----------
    def team_season(s, L):
        tg = team_game(s)
        if tg.empty:
            return {}
        if L is not None and len(L):
            tg = tg.merge(L[["game_id", "team", "imp", "pts"]], on=["game_id", "team"], how="left")
        opp = tg[["game_id", "team"] + list(num.keys())].rename(columns={"team": "opponent_team"})
        opp = opp.rename(columns={k: "o_" + k for k in num.keys()})
        tg = tg.merge(opp, on=["game_id", "opponent_team"], how="left")
        # fantasy points allowed by position
        fp = s[s.position.isin(["QB", "RB", "WR", "TE"])].groupby(["game_id", "opponent_team", "position"]).fantasy_points_ppr.sum().unstack(fill_value=0).reset_index()
        fp = fp.rename(columns={"opponent_team": "team"})
        tg = tg.merge(fp, on=["game_id", "team"], how="left")
        out = {}
        for t, d in tg.groupby("team"):
            agg = {k: r2(d[k].sum(), 1) for k in num.keys()}
            agg.update({"o_" + k: r2(d["o_" + k].sum(), 1) for k in ["pa", "sk", "int", "fl", "ptd", "rtd"]})
            agg["blkAll"] = r2((d.blk + d.blk2 + d.blk3).sum(), 1)
            agg["g"] = int(len(d))
            agg["imp"] = r2(d.imp.sum(), 1) if "imp" in d else None
            agg["pts"] = r2(d.pts.sum(), 1) if "pts" in d else None
            opp_pts = tg[tg.opponent_team == t]
            agg["ptsAllowed"] = r2(opp_pts.pts.sum(), 1) if "pts" in opp_pts else None
            agg["fpa"] = {p: r2(d[p].sum(), 1) for p in ["QB", "RB", "WR", "TE"] if p in d}
            out[t] = agg
        return out

    ts_prev = team_season(s_prev, L_prev)
    ts_cur = team_season(s_cur, L_cur)
    lg_fpa = {p: float(np.mean([v["fpa"].get(p, 0) / v["g"] for v in ts_prev.values()])) for p in ["QB", "RB", "WR", "TE"]}
    coef["lgFpa"] = lg_fpa

    # ---------- player season lines ----------
    def player_season(s, snaps):
        if s.empty:
            return {}
        tg = team_game(s).set_index(["game_id", "team"])
        s = s[s.position.isin(SKILL)].copy()
        out = {}
        for pid, d in s.groupby("player_id"):
            team = d.team.value_counts().idxmax()
            dd = d[d.team == team]
            T = tg.loc[list(zip(dd.game_id, dd.team))]
            rec = dict(team=team, g=int(dd.game_id.nunique()),
                       tgt=r2(dd.targets.sum(), 1), tTgt=r2(T.tgt.sum(), 1),
                       rec=r2(dd.receptions.sum(), 1), recy=r2(dd.receiving_yards.sum(), 1),
                       rectd=r2(dd.receiving_tds.sum(), 1), tPtd=r2(T.ptd.sum(), 1),
                       ra=r2(dd.carries.sum(), 1), tRa=r2(T.ra.sum(), 1), ry=r2(dd.rushing_yards.sum(), 1),
                       rtd=r2(dd.rushing_tds.sum(), 1), tRtd=r2(T.rtd.sum(), 1),
                       pa=r2(dd.attempts.sum(), 1), tPa=r2(T.pa.sum(), 1), cmp=r2(dd.completions.sum(), 1),
                       py=r2(dd.passing_yards.sum(), 1), ptd=r2(dd.passing_tds.sum(), 1),
                       int=r2(dd.passing_interceptions.sum(), 1), fl=r2(dd.fumbles_lost_total.sum(), 1),
                       fgm=r2(dd.fg_made.sum(), 1), fga=r2(dd.fg_att.sum(), 1), xp=r2(dd.pat_made.sum(), 1),
                       fg40=r2(dd.fg_made_40_49.sum(), 1), fg50=r2(dd.fg_made_50_59.sum(), 1), fg60=r2(dd.fg_made_60_.sum(), 1),
                       tpg=r2(dd.targets.sum() / max(len(dd), 1), 2),
                       fppg=r2(dd.fantasy_points_ppr.sum() / max(len(dd), 1), 2))
            out[pid] = rec
        return out

    ps_prev = player_season(s_prev, None)
    ps_cur = player_season(s_cur, None)

    # snaps (pfr ids) -> average offensive snap share, by season
    def snap_share(season, keep_ids):
        sc = rd(f"snap_counts_{season}.csv")
        if sc is None:
            return {}
        sc = sc[sc.game_type == "REG"]
        if keep_ids is not None:
            sc = sc[sc.game_id.isin(keep_ids)]
        sc = sc[sc.position.isin(["QB", "RB", "WR", "TE", "FB"])]
        return sc.groupby("pfr_player_id").offense_pct.mean().round(3).to_dict()

    snap_prev = snap_share(P, None)
    snap_cur = snap_share(S, played_ids)

    # league usage per snap by position (prior for players with little history)
    roster = rd(f"roster_{S}.csv")
    if a.asof:  # backtest: everyone who appears on a roster, availability from who actually played
        roster = roster.sort_values("week").drop_duplicates("gsis_id", keep="last")
        full = rd(f"stats_player_week_{S}.csv")
        full = full[full.season_type == "REG"]
        wk_team = full[full.week == a.asof].set_index("player_id").team.to_dict()
        before = full[full.week < a.asof].sort_values("week").drop_duplicates("player_id", keep="last").set_index("player_id").team.to_dict()
    else:
        roster = roster[roster.week == roster.week.max()]
    pfr_map = dict(zip(roster.gsis_id, roster.pfr_id))
    usage_prior = {}
    for pos in ["QB", "RB", "WR", "TE"]:
        ids = [pid for pid, v in ps_prev.items() if roster_pos(pid, roster, s_prev) == pos and v["g"] >= 6]
        sh_t, sh_c, sn = [], [], []
        for pid in ids:
            sp = snap_prev.get(pfr_map.get(pid)) if pfr_map.get(pid) else None
            if sp and sp > 0.2:
                v = ps_prev[pid]
                sh_t.append(v["tgt"] / max(v["tTgt"], 1)); sh_c.append(v["ra"] / max(v["tRa"], 1)); sn.append(sp)
        if sn:
            usage_prior[pos] = dict(tgtPerSnap=r2(np.sum(sh_t) / np.sum(sn), 4), carPerSnap=r2(np.sum(sh_c) / np.sum(sn), 4))
    coef["usagePrior"] = usage_prior

    # league efficiency by position (regression targets)
    sp = s_prev.copy(); sp["position"] = sp.position.replace({"FB": "RB"})
    eff = {}
    for pos, d in sp[sp.position.isin(["QB", "RB", "WR", "TE"])].groupby("position"):
        touches = d.carries.sum() + d.receptions.sum()
        eff[pos] = dict(ypt=r2(d.receiving_yards.sum() / max(d.targets.sum(), 1)),
                        catch=r2(d.receptions.sum() / max(d.targets.sum(), 1)),
                        ypc=r2(d.rushing_yards.sum() / max(d.carries.sum(), 1)),
                        fumPerTouch=r2((d.rushing_fumbles_lost.sum() + d.receiving_fumbles_lost.sum()) / max(touches, 1), 4))
    q = sp[sp.position == "QB"]
    eff["QB"].update(ypa=r2(q.passing_yards.sum() / q.attempts.sum()), cmp=r2(q.completions.sum() / q.attempts.sum()),
                     intRate=r2(q.passing_interceptions.sum() / q.attempts.sum(), 4))
    k = sp[sp.position == "K"]
    eff["K"] = dict(fg40=r2(k.fg_made_40_49.sum() / max(k.fg_made.sum(), 1)), fg50=r2(k.fg_made_50_59.sum() / max(k.fg_made.sum(), 1)),
                    fg60=r2(k.fg_made_60_.sum() / max(k.fg_made.sum(), 1), 4))
    coef["lgEff"] = eff

    # ---------- depth chart (QB1, K1) + injuries ----------
    depth = {}
    dc = rd(f"depth_charts_{S}.csv")
    if dc is not None:
        if a.asof:
            first_day = g_cur[g_cur.week == a.asof].gameday.min()
            dc = dc[dc.dt < first_day]
        dc = dc[dc.dt == dc.dt.max()]
        for r in dc[dc.pos_abb.isin(["QB", "PK", "RB", "WR", "TE"])].itertuples():
            key = (r.gsis_id, "K" if r.pos_abb == "PK" else r.pos_abb)
            depth[key] = min(depth.get(key, 99), int(r.pos_rank))
    inj = {}
    ij = rd(f"injuries_{S}.csv")
    if ij is not None:
        ij = ij[ij.week == cur_week]
        for r in ij.itertuples():
            if isinstance(r.report_status, str):
                inj[r.gsis_id] = r.report_status

    # ---------- player list from current rosters ----------
    players = []
    for r in roster.itertuples():
        pos = "RB" if r.position == "FB" else r.position
        pid = r.gsis_id
        team, status = r.team, r.status
        if a.asof:
            team = before.get(pid, r.team)
            status = "ACT" if pid in wk_team else "INA"
            if pid in wk_team:
                team = wk_team[pid]
        if pos not in {"QB", "RB", "WR", "TE", "K"} or status not in ("ACT", "RES", "INA"):
            continue
        cur, prev = ps_cur.get(pid), ps_prev.get(pid)
        sn_c = snap_cur.get(r.pfr_id) if isinstance(r.pfr_id, str) else None
        sn_p = snap_prev.get(r.pfr_id) if isinstance(r.pfr_id, str) else None
        if not cur and not prev and not sn_c and depth.get((pid, pos), 99) > 2:
            continue
        players.append(dict(id=pid, name=r.full_name, pos=pos, team=team,
                            status="IR" if status == "RES" else ("INA" if status == "INA" else inj.get(pid)),
                            depth=depth.get((pid, pos)), rookie=bool(r.years_exp == 0),
                            cur=cur, prev=prev, snapCur=sn_c, snapPrev=sn_p))

    sched = []
    for r in g_cur.sort_values(["week", "gameday", "gametime"]).itertuples():
        sched.append(dict(id=r.game_id, week=int(r.week), day=r.gameday, time=r.gametime, home=r.home_team,
                          away=r.away_team, neutral=r.location == "Neutral",
                          spread=r2(r.spread_line, 1), total=r2(r.total_line, 1),
                          hml=None if pd.isna(r.home_moneyline) else int(r.home_moneyline),
                          aml=None if pd.isna(r.away_moneyline) else int(r.away_moneyline),
                          lineSrc=r.line_src,
                          hs=None if pd.isna(r.home_score) else int(r.home_score),
                          as_=None if pd.isna(r.away_score) else int(r.away_score)))

    out = dict(meta=dict(season=S, week=cur_week, generated=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                         asof=a.asof, source="nflverse (nflverse-data, nfldata)"),
               coef=coef, ratings=dict(mu=r2(mu), hfa=r2(hfa), teams=ratings),
               teamsPrev=ts_prev, teamsCur=ts_cur, schedule=sched, players=players)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {a.out}: week {cur_week}, {len(players)} players, {os.path.getsize(a.out)//1024} KB", file=sys.stderr)


_pos_cache = {}
def roster_pos(pid, roster, s_prev):
    if not _pos_cache:
        for r in s_prev[["player_id", "position"]].drop_duplicates("player_id").itertuples():
            _pos_cache[r.player_id] = r.position
    return _pos_cache.get(pid)


if __name__ == "__main__":
    main()
