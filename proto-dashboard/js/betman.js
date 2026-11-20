// 베트맨 화면 데이터(compSchedules) → 대시보드 상품 형식 변환
import { computeOutcome } from './parser.js';

const KST = 9 * 3600 * 1000;
const ymd = ms => new Date(ms + KST).toISOString().slice(0, 10);
const hm = ms => new Date(ms + KST).toISOString().slice(11, 16);

function kindOf(betTypNm, market) {
  const t = betTypNm || '';
  if (/언더오버/.test(t) || /언더오버/.test(market)) return 'ou';
  if (/홀짝/.test(t) || /SUM/.test(market)) return 'sum';
  if (/핸디캡/.test(t) || /핸디캡/.test(market)) return 'handicap';
  if (/승N패/.test(t) || /^(전반 )?승\d+패$/.test(market)) return 'margin';
  if (/승무패/.test(t)) return 'wdl';
  if (/승패/.test(t)) return 'wl';
  return 'other';
}

export function betmanRoundToGames(r) {
  const K = {}; (r.keys || []).forEach((k, i) => { K[k] = i; });
  const v = (row, k) => row[K[k]];
  const votes = new Map((r.votes || []).map(x => [x[0], x.slice(1)]));
  const complete = r.saleStatus === 'SaleComplete';
  const out = [];
  for (const row of r.datas || []) {
    const st = String(v(row, 'protoStatus') ?? '');
    const res = v(row, 'gameResult');
    if (st === '1') continue; // 배당 미공지
    if (complete && st === '3' && res == null) continue; // 다음 회차로 이월된 경기
    const sport = v(row, 'itemName');
    const betNm = v(row, 'betNm') || '';
    const market = betNm.startsWith(sport + ' ') ? betNm.slice(sport.length + 1) : betNm;
    const half = market.startsWith('전반 ');
    const kind = kindOf(v(row, 'betTypNm'), market);
    const txt = [v(row, 'winTxt'), v(row, 'drawTxt'), v(row, 'loseTxt')];
    const al = [v(row, 'winAllot'), v(row, 'drawAllot'), v(row, 'loseAllot')];
    const idx = [0, 1, 2].filter(i => txt[i] && txt[i] !== '-' && al[i]);
    if (idx.length < 2) continue;
    const labels = idx.map(i => txt[i]);
    const odds = idx.map(i => +al[i]);
    let line = null;
    if (kind === 'handicap' || kind === 'ou') line = +v(row, 'winHandi');
    if (kind === 'margin') line = +txt[1] || null;
    const score = v(row, 'mchScore');
    const g = {
      round: r.round, year: r.year, num: v(row, 'matchSeq'),
      date: ymd(v(row, 'gameDate')), time: hm(v(row, 'gameDate')),
      sport, league: v(row, 'leagueName'), home: v(row, 'homeName'), away: v(row, 'awayName'),
      market, kind, half, line, labels, odds,
      status: st === '4' ? '결과보기' : st === '3' ? '마감' : '발매중',
      resultRaw: null, outcome: null, source: 'betman',
    };
    const vt = votes.get(g.num);
    if (vt) g.votes = idx.map(i => vt[i] ?? null);
    if (res != null) {
      const ri = res === '0' ? 0 : res === '1' ? 1 : res === '2' ? 2 : -1;
      if (ri < 0 || !idx.includes(ri)) { g.void = true; g.resultRaw = score || '적특'; }
      else {
        g.outcome = idx.indexOf(ri);
        if ((kind === 'ou' || kind === 'sum') && score && score.includes(':')) {
          const t = score.split(':').reduce((a, b) => a + +b, 0);
          g.resultRaw = String(+t.toFixed(1));
        } else g.resultRaw = score || labels[g.outcome];
        // 결과값으로 다시 계산해 일치 여부 확인 (불일치 시 베트맨 판정 우선)
        const chk = computeOutcome(g);
        if (chk != null && chk >= 0 && chk !== g.outcome) g.checkMismatch = true;
      }
    }
    out.push(g);
  }
  return out;
}
