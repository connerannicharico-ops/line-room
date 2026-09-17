/* Projection engine. Runs in the browser (window.FFEngine) and in Node (require).
 * Input: data.json from prep.py + user settings. Output: stat lines per player per week.
 * Scoring is applied separately (score()) so scoring changes never need a re-projection.
 */
(function (root) {
  "use strict";

  const DEFAULT_WEIGHTS = {
    vegas: 1.0,     // 0..2  how strongly game lines move volume, yards, and TDs away from team norms
    recency: 0.5,   // 0..1  how much 2026 games count relative to last season
    effReg: 1.0,    // 0..2  how hard player efficiency (yds/target, ypc, TD rate) is pulled to league average
    matchup: 0.25,  // 0..1  how much defense-vs-position history tilts a player's projection
  };

  // Yardage rules: mode "linear" (per yards, fractional), "floor" (whole increments only), "tiers" ([min yards, pts] steps)
  const PRESETS = {
    "My league": {
      passTd: 7, int: -3, passYd: { mode: "tiers", per: 25, tiers: [[200, 5], [250, 10], [300, 15], [350, 20], [400, 25], [450, 30], [500, 35]] },
      compBonus: { min: 60, pts: 5 },
      rushTd: 7, rushYd: { mode: "floor", per: 10, tiers: [] },
      recTd: 7, recYd: { mode: "floor", per: 10, tiers: [] },
      rec: { QB: 0, RB: 1, WR: 1, TE: 1 },
      longTd: 3, twoPt: 3, fumLost: 0,
      k: { fg: 3, b40: 2, b50: 4, b60: 1, xp: 1 },
      def: { sack: 2, int: 5, fr: 2, td: 7, safety: 10, longTd: 3, pa: [[0, 25], [10, 10], [41, 0], [47, -10], [999, -15]] },
      st: { td: 7, longTd: 3, block: 2 },
      hc: { win: 10, loss: -5 },
    },
  };
  const base = (o) => JSON.parse(JSON.stringify(Object.assign({}, PRESETS["My league"], o)));
  const stdDef = { sack: 1, int: 2, fr: 2, td: 6, safety: 2, longTd: 0, pa: [[0, 10], [6, 7], [13, 4], [20, 1], [27, 0], [34, -1], [999, -4]] };
  const stdCommon = {
    passTd: 4, int: -2, passYd: { mode: "linear", per: 25, tiers: [] }, compBonus: { min: 60, pts: 0 },
    rushTd: 6, rushYd: { mode: "linear", per: 10, tiers: [] }, recTd: 6, recYd: { mode: "linear", per: 10, tiers: [] },
    longTd: 0, twoPt: 2, fumLost: -2, k: { fg: 3, b40: 1, b50: 2, b60: 2, xp: 1 }, def: stdDef, st: { td: 0, longTd: 0, block: 0 }, hc: { win: 0, loss: 0 },
  };
  PRESETS["Full PPR"] = base(Object.assign({}, stdCommon, { rec: { QB: 0, RB: 1, WR: 1, TE: 1 } }));
  PRESETS["Half PPR"] = base(Object.assign({}, stdCommon, { rec: { QB: 0, RB: 0.5, WR: 0.5, TE: 0.5 } }));
  PRESETS["Standard"] = base(Object.assign({}, stdCommon, { rec: { QB: 0, RB: 0, WR: 0, TE: 0 } }));
  const DEFAULT_SCORING = PRESETS["My league"];

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const nz = (x) => (x == null || !isFinite(x) ? 0 : x);

  function normCdf(z) { // Abramowitz-Stegun
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }

  function build(data, weights) {
    const W = Object.assign({}, DEFAULT_WEIGHTS, weights || {});
    const C = data.coef, LG = C.lg, EFF = C.lgEff;
    const S = data.meta.season;
    // per-game weights for this season vs last season
    const wCur = 1 + 5 * W.recency;
    const wPrev = 1.25 * (1 - W.recency) + 0.15;

    // ---------- teams ----------
    const teamBase = {};
    const teamList = Object.keys(data.ratings.teams);
    for (const t of teamList) {
      const c = data.teamsCur[t] || { g: 0 }, p = data.teamsPrev[t] || { g: 0 };
      const K = 2; // games of league-average prior
      const wc = wCur * c.g, wp = wPrev * p.g;
      const den = wc + wp + K;
      const per = (k, lg) => (wc * nz(c[k]) / Math.max(c.g, 1) + wp * nz(p[k]) / Math.max(p.g, 1) + K * lg) / den;
      const lgTd = LG.imp * C.tdPerPt;
      const b = {
        pa: per("pa", LG.pa), ra: per("ra", LG.ra), py: per("py", LG.py), ry: per("ry", LG.ry),
        imp: per("imp", LG.imp), sk: per("sk", LG.sk),
        td: per("ptd", lgTd * C.passTdShare) + per("rtd", lgTd * (1 - C.passTdShare)),
        ptdShare: 0, fgm: per("fgm", LG.imp * C.fgmPerPt),
      };
      const ptd = per("ptd", lgTd * C.passTdShare);
      b.ptdShare = clamp(0.5 * ptd / Math.max(b.td, 0.1) + 0.5 * C.passTdShare, 0.4, 0.8);
      // defense
      const oDb = (x) => nz(x.o_pa) + nz(x.o_sk);
      const Kd = 8;
      const rate = (num, denf, lg) => {
        const n = wCur * nz(c[num]) + wPrev * nz(p[num]);
        const d = wCur * denf(c) + wPrev * denf(p);
        return (n + Kd * 30 * lg) / (d + Kd * 30);
      };
      b.defSackRate = rate("dsk", oDb, C.sackRate);
      b.defIntRate = rate("dint", (x) => nz(x.o_pa), C.intRate);
      b.defFrPg = (wCur * nz(c.dfr) + wPrev * nz(p.dfr) + Kd * C.fumRecPerG) / (wCur * c.g + wPrev * p.g + Kd);
      const pg = (k, lg, K) => (wCur * nz(c[k]) + wPrev * nz(p[k]) + K * lg) / (wCur * c.g + wPrev * p.g + K);
      b.defTdPg = pg("dtd", C.defTdPerG, 12);
      b.stTdPg = pg("sttd", C.stTdPerG, 16);
      b.safetyPg = pg("dsaf", C.safetyPerG || 0.022, 20);
      b.blockPg = pg("blkAll", C.blockPerG || 0.08, 16);
      // fantasy points allowed tilt by position (relative to overall defense quality)
      const Kf = 6;
      const ratio = {};
      let tot = 0;
      for (const pos of ["QB", "RB", "WR", "TE"]) {
        const lg = C.lgFpa[pos];
        const a = (wCur * nz(c.fpa && c.fpa[pos]) + wPrev * nz(p.fpa && p.fpa[pos]) + Kf * lg) / (wCur * c.g + wPrev * p.g + Kf);
        ratio[pos] = a / lg;
        tot += a;
      }
      const overall = tot / (C.lgFpa.QB + C.lgFpa.RB + C.lgFpa.WR + C.lgFpa.TE);
      b.tilt = {};
      for (const pos in ratio) b.tilt[pos] = ratio[pos] / overall;
      teamBase[t] = b;
    }

    // ---------- games by team/week ----------
    const R = data.ratings;
    const gameOf = {}; // `${team}|${week}` -> context
    for (const g of data.schedule) {
      let hImp, aImp, src = "line";
      if (g.spread != null && g.total != null) {
        hImp = (g.total + g.spread) / 2; aImp = (g.total - g.spread) / 2;
      } else {
        const h = g.neutral ? 0 : 1;
        hImp = R.mu + h * R.hfa / 2 + R.teams[g.home].off - R.teams[g.away].deff;
        aImp = R.mu - h * R.hfa / 2 + R.teams[g.away].off - R.teams[g.home].deff;
        src = "rating";
      }
      const played = g.hs != null;
      gameOf[g.home + "|" + g.week] = { g, team: g.home, opp: g.away, home: true, imp: hImp, oppImp: aImp, src, played };
      gameOf[g.away + "|" + g.week] = { g, team: g.away, opp: g.home, home: false, imp: aImp, oppImp: hImp, src, played };
    }

    function teamWeek(t, week) {
      const ctx = gameOf[t + "|" + week];
      if (!ctx) return null;
      const b = teamBase[t], v = W.vegas;
      const dImp = ctx.imp - b.imp;
      const fav = ctx.imp - ctx.oppImp;
      const baseFav = 2 * (b.imp - LG.imp);
      const dFav = fav - baseFav;
      const pa = Math.max(18, b.pa + v * (C.pa[0] * dImp + C.pa[1] * dFav));
      const ra = Math.max(15, b.ra + v * (C.ra[0] * dImp + C.ra[1] * dFav));
      const py = Math.max(120, b.py + v * (C.py[0] * dImp + C.py[1] * dFav));
      const ry = Math.max(50, b.ry + v * (C.ry[0] * dImp + C.ry[1] * dFav));
      const tdScale = Math.max(0.3, 1 + v * (ctx.imp / b.imp - 1));
      const td = b.td * tdScale;
      return Object.assign({}, ctx, { pa, ra, py, ry, td, ptd: td * b.ptdShare, rtd: td * (1 - b.ptdShare), fgm: b.fgm * (1 + 0.6 * (tdScale - 1)), sk: b.sk });
    }

    // ---------- players: blended usage + efficiency (independent of week) ----------
    const byTeam = {};
    const prof = {};
    for (const p of data.players) {
      const c = p.cur && p.cur.team === p.team ? p.cur : null;
      const pr = p.prev || null;
      const same = pr && pr.team === p.team ? 1 : 0.5;
      const gc = c ? c.g : 0, gp = pr ? pr.g : 0;
      const wc = wCur * gc, wp = wPrev * gp * same;
      const snap = p.snapCur || p.snapPrev || null;
      const up = C.usagePrior[p.pos] || { tgtPerSnap: 0, carPerSnap: 0 };
      const depthGuess = p.depth || 3;
      const priorT = snap ? snap * up.tgtPerSnap : ({ WR: 0.12, TE: 0.08, RB: 0.06, QB: 0 }[p.pos] || 0) / depthGuess;
      const priorC = snap ? snap * up.carPerSnap : ({ RB: 0.3, QB: 0.06 }[p.pos] || 0) / depthGuess;
      const Ks = 2.5;
      const share = (num, den, prior) => {
        const sc = c && c[den] > 0 ? c[num] / c[den] : 0;
        const sp = pr && pr[den] > 0 ? pr[num] / pr[den] : 0;
        return (wc * sc + wp * sp + Ks * prior) / (wc + wp + Ks);
      };
      const tgtSh = share("tgt", "tTgt", priorT);
      const carSh = share("ra", "tRa", priorC);
      const recTdAct = share("rectd", "tPtd", tgtSh);
      const rushTdAct = share("rtd", "tRtd", carSh);
      const alpha = clamp(0.3 + 0.3 * W.effReg, 0, 1);

      const E = EFF[p.pos] || EFF.WR;
      const wsum = (k) => (c ? wCur * nz(c[k]) : 0) + (pr ? wPrev * nz(pr[k]) : 0);
      const rg = (num, den, lg, K) => (wsum(num) + K * lg) / (wsum(den) + K);
      const e = W.effReg;
      const pf = {
        p, tgtSh, carSh,
        recTdSh: alpha * tgtSh + (1 - alpha) * recTdAct,
        rushTdSh: alpha * carSh + (1 - alpha) * rushTdAct,
        ypt: rg("recy", "tgt", E.ypt, 1 + 60 * e),
        catch: rg("rec", "tgt", E.catch, 1 + 40 * e),
        ypc: rg("ry", "ra", E.ypc, 1 + 90 * e),
        fum: E.fumPerTouch,
      };
      if (p.pos === "QB") {
        pf.ypa = rg("py", "pa", E.ypa, 1 + 180 * e);
        pf.cmp = rg("cmp", "pa", E.cmp, 1 + 150 * e);
        pf.intRate = rg("int", "pa", E.intRate, 1 + 400 * e);
        const attPg = (wsum("pa")) / Math.max(wc + wPrev * gp, 1e-9);
        pf.starter = p.depth === 1 ? 1 : (p.depth ? 0 : (attPg > 20 ? 1 : 0));
      }
      if (p.pos === "K") {
        pf.fg40 = rg("fg40", "fgm", EFF.K.fg40, 1 + 25 * e);
        pf.fg50 = rg("fg50", "fgm", EFF.K.fg50, 1 + 25 * e);
        pf.fg60 = rg("fg60", "fgm", EFF.K.fg60, 1 + 40 * e);
        pf.starter = p.depth === 1 ? 1 : 0;
      }
      prof[p.id] = pf;
      (byTeam[p.team] = byTeam[p.team] || []).push(pf);
    }
    // kicker fallback: if a team has no depth-1 K, use the one with most FG attempts
    for (const t in byTeam) {
      const ks = byTeam[t].filter((x) => x.p.pos === "K" && x.p.status !== "IR");
      if (ks.length && !ks.some((x) => x.starter)) ks.sort((a, b) => nz(b.p.cur && b.p.cur.fga) + nz(b.p.prev && b.p.prev.fga) - nz(a.p.cur && a.p.cur.fga) - nz(a.p.prev && a.p.prev.fga))[0].starter = 1;
      const qs = byTeam[t].filter((x) => x.p.pos === "QB" && x.p.status !== "IR");
      if (qs.length && !qs.some((x) => x.starter)) qs.sort((a, b) => nz(b.p.cur && b.p.cur.pa) - nz(a.p.cur && a.p.cur.pa))[0].starter = 1;
    }

    function availability(p, week, overrides) {
      if (overrides && overrides[p.id] != null) return overrides[p.id];
      if (p.status === "IR" || p.status === "INA") return 0;
      if (week === data.meta.week) {
        if (p.status === "Out") return 0;
        if (p.status === "Doubtful") return 0.25;
        if (p.status === "Questionable") return 0.9;
      }
      return 1;
    }

    // ---------- project one team-week ----------
    function projectTeamWeek(t, week, opts) {
      const tw = teamWeek(t, week);
      if (!tw) return [];
      const list = byTeam[t] || [];
      const ob = teamBase[tw.opp];
      const avail = new Map(list.map((x) => [x.p.id, availability(x.p, week, opts.avail)]));
      const sumOf = (f) => list.reduce((s, x) => s + f(x) * avail.get(x.p.id), 0);
      const nonQb = (x) => x.p.pos !== "QB" && x.p.pos !== "K";
      // normalize shares over available players
      const tgtTot = sumOf((x) => (nonQb(x) ? x.tgtSh : 0));
      const carTot = sumOf((x) => (x.p.pos !== "K" ? x.carSh : 0));
      const rtdTot = sumOf((x) => (nonQb(x) ? x.recTdSh : 0));
      const rutdTot = sumOf((x) => (x.p.pos !== "K" ? x.rushTdSh : 0));
      const tgtScale = tgtTot > 0 ? Math.min(0.98 / tgtTot, 1.5) : 0;
      const carScale = carTot > 0 ? Math.min(0.99 / carTot, 1.5) : 0;
      const rtdScale = rtdTot > 0 ? Math.min(1 / rtdTot, 1.6) : 0;
      const rutdScale = rutdTot > 0 ? Math.min(0.97 / rutdTot, 1.6) : 0;

      const qbs = list.filter((x) => x.p.pos === "QB" && x.starter && avail.get(x.p.id) > 0);
      const qb = qbs[0];
      const qbAvail = qb ? avail.get(qb.p.id) : 0;
      const teamYpaBase = teamBase[t].py / teamBase[t].pa;
      const vegasYpa = tw.py / tw.pa;
      const ypa = qb ? (0.5 * qb.ypa + 0.5 * teamYpaBase) * (vegasYpa / teamYpaBase) : vegasYpa * 0.9;
      const teamPy = tw.pa * ypa;
      const cmpRate = qb ? qb.cmp : EFF.QB.cmp * 0.95;
      const teamCmp = tw.pa * cmpRate;

      const mult = (pos) => {
        const tag = (opts.tags || []).filter((g) => g.team === tw.opp && (g.pos === pos || g.pos === "ALL")).reduce((s, g) => s + g.pct / 100, 0);
        return clamp(1 + W.matchup * (ob.tilt[pos] - 1), 0.8, 1.25) * (1 + tag);
      };

      // raw receiving lines, then scale to team totals
      const rows = [];
      let recYdRaw = 0, recRaw = 0, ryRaw = 0;
      for (const x of list) {
        const a = avail.get(x.p.id);
        if (!a || x.p.pos === "K") continue;
        const tgts = nonQb(x) ? tw.pa * x.tgtSh * tgtScale * a : 0;
        const car = tw.ra * x.carSh * carScale * a;
        const r = { x, a, tgts, car, recYdRaw: tgts * x.ypt, recRaw: tgts * x.catch, ryRaw: car * x.ypc };
        recYdRaw += r.recYdRaw; recRaw += r.recRaw; ryRaw += r.ryRaw;
        rows.push(r);
      }
      const shareUsed = Math.min(tgtTot * tgtScale, 1);
      const ydScale = recYdRaw > 0 ? (teamPy * shareUsed) / recYdRaw : 1;
      const recScale = recRaw > 0 ? (teamCmp * shareUsed) / recRaw : 1;
      const ryScale = ryRaw > 0 ? tw.ry / ryRaw : 1;

      const out = [];
      for (const r of rows) {
        const x = r.x, p = x.p, m = mult(p.pos);
        const s = { tgt: r.tgts, rec: r.recRaw * recScale * m, recYd: r.recYdRaw * ydScale * m,
          recTd: nonQb(x) ? tw.ptd * x.recTdSh * rtdScale * r.a * m : 0,
          car: r.car, rushYd: r.ryRaw * ryScale * m, rushTd: tw.rtd * x.rushTdSh * rutdScale * r.a * m,
          pa: 0, cmp: 0, passYd: 0, passTd: 0, int: 0, compPct: 0, twoPt: 0 };
        const two = (C.twoPtPerG || 0.108) * (tw.td / Math.max(teamBase[t].td, 0.5));
        s.twoPt = two * (1 - (C.twoPtPassShare || 0.6)) * x.rushTdSh * rutdScale * r.a + (nonQb(x) ? two * (C.twoPtPassShare || 0.6) * x.recTdSh * rtdScale * r.a : 0);
        if (p.pos === "QB" && x === qb) {
          s.pa = tw.pa * qbAvail; s.cmp = teamCmp * qbAvail * m; s.passYd = teamPy * qbAvail * m;
          s.passTd = tw.ptd * qbAvail * m; s.int = tw.pa * x.intRate * qbAvail * (2 - m);
          s.compPct = 100 * cmpRate * Math.min(m, 1.05); s.twoPt += two * (C.twoPtPassShare || 0.6) * qbAvail;
        }
        s.fumLost = (s.car + s.rec) * x.fum;
        out.push({ id: p.id, week, opp: tw.opp, home: tw.home, imp: tw.imp, oppImp: tw.oppImp, src: tw.src, avail: r.a, matchup: m, s });
      }
      // kicker
      const k = list.find((x) => x.p.pos === "K" && x.starter && avail.get(x.p.id) > 0);
      if (k) {
        const fgm = tw.fgm;
        out.push({ id: k.p.id, week, opp: tw.opp, home: tw.home, imp: tw.imp, oppImp: tw.oppImp, src: tw.src, avail: 1, matchup: 1,
          s: { fgm, fg40: fgm * k.fg40, fg50: fgm * k.fg50, fg60: fgm * k.fg60, xp: tw.td * C.xpPerTd } });
      }
      // defense (this team's D vs opponent offense)
      const otw = teamWeek(tw.opp, week);
      const b = teamBase[t];
      const oppDb = otw.pa + otw.sk;
      const dScale = 1 + W.vegas * 0.5 * (LG.imp / Math.max(tw.oppImp, 8) - 1); // bad offenses give up more sacks/turnovers
      out.push({ id: "DEF_" + t, week, opp: tw.opp, home: tw.home, imp: tw.imp, oppImp: tw.oppImp, src: tw.src, avail: 1, matchup: 1,
        s: { sack: oppDb * b.defSackRate * dScale, dint: otw.pa * b.defIntRate * dScale, fr: b.defFrPg * dScale, dtd: b.defTdPg * dScale,
          safety: b.safetyPg * dScale, paMean: tw.oppImp } });
      out.push({ id: "ST_" + t, week, opp: tw.opp, home: tw.home, imp: tw.imp, oppImp: tw.oppImp, src: tw.src, avail: 1, matchup: 1,
        s: { sttd: b.stTdPg, block: b.blockPg } });
      // head coach: win probability from moneylines when posted, else from the implied margin
      let pWin;
      const g = tw.g;
      if (g.hml != null && g.aml != null && tw.src === "line") {
        const conv = (ml) => (ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));
        const ph = conv(g.hml), pa = conv(g.aml);
        pWin = (tw.home ? ph : pa) / (ph + pa);
      } else pWin = normCdf((tw.imp - tw.oppImp) / 13.3);
      out.push({ id: "HC_" + t, week, opp: tw.opp, home: tw.home, imp: tw.imp, oppImp: tw.oppImp, src: tw.src, avail: 1, matchup: 1,
        s: { win: pWin, margin: tw.imp - tw.oppImp } });
      return out;
    }

    function projectWeek(week, opts) {
      opts = opts || {};
      let res = [];
      for (const t of teamList) res = res.concat(projectTeamWeek(t, week, opts));
      return res;
    }

    function byeWeek(t) {
      for (let w = 1; w <= 18; w++) if (!gameOf[t + "|" + w]) return w;
      return null;
    }

    return { W, projectWeek, teamWeek, teamBase, byeWeek, prof, gameOf, teams: teamList };
  }

  // ---------- scoring ----------
  // log-gamma and regularized lower incomplete gamma (Numerical Recipes)
  function gammaln(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }
  function gammaP(a, x) {
    if (x <= 0) return 0;
    const gln = gammaln(a);
    if (x < a + 1) {
      let ap = a, sum = 1 / a, del = sum;
      for (let n = 0; n < 200; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-8) break; }
      return sum * Math.exp(-x + a * Math.log(x) - gln);
    }
    let b = x + 1 - a, c = 1 / 1e-30, d = 1 / b, h = d;
    for (let i = 1; i < 200; i++) {
      const an = -i * (i - a); b += 2;
      d = an * d + b; if (Math.abs(d) < 1e-30) d = 1e-30;
      c = b + an / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-8) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
  }
  // P(Y >= y) for a yardage total with the given mean
  function survival(kind, mean, y, C) {
    const sd = (C && C.sd) || { passYd: 65, yardK: 4.6 };
    if (mean <= 0.1) return y <= 0 ? 1 : 0;
    if (kind === "pass") return 1 - normCdf((y - 0.5 - mean) / sd.passYd);
    // rushing/receiving yards: gamma with sd ~= k * sqrt(mean), fit on 2025 player-games
    const variance = sd.yardK * sd.yardK * mean;
    const shape = mean * mean / variance, scale = variance / mean;
    return 1 - gammaP(shape, Math.max(y - 0.5, 0) / scale);
  }
  function yardPoints(rule, kind, mean, C) {
    if (!rule || !mean) return 0;
    if (rule.mode === "linear") return rule.per ? mean / rule.per : 0;
    if (rule.mode === "floor") {
      if (!rule.per) return 0;
      let ev = 0;
      for (let k = 1; k < 80; k++) { const pr = survival(kind, mean, k * rule.per, C); ev += pr; if (pr < 1e-4) break; }
      return ev;
    }
    // tiers: points of the highest threshold reached
    const t = (rule.tiers || []).slice().sort((a, b) => a[0] - b[0]);
    let ev = 0;
    for (let i = 0; i < t.length; i++) {
      const pIn = survival(kind, mean, t[i][0], C) - (i + 1 < t.length ? survival(kind, mean, t[i + 1][0], C) : 0);
      ev += pIn * t[i][1];
    }
    return ev;
  }

  function score(proj, pos, sc, C) {
    sc = sc || DEFAULT_SCORING;
    const s = proj.s;
    const longTd = (C && C.longTdShare) || 0.09, longRet = (C && C.longRetTdShare) || 0.6;
    if (pos === "K") {
      const k = sc.k;
      return s.fgm * k.fg + s.fg40 * k.b40 + s.fg50 * k.b50 + s.fg60 * k.b60 + s.xp * k.xp;
    }
    if (pos === "DEF") {
      const d = sc.def, sdPts = (C && C.ptsSd) || 9;
      let ev = 0, prevCdf = 0;
      for (const [max, pts] of d.pa.slice().sort((a, b) => a[0] - b[0])) {
        const cdf = normCdf((max + 0.5 - s.paMean) / sdPts);
        ev += (cdf - prevCdf) * pts; prevCdf = cdf;
      }
      return ev + s.sack * d.sack + s.dint * d.int + s.fr * d.fr + s.dtd * (d.td + longRet * d.longTd) + s.safety * d.safety;
    }
    if (pos === "ST") return s.sttd * (sc.st.td + longRet * sc.st.longTd) + s.block * sc.st.block;
    if (pos === "HC") return s.win * sc.hc.win + (1 - s.win) * sc.hc.loss;
    let pts = s.passTd * (sc.passTd + longTd * sc.longTd) + s.int * sc.int +
      s.rushTd * (sc.rushTd + longTd * sc.longTd) + s.recTd * (sc.recTd + longTd * sc.longTd) +
      s.rec * ((sc.rec && sc.rec[pos]) || 0) + s.fumLost * sc.fumLost + nz(s.twoPt) * sc.twoPt +
      yardPoints(sc.rushYd, "rush", s.rushYd, C) + yardPoints(sc.recYd, "rec", s.recYd, C);
    if (s.pa > 0) {
      pts += yardPoints(sc.passYd, "pass", s.passYd, C);
      if (sc.compBonus && sc.compBonus.pts) {
        const sdc = ((C && C.sd && C.sd.compPct) || 8.5) * Math.sqrt(32 / Math.max(s.pa, 10));
        pts += sc.compBonus.pts * (1 - normCdf((sc.compBonus.min - s.compPct) / sdc));
      }
    }
    return pts;
  }

  const api = { build, score, yardPoints, survival, DEFAULT_WEIGHTS, DEFAULT_SCORING, PRESETS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FFEngine = api;
})(this);
