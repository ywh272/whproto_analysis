// 통계·분석 로직 (UI와 분리)

export const KIND_LABEL = { wdl: '승무패', wl: '승패', handicap: '핸디캡', ou: '언더오버', sum: 'SUM(홀짝)', margin: '승N패', other: '기타' };
export const ODDS_BINS = [1.0, 1.3, 1.6, 2.0, 2.5, 3.5, 5.0, Infinity];
export const binOf = o => { for (let i = 0; i < ODDS_BINS.length - 1; i++) if (o >= ODDS_BINS[i] && o < ODDS_BINS[i + 1]) return i; return ODDS_BINS.length - 2; };
export const binLabel = i => ODDS_BINS[i + 1] === Infinity ? `${ODDS_BINS[i].toFixed(1)}+` : `${ODDS_BINS[i].toFixed(2)}–${(ODDS_BINS[i + 1] - 0.01).toFixed(2)}`;

export const isResolved = g => g.outcome != null && g.outcome >= 0 && !g.void;
export const matchKey = g => `${g.sport}|${g.date}|${g.home}|${g.away}`;

export function implied(odds) {
  const inv = odds.map(o => (o ? 1 / o : 0));
  const s = inv.reduce((a, b) => a + b, 0) || 1;
  return inv.map(v => v / s);
}

// 각 선택지의 배당 순위: 0 = 정배(가장 낮은 배당)
export function oddsRank(odds) {
  const idx = odds.map((o, i) => [o ?? Infinity, i]).sort((a, b) => a[0] - b[0]);
  const r = []; idx.forEach(([, i], k) => { r[i] = k; });
  return r;
}

// 적중 선택지의 성격: 정배 / 역배 / 무(중간) / 동배
export function outcomeType(g) {
  const o = g.odds;
  const valid = o.filter(v => v != null);
  const min = Math.min(...valid);
  if (valid.filter(v => v === min).length > 1 && o[g.outcome] === min) return '동배';
  if ((g.labels.length === 3) && g.outcome === 1) return '무/중간';
  return o[g.outcome] === min ? '정배' : '역배';
}

export function applyFilters(games, f) {
  return games.filter(g =>
    (!f.sport || g.sport === f.sport) &&
    (!f.league || g.league === f.league) &&
    (!f.kind || g.kind === f.kind) &&
    (f.half === 'all' || (f.half === 'full' ? !g.half : g.half)) &&
    (!f.roundFrom || g.round >= f.roundFrom) &&
    (!f.roundTo || g.round <= f.roundTo));
}

// ── 배당 흐름 ──────────────────────────────────────────
export function oddsFlow(resolved) {
  const types = { '정배': 0, '역배': 0, '무/중간': 0, '동배': 0 };
  const bins = ODDS_BINS.slice(0, -1).map((_, i) => ({ i, label: binLabel(i), n: 0, hit: 0, impl: 0, ret: 0 }));
  const winOddsBins = ODDS_BINS.slice(0, -1).map((_, i) => ({ i, label: binLabel(i), n: 0 }));
  let favN = 0, favHit = 0, winOddsSum = 0;
  const byKind = {};
  const byRound = {};
  for (const g of resolved) {
    const t = outcomeType(g); types[t]++;
    const imp = implied(g.odds);
    g.odds.forEach((o, i) => {
      if (o == null) return;
      const b = bins[binOf(o)];
      b.n++; b.impl += imp[i];
      if (i === g.outcome) { b.hit++; b.ret += o; }
    });
    const wo = g.odds[g.outcome]; winOddsSum += wo; winOddsBins[binOf(wo)].n++;
    const k = g.kind + (g.half ? '_h' : '');
    byKind[k] ??= { kind: g.kind, half: g.half, n: 0, types: { '정배': 0, '역배': 0, '무/중간': 0, '동배': 0 }, winOdds: 0 };
    byKind[k].n++; byKind[k].types[t]++; byKind[k].winOdds += wo;
    if (t !== '동배') { favN++; if (t === '정배') favHit++; }
    const rk = `${g.year}-${String(g.round).padStart(3, '0')}`;
    byRound[rk] ??= { round: g.round, year: g.year, n: 0, fav: 0, favN: 0 };
    byRound[rk].n++;
    if (t !== '동배') { byRound[rk].favN++; if (t === '정배') byRound[rk].fav++; }
  }
  bins.forEach(b => { b.rate = b.n ? b.hit / b.n : null; b.implAvg = b.n ? b.impl / b.n : null; b.roi = b.n ? b.ret / b.n - 1 : null; });
  return {
    n: resolved.length, types, favN, favHit, favRate: favN ? favHit / favN : null,
    avgWinOdds: resolved.length ? winOddsSum / resolved.length : null,
    bins, winOddsBins, byKind: Object.values(byKind),
    byRound: Object.entries(byRound).sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v),
  };
}

// ── 경기(매치) 단위 묶기: 실제 스코어·합계 복원 ─────────────
export function buildMatches(games) {
  const map = new Map();
  for (const g of games) {
    const k = matchKey(g);
    let m = map.get(k);
    if (!m) { m = { key: k, sport: g.sport, league: g.league, date: g.date, time: g.time, home: g.home, away: g.away, round: g.round, year: g.year, markets: [] }; map.set(k, m); }
    m.markets.push(g);
  }
  for (const m of map.values()) {
    const full = m.markets.filter(g => !g.half && g.resultRaw && !g.void);
    const main = full.find(g => (g.kind === 'wdl' || g.kind === 'wl') && g.resultRaw.includes(':'));
    if (main) { const [a, b] = main.resultRaw.split(':').map(Number); m.hs = a; m.as = b; }
    else {
      const h = full.find(g => g.kind === 'handicap' && g.resultRaw.includes(':') && g.line != null);
      if (h) { const [a, b] = h.resultRaw.split(':').map(Number); m.hs = +(a - h.line).toFixed(1); m.as = b; }
    }
    const tot = full.find(g => g.kind === 'ou' || g.kind === 'sum');
    if (tot) m.total = parseFloat(tot.resultRaw);
    else if (m.hs != null) m.total = m.hs + m.as;
    const mainOdds = m.markets.find(g => !g.half && (g.kind === 'wdl' || g.kind === 'wl'));
    m.mainOdds = mainOdds ? mainOdds.odds : null;
    m.mainKind = mainOdds ? mainOdds.kind : null;
    m.finished = m.hs != null;
    if (m.finished) m.res = m.hs > m.as ? 'H' : m.hs < m.as ? 'A' : 'D';
  }
  return [...map.values()].sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
}

function teamSideOutcome(g, isHome) {
  // 팀 관점의 결과: 'W' / 'D' / 'L'
  if (!isResolved(g)) return null;
  const n = g.labels.length;
  if (n === 3) return g.outcome === 1 ? 'D' : (g.outcome === 0) === isHome ? 'W' : 'L';
  return (g.outcome === 0) === isHome ? 'W' : 'L';
}

// ── 팀별 ─────────────────────────────────────────────
export function teamStats(matches) {
  const T = new Map();
  const get = (name, m) => {
    const k = `${m.sport}|${name}`;
    if (!T.has(k)) T.set(k, { key: k, team: name, sport: m.sport, leagues: new Set(), n: 0, W: 0, D: 0, L: 0, gf: 0, ga: 0, form: [],
      favN: 0, favW: 0, dogN: 0, dogW: 0, hcN: 0, hcW: 0, ouN: 0, over: 0, sumN: 0, odd: 0, totals: [], homeN: 0, homeW: 0, awayN: 0, awayW: 0 });
    return T.get(k);
  };
  for (const m of matches) {
    if (!m.finished) continue;
    for (const isHome of [true, false]) {
      const t = get(isHome ? m.home : m.away, m);
      t.leagues.add(m.league);
      t.n++;
      const gf = isHome ? m.hs : m.as, ga = isHome ? m.as : m.hs;
      t.gf += gf; t.ga += ga;
      const r = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
      t[r]++;
      if (isHome) { t.homeN++; if (r === 'W') t.homeW++; } else { t.awayN++; if (r === 'W') t.awayW++; }
      t.form.push({ date: m.date, r, opp: isHome ? m.away : m.home, score: `${m.hs}:${m.as}`, home: isHome });
      if (m.mainOdds) {
        const my = m.mainOdds[isHome ? 0 : m.mainOdds.length - 1], op = m.mainOdds[isHome ? m.mainOdds.length - 1 : 0];
        if (my != null && op != null && my !== op) {
          if (my < op) { t.favN++; if (r === 'W') t.favW++; } else { t.dogN++; if (r === 'W') t.dogW++; }
        }
      }
      for (const g of m.markets) {
        if (!isResolved(g) || g.half) continue;
        if (g.kind === 'handicap') { t.hcN++; if (teamSideOutcome(g, isHome) === 'W') t.hcW++; }
        if (g.kind === 'ou') { t.ouN++; if (g.labels[g.outcome] === '오버') t.over++; }
        if (g.kind === 'sum') { t.sumN++; if (g.labels[g.outcome] === '홀') t.odd++; }
      }
      if (m.total != null) t.totals.push(m.total);
    }
  }
  return [...T.values()].map(t => ({
    ...t, leagues: [...t.leagues].join(', '),
    winRate: t.n ? t.W / t.n : null, drawRate: t.n ? t.D / t.n : null, lossRate: t.n ? t.L / t.n : null,
    gfAvg: t.n ? t.gf / t.n : null, gaAvg: t.n ? t.ga / t.n : null,
    favRate: t.favN ? t.favW / t.favN : null, dogRate: t.dogN ? t.dogW / t.dogN : null,
    hcRate: t.hcN ? t.hcW / t.hcN : null, overRate: t.ouN ? t.over / t.ouN : null, oddRate: t.sumN ? t.odd / t.sumN : null,
    totalAvg: t.totals.length ? t.totals.reduce((a, b) => a + b, 0) / t.totals.length : null,
    form: t.form.sort((a, b) => b.date.localeCompare(a.date)),
  }));
}

// ── 종목·리그별 ───────────────────────────────────────
export function groupStats(matches, games, keyFn) {
  const G = new Map();
  const get = k => { if (!G.has(k)) G.set(k, { key: k, n: 0, H: 0, D: 0, A: 0, favN: 0, favW: 0, totals: [], ouN: 0, over: 0, sumN: 0, odd: 0, hcN: 0, hcHome: 0, mk: 0 }); return G.get(k); };
  for (const m of matches) {
    if (!m.finished) continue;
    const s = get(keyFn(m));
    s.n++; s[m.res]++;
    if (m.total != null) s.totals.push(m.total);
    if (m.mainOdds) {
      const [h, a] = [m.mainOdds[0], m.mainOdds[m.mainOdds.length - 1]];
      if (h !== a) { s.favN++; if ((h < a && m.res === 'H') || (a < h && m.res === 'A')) s.favW++; }
    }
  }
  for (const g of games) {
    if (!isResolved(g) || g.half) continue;
    const s = G.get(keyFn(g)); if (!s) continue;
    s.mk++;
    if (g.kind === 'ou') { s.ouN++; if (g.labels[g.outcome] === '오버') s.over++; }
    if (g.kind === 'sum') { s.sumN++; if (g.labels[g.outcome] === '홀') s.odd++; }
    if (g.kind === 'handicap') { s.hcN++; if (g.outcome === 0) s.hcHome++; }
  }
  return [...G.values()].map(s => ({
    ...s, homeRate: s.n ? s.H / s.n : null, drawRate: s.n ? s.D / s.n : null, awayRate: s.n ? s.A / s.n : null,
    favRate: s.favN ? s.favW / s.favN : null, totalAvg: s.totals.length ? s.totals.reduce((a, b) => a + b, 0) / s.totals.length : null,
    overRate: s.ouN ? s.over / s.ouN : null, oddRate: s.sumN ? s.odd / s.sumN : null, hcHomeRate: s.hcN ? s.hcHome / s.hcN : null,
  })).sort((a, b) => b.n - a.n);
}

// ── 상대전적 ──────────────────────────────────────────
export function headToHead(matches, a, b) {
  return matches.filter(m => m.finished && ((m.home === a && m.away === b) || (m.home === b && m.away === a)));
}

// ── 예측 점수 ─────────────────────────────────────────
// 각 선택지에 대해: 배당 내재확률 + 과거 동일 조건 적중률 + 팀 성적 + 상대전적을 섞은 "과거 기준 적중 경향 점수"
export function buildModel(resolved, matches) {
  const calib = new Map(); // sport|kind|half|labelCount|rank|bin → {n,hit}
  const calibCoarse = new Map(); // kind|rank|bin
  for (const g of resolved) {
    const rk = oddsRank(g.odds);
    g.odds.forEach((o, i) => {
      if (o == null) return;
      const k1 = `${g.sport}|${g.kind}|${g.half}|${g.labels.length}|${rk[i]}|${binOf(o)}`;
      const k2 = `${g.kind}|${g.labels.length}|${rk[i]}|${binOf(o)}`;
      for (const [M, k] of [[calib, k1], [calibCoarse, k2]]) {
        const c = M.get(k) || { n: 0, hit: 0 }; c.n++; if (i === g.outcome) c.hit++; M.set(k, c);
      }
    });
  }
  const teams = new Map(teamStats(matches).map(t => [t.key, t]));
  return { calib, calibCoarse, teams, matches };
}

const shrink = (hit, n, prior, k) => (hit + prior * k) / (n + k);

export function scoreGame(model, g) {
  const imp = implied(g.odds);
  const rk = oddsRank(g.odds);
  const ht = model.teams.get(`${g.sport}|${g.home}`), at = model.teams.get(`${g.sport}|${g.away}`);
  const h2h = headToHead(model.matches, g.home, g.away);
  const opts = g.odds.map((o, i) => {
    if (o == null) return null;
    const parts = []; let wsum = 0, psum = 0;
    const add = (name, p, w, note) => { if (p == null || isNaN(p)) return; parts.push({ name, p, w, note }); wsum += w; psum += p * w; };
    add('배당', imp[i], 0.5, `배당 내재확률`);
    let c = model.calib.get(`${g.sport}|${g.kind}|${g.half}|${g.labels.length}|${rk[i]}|${binOf(o)}`);
    let scope = '같은 종목·유형·배당구간';
    if (!c || c.n < 10) { c = model.calibCoarse.get(`${g.kind}|${g.labels.length}|${rk[i]}|${binOf(o)}`); scope = '같은 유형·배당구간(전 종목)'; }
    if (c && c.n > 0) add('과거구간', shrink(c.hit, c.n, imp[i], 20), 0.25 * Math.min(1, c.n / 30), `${scope} ${c.hit}/${c.n} 적중`);
    // 팀 성적
    const lab = g.labels[i];
    if (!g.half && ht && at) {
      let p = null, n = Math.min(ht.n, at.n), note = '';
      if (g.kind === 'wdl' || g.kind === 'wl') {
        if (i === 0) { p = (ht.winRate + at.lossRate) / 2; note = `홈 승률 ${pct(ht.winRate)} · 원정 패율 ${pct(at.lossRate)}`; }
        else if (i === g.labels.length - 1) { p = (at.winRate + ht.lossRate) / 2; note = `원정 승률 ${pct(at.winRate)} · 홈 패율 ${pct(ht.lossRate)}`; }
        else { p = (ht.drawRate + at.drawRate) / 2; note = `무승부율 ${pct(ht.drawRate)} / ${pct(at.drawRate)}`; }
      } else if (g.kind === 'handicap' && ht.hcN && at.hcN && g.labels.length === 2) {
        n = Math.min(ht.hcN, at.hcN);
        p = i === 0 ? (ht.hcRate + (1 - at.hcRate)) / 2 : (at.hcRate + (1 - ht.hcRate)) / 2;
        note = `핸디캡 성공률 홈 ${pct(ht.hcRate)} · 원정 ${pct(at.hcRate)}`;
      } else if (g.kind === 'ou' && g.line != null && ht.totals.length && at.totals.length) {
        const all = ht.totals.concat(at.totals);
        n = Math.min(ht.totals.length, at.totals.length);
        const overShare = all.filter(t => t > g.line).length / all.length;
        p = lab === '오버' ? overShare : 1 - overShare;
        note = `두 팀 경기 평균 합계 ${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(1)} (기준 ${g.line})`;
      }
      if (p != null && n > 0) add('팀성적', shrink(p * n, n, imp[i], 6), 0.2 * Math.min(1, n / 8), `${note} (각 ${ht.n}·${at.n}경기)`);
    }
    if (!g.half && h2h.length && (g.kind === 'wdl' || g.kind === 'wl')) {
      const hits = h2h.filter(m => {
        const homeIsHome = m.home === g.home;
        const r = m.res === 'D' ? 'D' : ((m.res === 'H') === homeIsHome ? 'H' : 'A');
        return (i === 0 && r === 'H') || (i === g.labels.length - 1 && r === 'A') || (g.labels.length === 3 && i === 1 && r === 'D');
      }).length;
      add('상대전적', shrink(hits, h2h.length, imp[i], 3), 0.05 * Math.min(1, h2h.length / 3), `상대전적 ${hits}/${h2h.length}`);
    }
    return { i, label: lab, odds: o, implied: imp[i], raw: psum / wsum, parts };
  });
  const tot = opts.reduce((a, o) => a + (o ? o.raw : 0), 0) || 1;
  opts.forEach(o => { if (o) { o.p = o.raw / tot; o.ev = o.p * o.odds; o.edge = o.p - o.implied; } });
  const valid = opts.filter(Boolean);
  const best = valid.reduce((a, b) => (b.p > a.p ? b : a), valid[0]);
  const confidence = Math.min(1, (best.parts.find(p => p.name === '과거구간') ? 0.5 : 0) + (best.parts.find(p => p.name === '팀성적') ? 0.4 : 0) + (best.parts.find(p => p.name === '상대전적') ? 0.1 : 0));
  return { g, opts, best, confidence, h2hN: h2h.length };
}

export const pct = (v, d = 0) => (v == null || isNaN(v) ? '–' : (v * 100).toFixed(d) + '%');
