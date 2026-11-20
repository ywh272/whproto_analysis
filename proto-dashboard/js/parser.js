// 프로토 승부식 PDF(betman 인쇄하기 → PDF 저장) 파서
// 브라우저/Node 공용: parseProtoPdf(pdfjsLib, Uint8Array) → { meta, games:[...] }

export async function pdfLines(pdfjsLib, data) {
  const doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const pg = await doc.getPage(p);
    const tc = await pg.getTextContent();
    const items = tc.items
      .filter(i => i.str !== '')
      .map(i => ({ s: i.str.replace(/\u0001/g, ' '), x: i.transform[4], y: i.transform[5], w: i.width }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of items) {
      let r = rows.find(r => Math.abs(r.y - it.y) < 2.5);
      if (!r) { r = { y: it.y, its: [] }; rows.push(r); }
      r.its.push(it);
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.its.sort((a, b) => a.x - b.x);
      const cells = []; let cur = null, end = 0;
      for (const it of r.its) {
        if (!it.s.trim() && it.w > 5) { cur = null; end = it.x + it.w; continue; }
        if (cur && it.x - end < 3) cur.s += it.s;
        else { cur = { s: it.s, x: it.x }; cells.push(cur); }
        end = it.x + it.w;
      }
      const cs = cells.map(c => ({ s: c.s.replace(/\s+/g, ' ').trim(), x: Math.round(c.x) })).filter(c => c.s);
      if (cs.length) out.push({ p, y: Math.round(r.y), cells: cs });
    }
  }
  return out;
}

const SPORTS = ['축구', '농구', '야구', '배구', '하키', '아이스하키', '미식축구', '핸드볼', '골프', 'E스포츠', 'e스포츠'];
const RE_DATE = /^(\d{2})\.(\d{2}) \((.)\)$/;
const RE_TIME = /^(\d{2}):(\d{2})$/;
const RE_CLOSE = /^(\d{2}):(\d{2}) 마감$/;
const RE_NUM = /^\d{1,5}$/;
const RE_ODD = /^(\d+\.\d{2}|-)$/;
const RE_SCORE = /^-?\d+(\.\d+)?(:-?\d+(\.\d+)?)?$/;
const RE_PRODUCT = new RegExp('^(' + SPORTS.join('|') + ') (.+)$');

function parseMarket(sport, rest) {
  let half = false;
  let r = rest.trim();
  if (r.startsWith('전반 ')) { half = true; r = r.slice(3); }
  let line = null, m;
  if ((m = r.match(/^(.*?)\s*H\s*([+-]?\d+(\.\d+)?)$/))) { line = parseFloat(m[2]); r = m[1].trim(); }
  else if ((m = r.match(/^(.*?)\s*U\/O\s*(\d+(\.\d+)?)$/))) { line = parseFloat(m[2]); r = m[1].trim(); }
  let kind = 'other';
  if (r === '승무패') kind = 'wdl';
  else if (r === '승패') kind = 'wl';
  else if (/핸디캡$/.test(r)) kind = 'handicap';
  else if (r === '언더오버') kind = 'ou';
  else if (r === 'SUM') kind = 'sum';
  else if ((m = r.match(/^승(\d+)패$/))) { kind = 'margin'; line = +m[1]; }
  return { market: (half ? '전반 ' : '') + r, kind, half, line };
}

// 결과값(화면 표기)으로 적중 선택지 계산
export function computeOutcome(g) {
  const raw = g.resultRaw;
  if (raw == null || !RE_SCORE.test(raw)) return null;
  const labels = g.labels;
  if (g.kind === 'ou') {
    const t = parseFloat(raw);
    if (g.line == null || isNaN(t)) return null;
    return t < g.line ? labels.indexOf('언더') : labels.indexOf('오버');
  }
  if (g.kind === 'sum') {
    const t = parseFloat(raw.includes(':') ? raw.split(':').reduce((a, b) => +a + +b, 0) : raw);
    if (!Number.isInteger(t)) return null;
    return t % 2 === 1 ? labels.indexOf('홀') : labels.indexOf('짝');
  }
  if (raw.includes(':')) {
    const [a, b] = raw.split(':').map(Number);
    if (g.kind === 'margin') { const d = a - b, n = g.line; return d > n ? 0 : d < -n ? 2 : 1; }
    if (labels.length === 3) return a > b ? 0 : a === b ? 1 : 2;
    if (labels.length === 2) return a > b ? 0 : a < b ? 1 : null;
  }
  return null;
}

export async function parseProtoPdf(pdfjsLib, data, fileName = '') {
  const lines = await pdfLines(pdfjsLib, data);
  const meta = { round: null, year: null, title: '', fileName };
  for (const l of lines.slice(0, 15)) {
    for (const c of l.cells) {
      let m;
      if (!meta.round && (m = c.s.match(/(\d+)회차/))) { meta.round = +m[1]; meta.title = c.s; }
      if (!meta.year && (m = c.s.match(/^(\d{2})\.(\d{2})\.(\d{2})\(/))) { meta.year = 2000 + +m[1]; meta.saleMonth = +m[2]; }
    }
  }
  if (!meta.round) throw new Error('회차 정보를 찾지 못했습니다 (프로토 승부식 PDF가 맞는지 확인)');
  meta.year = meta.year || new Date().getFullYear();

  const games = [];
  let prevFrag = '', lastDate = null, match = null, pendingNum = null, pendingStatus = null, labels = null, last = null, waitTime = false;
  const fullDate = (mm, dd) => {
    let y = meta.year;
    if (meta.saleMonth && meta.saleMonth === 12 && +mm === 1) y += 1;
    return `${y}-${mm}-${dd}`;
  };

  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].cells;
    const ss = cells.map(c => c.s);
    // 리그명이 두 줄로 줄바꿈된 경우(예: 잉글랜드 / 프리미어리그)
    const frag = cells.filter(c => c.x >= 95 && c.x < 200 && !RE_PRODUCT.test(c.s) && !c.s.startsWith('조합') && !RE_NUM.test(c.s) && c.s !== 'VS').map(c => c.s).join(' ');

    // 경기 헤더 (리그 | 홈 | VS | 원정)
    const vs = ss.indexOf('VS');
    if (vs > 0 && vs < ss.length - 1) {
      const home = ss[vs - 1], away = ss.slice(vs + 1).join(' ');
      let league = cells.slice(0, vs - 1).filter(c => c.x < 200).map(c => c.s).join(' ');
      if (!league && prevFrag) league = prevFrag;
      match = { date: lastDate, time: null, league, home, away, _fragNext: !cells.slice(0, vs - 1).some(c => c.x < 200) };
      waitTime = true; last = null; pendingNum = null; prevFrag = '';
      continue;
    }
    if (match && match._fragNext && frag) { match.league = (match.league + ' ' + frag).trim(); match._fragNext = false; }
    else if (match) match._fragNext = false;
    prevFrag = frag;

    let usedProduct = false;
    for (let j = 0; j < cells.length; j++) {
      const c = cells[j], s = c.s;
      let m;
      if ((m = s.match(RE_DATE)) && c.x < 80) { lastDate = fullDate(m[1], m[2]); continue; }
      if ((m = s.match(RE_TIME)) && c.x < 80 && waitTime && match) { match.time = s; waitTime = false; continue; }
      if (s === '결과보기' || s === '발매마감' || RE_CLOSE.test(s)) { pendingStatus = s; continue; }
      if (s === '승' || s === '무' || s === '패' || s === '언더' || s === '오버' || s === '홀' || s === '짝' || (/^\d{1,2}$/.test(s) && c.x > 300 && labels && labels._line === i)) {
        if (j === 0 || !labels || labels._line !== i) { labels = []; labels._line = i; }
        labels.push(s); continue;
      }
      if (RE_NUM.test(s) && c.x >= 70 && c.x < 115) { pendingNum = +s; continue; }
      if ((m = s.match(RE_PRODUCT)) && c.x >= 110 && c.x < 140 && match) {
        let rest = m[2];
        if (cells[j + 1] && /^(H|U\/O)\s/.test(cells[j + 1].s) && cells[j + 1].x < 300) { rest += ' ' + cells[j + 1].s; j++; }
        const odds = [];
        while (cells[j + 1] && RE_ODD.test(cells[j + 1].s)) { odds.push(cells[j + 1].s === '-' ? null : parseFloat(cells[j + 1].s)); j++; }
        const mk = parseMarket(m[1], rest);
        const lab = labels && labels.length === odds.length ? labels.slice() :
          (odds.length === 3 ? ['승', '무', '패'] : mk.kind === 'ou' ? ['언더', '오버'] : mk.kind === 'sum' ? ['홀', '짝'] : ['승', '패']);
        const g = {
          round: meta.round, year: meta.year, num: pendingNum,
          date: match.date, time: match.time, sport: m[1], league: match.league,
          home: match.home, away: match.away,
          market: mk.market, kind: mk.kind, half: mk.half, line: mk.line,
          labels: lab, odds, status: pendingStatus, resultRaw: null, outcome: null,
        };
        games.push(g); last = g; usedProduct = true;
        pendingNum = null; labels = null; pendingStatus = null;
        continue;
      }
      // 결과값 (상품 아래 왼쪽 칸)
      if (last && c.x < 80 && last.resultRaw == null && !usedProduct) {
        if (RE_SCORE.test(s) || (s.length <= 12 && /취소|적특|무효|특례/.test(s))) { last.resultRaw = s; continue; }
      }
    }
  }
  for (const g of games) {
    g.outcome = computeOutcome(g);
    if (g.resultRaw && /취소|적특|무효|특례/.test(g.resultRaw)) g.void = true;
  }
  // 이월(발매마감)되어 결과 없는 경기는 결과 파일에서 제외
  const hasAnyResult = games.some(g => g.resultRaw != null);
  const valid = games.filter(g => g.num != null && g.odds.some(o => o != null) && !(hasAnyResult && g.status === '발매마감' && g.resultRaw == null));
  meta.hasResults = valid.some(g => g.resultRaw != null);
  return { meta, games: valid };
}
