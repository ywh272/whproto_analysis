import * as DB from './db.js';
import { parseProtoPdf } from './parser.js';
import * as S from './stats.js';
import { betmanRoundToGames } from './betman.js';

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = S.pct;
const f2 = v => (v == null || isNaN(v) ? '–' : v.toFixed(2));
const f1 = v => (v == null || isNaN(v) ? '–' : v.toFixed(1));

const PW_HASH = '70d432a178b6dcc86a9c845f3b256a4b16ec320afd223caf88be63d8b2ba6ed9';
const BETMAN_ORIGIN = 'https://www.betman.co.kr';

const DEFAULT_F = () => ({ sports: [], leagues: [], kind: '', half: 'full', roundFrom: null, roundTo: null });
function loadFilters() {
  try { const f = JSON.parse(localStorage.getItem('protoFilters') || 'null'); if (f && Array.isArray(f.sports)) return { ...DEFAULT_F(), ...f }; } catch { }
  return DEFAULT_F();
}
function saveFilters() { try { localStorage.setItem('protoFilters', JSON.stringify(state.f)); } catch { } }

const state = {
  tab: 'upload', all: [], uploads: [], log: [],
  f: loadFilters(),
  team: { q: '', min: 1, sel: null, sort: ['n', -1] },
  pred: { round: null, hideClosed: true, kind: '', sort: 'num', open: new Set(), minConf: 0 },
  h2h: { sport: '', a: '', b: '' },
};

// ── 데이터 로드 ──────────────────────────────────────
async function reload() {
  state.all = await DB.getAll();
  state.uploads = await DB.getAll('uploads');
  if (!state.all.length && !state._seedTried) {
    state._seedTried = true;
    try {
      const r = await fetch('data/proto-data.json', { cache: 'no-store' });
      if (r.ok) { await DB.importJson(await r.json()); state.all = await DB.getAll(); state.uploads = await DB.getAll('uploads'); }
    } catch { /* 시드 파일 없음 */ }
  }
  const rounds = new Set(state.all.map(g => g.round));
  const res = state.all.filter(S.isResolved).length;
  $('#dbSummary').textContent = state.all.length
    ? `${rounds.size}개 회차 · 상품 ${state.all.length.toLocaleString()}개 · 결과 확정 ${res.toLocaleString()}개`
    : '아직 데이터가 없습니다 — 베트맨 버튼이나 PDF로 데이터를 넣어주세요';
  fillFilterOptions();
  render();
}

let _pdfjs = null;
async function pdfjs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import(PDFJS_URL);
  _pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return _pdfjs;
}

async function handleFiles(files) {
  const list = [...files].sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
  for (const file of list) {
    const at = Date.now();
    try {
      if (/\.json$/i.test(file.name)) {
        const n = await DB.importJson(JSON.parse(await file.text()));
        state.log.unshift({ ok: true, msg: `${file.name}: 백업에서 ${n}개 상품 복원` });
        continue;
      }
      if (!/\.pdf$/i.test(file.name)) throw new Error('PDF 또는 백업(JSON) 파일만 지원합니다');
      const lib = await pdfjs();
      const { meta, games } = await parseProtoPdf(lib, new Uint8Array(await file.arrayBuffer()), file.name);
      if (!games.length) throw new Error('경기 정보를 찾지 못했습니다');
      const r = await DB.mergeGames(games, at);
      const type = meta.hasResults ? '결과' : '예측';
      await DB.addUpload({ fileName: file.name, at, year: meta.year, round: meta.round, type, count: games.length, ...r });
      state.log.unshift({ ok: true, msg: `${file.name} → ${meta.round}회차 ${type} 파일 · 상품 ${games.length}개 (신규 ${r.added}, 갱신 ${r.updated}${r.oddsChanged ? `, 배당 변동 ${r.oddsChanged}` : ''}${r.resulted ? `, 결과 반영 ${r.resulted}` : ''})` });
      if (!meta.hasResults) state.pred.round = `${meta.year}-${meta.round}`;
    } catch (e) {
      console.error(e);
      state.log.unshift({ ok: false, msg: `${file.name}: ${e.message}` });
    }
    render();
  }
  await reload();
}

// ── 필터 (종목·리그 복수 선택, 선택은 이 브라우저에 기억) ──────────
function leagueCounts() {
  const pool = state.all;
  const m = new Map();
  for (const g of pool) {
    if (state.f.sports.length && !state.f.sports.includes(g.sport)) continue;
    const k = g.league; const v = m.get(k) || { league: k, sport: g.sport, n: 0, matches: new Set() };
    v.n++; v.matches.add(S.matchKey(g)); m.set(k, v);
  }
  return [...m.values()].map(v => ({ ...v, mn: v.matches.size })).sort((a, b) => a.sport.localeCompare(b.sport) || b.mn - a.mn);
}

function fillFilterOptions() {
  const pool = state.all;
  const sports = [...new Set(pool.map(g => g.sport))].sort();
  state.f.sports = state.f.sports.filter(s => sports.includes(s));
  $('#fSports').innerHTML = `<button type="button" class="chip${state.f.sports.length ? '' : ' on'}" data-sp="">전체</button>` +
    sports.map(s => `<button type="button" class="chip${state.f.sports.includes(s) ? ' on' : ''}" data-sp="${esc(s)}">${esc(s)}</button>`).join('');
  const valid = new Set(leagueCounts().map(l => l.league));
  state.f.leagues = state.f.leagues.filter(l => valid.has(l));
  const L = state.f.leagues;
  const btn = $('#fLeagueBtn');
  btn.textContent = L.length === 0 ? '전체 ▾' : L.length === 1 ? `${L[0]} ▾` : `${L[0]} 외 ${L.length - 1}개 ▾`;
  btn.title = L.join(', ');
  btn.classList.toggle('on', L.length > 0);
  const kinds = [...new Set(pool.map(g => g.kind))];
  $('#fKind').innerHTML = `<option value="">전체</option>` + Object.entries(S.KIND_LABEL).filter(([k]) => kinds.includes(k)).map(([v, t]) => `<option value="${v}"${v === state.f.kind ? ' selected' : ''}>${t}</option>`).join('');
  $('#fHalf').value = state.f.half;
  $('#fFrom').value = state.f.roundFrom ?? '';
  $('#fTo').value = state.f.roundTo ?? '';
  bindSportChips();
}

let _draft = null; // 리그 패널에서 고르는 중인 목록
function renderLeagueList() {
  const q = $('#fLeagueQ').value.trim();
  const list = leagueCounts().filter(l => !q || l.league.includes(q));
  let html = '', last = '';
  for (const l of list) {
    if (l.sport !== last) { html += `<div class="grp">${esc(l.sport)}</div>`; last = l.sport; }
    html += `<label><input type="checkbox" value="${esc(l.league)}"${_draft.has(l.league) ? ' checked' : ''}> ${esc(l.league)}<span class="n">${l.mn}경기</span></label>`;
  }
  $('#fLeagueList').innerHTML = html || '<p class="muted">해당 리그가 없습니다</p>';
  $('#fLeagueCnt').textContent = _draft.size ? `${_draft.size}개 선택` : '선택 없음 = 전체';
  $('#fLeagueList').querySelectorAll('input').forEach(cb => cb.onchange = () => { cb.checked ? _draft.add(cb.value) : _draft.delete(cb.value); $('#fLeagueCnt').textContent = _draft.size ? `${_draft.size}개 선택` : '선택 없음 = 전체'; });
}
function closeLeaguePanel(apply) {
  const panel = $('#fLeaguePanel');
  if (panel.hidden) return;
  if (apply) { state.f.leagues = [..._draft]; saveFilters(); fillFilterOptions(); render(); }
  panel.hidden = true; _draft = null;
}

function bindSportChips() {
  document.querySelectorAll('#fSports .chip').forEach(b => b.onclick = () => {
    const sp = b.dataset.sp;
    if (!sp) state.f.sports = [];
    else state.f.sports = state.f.sports.includes(sp) ? state.f.sports.filter(x => x !== sp) : [...state.f.sports, sp];
    saveFilters(); fillFilterOptions(); render();
  });
}

function bindFilters() {
  $('#fLeagueBtn').onclick = () => {
    const panel = $('#fLeaguePanel');
    if (!panel.hidden) { closeLeaguePanel(true); return; }
    _draft = new Set(state.f.leagues); $('#fLeagueQ').value = ''; panel.hidden = false; renderLeagueList(); $('#fLeagueQ').focus();
  };
  $('#fLeagueQ').oninput = renderLeagueList;
  $('#fLeagueAll').onclick = () => { $('#fLeagueList').querySelectorAll('input').forEach(cb => _draft.add(cb.value)); renderLeagueList(); };
  $('#fLeagueNone').onclick = () => { _draft.clear(); renderLeagueList(); };
  $('#fLeagueDone').onclick = () => closeLeaguePanel(true);
  document.addEventListener('pointerdown', e => { if (!$('#fLeagueBox').contains(e.target)) closeLeaguePanel(true); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLeaguePanel(false); });
  $('#fKind').onchange = e => { state.f.kind = e.target.value; saveFilters(); render(); };
  $('#fHalf').onchange = e => { state.f.half = e.target.value; saveFilters(); render(); };
  $('#fFrom').onchange = e => { state.f.roundFrom = +e.target.value || null; saveFilters(); render(); };
  $('#fTo').onchange = e => { state.f.roundTo = +e.target.value || null; saveFilters(); render(); };
  $('#fReset').onclick = () => { state.f = DEFAULT_F(); saveFilters(); fillFilterOptions(); render(); };
}

// ── 공용 UI 조각 ─────────────────────────────────────
const tip = $('#tip');
function bindTips(root) {
  root.querySelectorAll('[data-tip]').forEach(el => {
    el.addEventListener('pointermove', e => {
      tip.innerHTML = el.dataset.tip; tip.hidden = false;
      const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
      const y = e.clientY + 14 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 14;
      tip.style.left = x + 'px'; tip.style.top = y + 'px';
    });
    el.addEventListener('pointerleave', () => { tip.hidden = true; });
  });
}

function kpi(k, v, d = '') { return `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`; }

function table(cols, rows, { sort, onSort, rowAttr } = {}) {
  const [sk, sd] = sort || [];
  const sorted = sk ? rows.slice().sort((a, b) => {
    const x = a[sk], y = b[sk];
    if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y, 'ko') : x - y) * sd;
  }) : rows;
  const head = cols.map(c => `<th class="${c.num ? 'num' : ''}${c.key === sk ? ' sorted' : ''}" data-key="${c.key}" data-dir="${sd > 0 ? '▲' : '▼'}">${c.label}</th>`).join('');
  const body = sorted.map(r => `<tr ${rowAttr ? rowAttr(r) : ''}>${cols.map(c => `<td class="${c.num ? 'num' : ''}">${c.fmt ? c.fmt(r[c.key], r) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');
  const html = `<div class="tblwrap"><table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}" class="muted">해당 데이터가 없습니다</td></tr>`}</tbody></table></div>`;
  return { html, bind: el => { if (onSort) el.querySelectorAll('th').forEach(th => th.onclick = () => onSort(th.dataset.key)); } };
}

const rateBar = (v, color = 'var(--series-1)') => v == null ? '–' : `<div class="row" style="gap:8px;flex-wrap:nowrap"><div class="bar" style="width:80px"><i style="width:${Math.round(v * 100)}%;background:${color}"></i></div><span>${pct(v)}</span></div>`;

// 세로 막대 (그룹) 차트
function barChart({ cats, series, yMax = 1, yFmt = v => pct(v), height = 240, tipFn }) {
  const W = 640, H = height, m = { l: 40, r: 8, t: 10, b: 38 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const gw = iw / cats.length, bw = Math.min(26, (gw - 10) / series.length);
  const y = v => m.t + ih - (v / yMax) * ih;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let k = 0; k <= 4; k++) { const v = yMax * k / 4; s += `<line class="gridl" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${yFmt(v)}</text>`; }
  cats.forEach((c, i) => {
    const gx = m.l + i * gw + (gw - bw * series.length - 2 * (series.length - 1)) / 2;
    series.forEach((se, j) => {
      const v = se.values[i]; if (v == null) return;
      const x = gx + j * (bw + 2), top = y(Math.min(v, yMax)), h = Math.max(0, m.t + ih - top);
      const r = Math.min(4, h, bw / 2);
      s += `<path d="M${x},${m.t + ih} V${top + r} q0,-${r} ${r},-${r} H${x + bw - r} q${r},0 ${r},${r} V${m.t + ih} Z" fill="${se.color}"/>`;
    });
    const t = tipFn ? tipFn(i) : '';
    s += `<rect x="${m.l + i * gw}" y="${m.t}" width="${gw}" height="${ih}" fill="transparent" data-tip="${esc(t)}"/>`;
    const [l1, l2] = String(c).split('\n');
    s += `<text x="${m.l + i * gw + gw / 2}" y="${H - m.b + 15}" text-anchor="middle">${esc(l1)}</text>`;
    if (l2) s += `<text x="${m.l + i * gw + gw / 2}" y="${H - m.b + 29}" text-anchor="middle" style="fill:var(--text-muted)">${esc(l2)}</text>`;
  });
  s += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/></svg>`;
  return `<div class="chart">${s}</div>`;
}

function lineChart({ cats, values, height = 200, tipFn }) {
  const W = 640, H = height, m = { l: 40, r: 12, t: 12, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = i => m.l + (cats.length === 1 ? iw / 2 : (i / (cats.length - 1)) * iw);
  const y = v => m.t + ih - v * ih;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let k = 0; k <= 4; k++) { const v = k / 4; s += `<line class="gridl" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${pct(v)}</text>`; }
  const pts = values.map((v, i) => v == null ? null : [x(i), y(v)]);
  const path = pts.filter(Boolean).map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');
  s += `<path d="${path}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>`;
  const step = Math.ceil(cats.length / 10);
  pts.forEach((p, i) => {
    if (!p) return;
    s += `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/>`;
    s += `<rect x="${p[0] - iw / cats.length / 2}" y="${m.t}" width="${Math.max(8, iw / cats.length)}" height="${ih}" fill="transparent" data-tip="${esc(tipFn(i))}"/>`;
    if (i % step === 0) s += `<text x="${p[0]}" y="${H - 8}" text-anchor="middle">${esc(cats[i])}</text>`;
  });
  return `<div class="chart">${s}</svg></div>`;
}

const RES_PILL = { W: '<span class="pill w">승</span>', D: '<span class="pill d">무</span>', L: '<span class="pill l">패</span>' };

// ── 탭: 업로드 ───────────────────────────────────────
function viewUpload() {
  const byRound = new Map();
  for (const g of state.all) {
    const k = `${g.year}-${g.round}`;
    const r = byRound.get(k) || { year: g.year, round: g.round, n: 0, res: 0, matches: new Set(), dates: [] };
    r.n++; if (S.isResolved(g)) r.res++; r.matches.add(S.matchKey(g)); r.dates.push(g.date);
    byRound.set(k, r);
  }
  const ups = state.uploads;
  const rows = [...byRound.values()].map(r => {
    const u = ups.filter(x => x.year === r.year && x.round === r.round);
    const dates = r.dates.sort();
    return { ...r, matchN: r.matches.size, period: `${dates[0]?.slice(5)} ~ ${dates.at(-1)?.slice(5)}`,
      upN: u.length, last: u.length ? Math.max(...u.map(x => x.at)) : null,
      status: r.res === 0 ? '예측(진행중)' : r.res >= r.n * 0.95 ? '결과 확정' : '일부 결과' };
  });
  const t = table([
    { key: 'round', label: '회차', num: true, fmt: v => `${v}회` },
    { key: 'period', label: '경기 기간' },
    { key: 'status', label: '상태', fmt: v => `<span class="pill ${v === '결과 확정' ? 'w' : v === '일부 결과' ? 'd' : ''}">${v}</span>` },
    { key: 'matchN', label: '경기', num: true },
    { key: 'n', label: '상품', num: true },
    { key: 'res', label: '결과', num: true },
    { key: 'upN', label: '업로드', num: true, fmt: v => `${v}회` },
    { key: 'last', label: '마지막 업로드', fmt: v => v ? new Date(v).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–' },
    { key: 'round', label: '', fmt: (v, r) => `<button class="danger" data-del="${r.year}-${r.round}">삭제</button>` },
  ], rows, { sort: ['round', -1] });

  return {
    html: `
    <div class="card">
      <h2>⚡ 베트맨에서 바로 가져오기</h2>
      <p class="muted">아래 주황 버튼을 <b>즐겨찾기 바로 끌어다 놓으면</b> 설치됩니다. (즐겨찾기 바가 안 보이면 <b>Ctrl+Shift+B</b>)</p>
      <div class="row" style="margin:12px 0"><a class="bm" id="bmLink" href="#" onclick="return false">📊 프로토 보내기</a><span class="muted">← 이 버튼을 즐겨찾기 바로 드래그</span></div>
      <ol class="steps">
        <li>베트맨 → 게임구매 → <b>프로토 승부식</b> 회차 화면을 엽니다. 지난 회차는 결과 화면을 엽니다.</li>
        <li>즐겨찾기 바의 <b>📊 프로토 보내기</b>를 누릅니다.</li>
        <li>오른쪽 위 창에서 <b>이 회차 보내기</b>를 누르면 대시보드가 열리고 자동으로 저장됩니다. 지난 회차 범위를 넣으면 결과도 한꺼번에 가져옵니다(1.5초 간격).</li>
      </ol>
      <p class="muted" style="margin-top:8px">처음 한 번은 베트맨 팝업 허용이 필요할 수 있습니다. 같은 회차를 다시 보내면 배당 변동 이력이 쌓입니다.</p>
    </div>
    <div class="card">
      <h2>PDF 올리기</h2>
      <p class="muted">베트맨 회차 화면을 <b>인쇄하기 → PDF로 저장</b>한 파일을 그대로 올리면 됩니다. 결과 파일과 예측 파일은 내용을 보고 자동으로 구분하고, 여러 개를 한 번에 올려도 됩니다.<br>
      같은 회차의 예측 파일을 다시 올리면 회차·번호로 같은 상품을 찾아 <b>배당 변동 이력</b>을 쌓습니다. 나중에 같은 회차의 결과 파일을 올리면 결과가 합쳐집니다.</p>
      <label class="drop" id="drop" style="display:block;margin-top:12px">
        <strong>여기로 PDF를 끌어 놓거나 클릭해서 선택</strong>
        <span class="muted">결과 PDF · 예측 PDF · 백업 JSON 지원</span>
        <input type="file" id="file" accept=".pdf,.json" multiple hidden>
      </label>
      <ul class="log">${state.log.slice(0, 12).map(l => `<li class="${l.ok ? 'ok' : 'err'}">${esc(l.msg)}</li>`).join('')}</ul>
    </div>
    <div class="card">
      <div class="row"><h2>저장된 회차</h2><span class="spacer"></span>
        <button class="ghost" id="exportBtn">⬇️ 백업 내보내기 (JSON)</button>
        <button class="danger" id="clearBtn">전체 삭제</button></div>
      <p class="muted" style="margin-bottom:10px">데이터는 이 브라우저에만 저장됩니다. 다른 기기에서도 쓰려면 백업 JSON을 받아서 GitHub 저장소의 <code>data/proto-data.json</code>으로 올려두세요 — 데이터가 비어 있는 브라우저에서 열면 자동으로 불러옵니다.</p>
      ${t.html}
    </div>`,
    bind: root => {
      const base = location.origin + location.pathname.replace(/[^/]*$/, '');
      root.querySelector('#bmLink').href = `javascript:(function(){var s=document.createElement('script');s.src='${base}js/collector.js?v='+Date.now();s.charset='utf-8';document.body.appendChild(s);})();`;
      const drop = root.querySelector('#drop'), inp = root.querySelector('#file');
      inp.onchange = () => handleFiles(inp.files);
      ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
      drop.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
      root.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        const [y, r] = b.dataset.del.split('-').map(Number);
        if (confirm(`${r}회차 데이터를 삭제할까요?`)) { await DB.deleteRound(y, r); reload(); }
      });
      root.querySelector('#exportBtn').onclick = async () => {
        const blob = new Blob([JSON.stringify(await DB.exportJson())], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'proto-data.json'; a.click();
      };
      root.querySelector('#clearBtn').onclick = async () => { if (confirm('저장된 모든 데이터를 삭제할까요? (되돌릴 수 없음)')) { await DB.clearAll(); state._seedTried = true; reload(); } };
    },
  };
}

// ── 탭: 배당 흐름 ────────────────────────────────────
function viewFlow() {
  const resolved = S.applyFilters(state.all.filter(S.isResolved), state.f);
  if (!resolved.length) return { html: `<div class="card empty">조건에 맞는 결과 데이터가 없습니다. 결과 PDF를 올리거나 필터를 바꿔보세요.</div>` };
  const fl = S.oddsFlow(resolved);
  const T = fl.types;
  const cal = barChart({
    cats: fl.bins.map(b => `${b.label}\nn=${b.n}`),
    series: [{ name: '실제 적중률', color: 'var(--series-1)', values: fl.bins.map(b => b.rate) }, { name: '배당 내재확률', color: 'var(--series-2)', values: fl.bins.map(b => b.implAvg) }],
    tipFn: i => { const b = fl.bins[i]; return `<b>배당 ${b.label}</b><br>선택지 ${b.n}개 중 적중 ${b.hit}개<br>실제 적중률 <b>${pct(b.rate, 1)}</b><br>배당 내재확률 ${pct(b.implAvg, 1)}<br>전부 샀다면 회수율 ${b.roi == null ? '–' : pct(1 + b.roi, 0)}`; },
  });
  const win = barChart({
    cats: fl.winOddsBins.map(b => b.label),
    series: [{ name: '적중 배당', color: 'var(--series-1)', values: fl.winOddsBins.map(b => b.n / fl.n) }],
    yMax: Math.max(0.2, Math.ceil(Math.max(...fl.winOddsBins.map(b => b.n / fl.n)) * 5) / 5), height: 200,
    tipFn: i => `<b>적중 배당 ${fl.winOddsBins[i].label}</b><br>${fl.winOddsBins[i].n}건 (${pct(fl.winOddsBins[i].n / fl.n, 1)})`,
  });
  const typeColors = { '정배': 'var(--series-1)', '무/중간': 'var(--series-4)', '역배': 'var(--series-2)', '동배': 'var(--text-muted)' };
  const kindRows = fl.byKind.map(k => ({ ...k, name: (k.half ? '전반 ' : '') + S.KIND_LABEL[k.kind], fav: k.types['정배'] / k.n, dog: k.types['역배'] / k.n, mid: k.types['무/중간'] / k.n, avg: k.winOdds / k.n }));
  const kt = table([
    { key: 'name', label: '유형' }, { key: 'n', label: '결과', num: true },
    { key: 'fav', label: '적중 구성 (정배·무/중간·역배·동배)', fmt: (v, r) => `<div class="stack" data-tip="${esc(Object.entries(r.types).map(([t, c]) => `${t} ${c}건 (${pct(c / r.n)})`).join('<br>'))}">${Object.entries(r.types).map(([t, c]) => c ? `<i style="width:${c / r.n * 100}%;background:${typeColors[t]}"></i>` : '').join('')}</div>` },
    { key: 'fav', label: '정배', num: true, fmt: v => pct(v) }, { key: 'mid', label: '무/중간', num: true, fmt: v => pct(v) }, { key: 'dog', label: '역배', num: true, fmt: v => pct(v) },
    { key: 'avg', label: '평균 적중배당', num: true, fmt: f2 },
  ], kindRows, { sort: ['n', -1] });
  const rounds = fl.byRound;
  const trend = rounds.length >= 2 ? lineChart({ cats: rounds.map(r => `${r.round}회`), values: rounds.map(r => r.favN ? r.fav / r.favN : null), tipFn: i => `<b>${rounds[i].round}회차</b><br>정배 적중 ${rounds[i].fav}/${rounds[i].favN} (${pct(rounds[i].fav / rounds[i].favN, 1)})<br>결과 ${rounds[i].n}개` })
    : `<p class="muted">회차가 2개 이상 쌓이면 회차별 정배 적중률 추이가 표시됩니다.</p>`;
  return {
    html: `
    <div class="kpis">
      ${kpi('분석한 결과', fl.n.toLocaleString() + '건', `${new Set(resolved.map(g => g.round)).size}개 회차`)}
      ${kpi('정배 적중률', pct(fl.favRate, 1), `동배 제외 ${fl.favHit}/${fl.favN}`)}
      ${kpi('역배 적중', pct(T['역배'] / fl.n, 1), `${T['역배']}건`)}
      ${kpi('무/중간 적중', pct(T['무/중간'] / fl.n, 1), `${T['무/중간']}건`)}
      ${kpi('평균 적중배당', f2(fl.avgWinOdds), '맞은 선택지의 배당 평균')}
    </div>
    <div class="grid2">
      <div class="card"><h3>배당 구간별 실제 적중률 vs 배당 내재확률</h3>
        <div class="legend"><span style="--c:var(--series-1)">실제 적중률</span><span style="--c:var(--series-2)">배당 내재확률(마진 제거)</span></div>
        ${cal}
        <p class="muted">파란 막대가 주황보다 높으면 그 배당 구간이 실제로 더 자주 맞았다는 뜻입니다. 표본(n)이 작은 구간은 참고만 하세요.</p></div>
      <div class="card"><h3>적중된 배당 분포</h3>${win}
        <h3 style="margin-top:14px">회차별 정배 적중률</h3>${trend}</div>
    </div>
    <div class="card"><h3>상품 유형별 적중 구성</h3>
      <div class="legend">${Object.entries(typeColors).map(([t, c]) => `<span style="--c:${c}">${t}</span>`).join('')}</div>
      ${kt.html}</div>`,
    bind: root => bindTips(root),
  };
}

// ── 탭: 팀별 ─────────────────────────────────────────
function viewTeam() {
  const games = S.applyFilters(state.all, { ...state.f, kind: '', half: 'all' });
  const matches = S.buildMatches(games);
  let teams = S.teamStats(matches).filter(t => t.n >= state.team.min);
  if (state.team.q) teams = teams.filter(t => t.team.includes(state.team.q));
  const sel = state.team.sel && teams.find(t => t.key === state.team.sel);
  const tb = table([
    { key: 'team', label: '팀', fmt: (v, r) => `<b>${esc(v)}</b> <span class="muted">${esc(r.sport)}</span>` },
    { key: 'leagues', label: '리그', fmt: v => `<span class="muted">${esc(v)}</span>` },
    { key: 'n', label: '경기', num: true },
    { key: 'W', label: '승-무-패', num: true, fmt: (v, r) => `${r.W}-${r.D}-${r.L}` },
    { key: 'winRate', label: '승률', fmt: v => rateBar(v) },
    { key: 'gfAvg', label: '득점*', num: true, fmt: f1 }, { key: 'gaAvg', label: '실점*', num: true, fmt: f1 },
    { key: 'favRate', label: '정배일 때 승률', num: true, fmt: (v, r) => r.favN ? `${pct(v)} <span class="muted">(${r.favN})</span>` : '–' },
    { key: 'dogRate', label: '역배일 때 승률', num: true, fmt: (v, r) => r.dogN ? `${pct(v)} <span class="muted">(${r.dogN})</span>` : '–' },
    { key: 'hcRate', label: '핸디캡 성공', num: true, fmt: (v, r) => r.hcN ? `${pct(v)} <span class="muted">(${r.hcN})</span>` : '–' },
    { key: 'overRate', label: '오버', num: true, fmt: (v, r) => r.ouN ? `${pct(v)} <span class="muted">(${r.ouN})</span>` : '–' },
    { key: 'form', label: '최근 5경기', fmt: v => v.slice(0, 5).map(f => RES_PILL[f.r]).join(' ') },
  ], teams, { sort: state.team.sort, onSort: k => { state.team.sort = [k, state.team.sort[0] === k ? -state.team.sort[1] : -1]; render(); }, rowAttr: r => `class="click${r.key === state.team.sel ? ' sel' : ''}" data-team="${esc(r.key)}"` });
  const detail = sel ? `
    <div class="card"><div class="row"><h2>${esc(sel.team)}</h2><span class="pill">${esc(sel.sport)}</span><span class="muted">${esc(sel.leagues)}</span></div>
      <div class="kpis" style="margin:12px 0">
        ${kpi('전적', `${sel.W}-${sel.D}-${sel.L}`, `${sel.n}경기 · 승률 ${pct(sel.winRate)}`)}
        ${kpi('홈 / 원정 승률', `${pct(sel.homeN ? sel.homeW / sel.homeN : null)} / ${pct(sel.awayN ? sel.awayW / sel.awayN : null)}`, `홈 ${sel.homeN} · 원정 ${sel.awayN}`)}
        ${kpi('평균 득실', `${f1(sel.gfAvg)} : ${f1(sel.gaAvg)}`, `경기당 합계 ${f1(sel.totalAvg)}`)}
        ${kpi('오버 / 홀', `${pct(sel.overRate)} / ${pct(sel.oddRate)}`, `언오버 ${sel.ouN} · SUM ${sel.sumN}`)}
      </div>
      ${table([{ key: 'date', label: '날짜' }, { key: 'home', label: '', fmt: v => v ? '홈' : '원정' }, { key: 'opp', label: '상대' }, { key: 'score', label: '스코어(홈:원정)' }, { key: 'r', label: '결과', fmt: v => RES_PILL[v] }], sel.form).html}
    </div>` : '';
  return {
    html: `<div class="card">
      <div class="row" style="margin-bottom:10px"><h2>팀별 성적</h2><span class="spacer"></span>
        <input type="search" id="tq" placeholder="팀 이름 검색" value="${esc(state.team.q)}">
        <label class="muted">최소 경기 <input type="number" id="tmin" min="1" value="${state.team.min}"></label></div>
      <p class="muted" style="margin-bottom:8px">행을 누르면 아래에 팀 상세가 열립니다. 상단 필터의 종목·리그·회차가 적용됩니다. *배구는 세트 기준입니다.</p>
      ${tb.html}</div>${detail}`,
    bind: root => {
      tb.bind(root);
      const q = root.querySelector('#tq'); q.oninput = () => { state.team.q = q.value; render(); setTimeout(() => { const n = $('#tq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); };
      root.querySelector('#tmin').onchange = e => { state.team.min = Math.max(1, +e.target.value || 1); render(); };
      root.querySelectorAll('[data-team]').forEach(tr => tr.onclick = () => { state.team.sel = state.team.sel === tr.dataset.team ? null : tr.dataset.team; render(); });
    },
  };
}

// ── 탭: 종목·리그별 ──────────────────────────────────
function viewLeague() {
  const games = S.applyFilters(state.all, { ...state.f, kind: '', half: 'all' });
  const matches = S.buildMatches(games);
  const sp = S.groupStats(matches, games, x => x.sport);
  const lg = S.groupStats(matches, games, x => `${x.sport}|${x.league}`).map(r => ({ ...r, sport: r.key.split('|')[0], league: r.key.split('|')[1] }));
  const cols = first => [
    ...first,
    { key: 'n', label: '경기', num: true },
    { key: 'homeRate', label: '홈승 · 무 · 원정승', fmt: (v, r) => `<div class="stack" data-tip="${esc(`홈승 ${r.H} (${pct(r.homeRate)})<br>무 ${r.D} (${pct(r.drawRate)})<br>원정승 ${r.A} (${pct(r.awayRate)})`)}"><i style="width:${r.homeRate * 100}%;background:var(--series-1)"></i>${r.D ? `<i style="width:${r.drawRate * 100}%;background:var(--series-4)"></i>` : ''}<i style="width:${r.awayRate * 100}%;background:var(--series-2)"></i></div>` },
    { key: 'homeRate', label: '홈승', num: true, fmt: v => pct(v) }, { key: 'drawRate', label: '무', num: true, fmt: v => pct(v) }, { key: 'awayRate', label: '원정승', num: true, fmt: v => pct(v) },
    { key: 'favRate', label: '정배 적중', num: true, fmt: (v, r) => r.favN ? `${pct(v)} <span class="muted">(${r.favN})</span>` : '–' },
    { key: 'hcHomeRate', label: '핸디캡 홈승', num: true, fmt: (v, r) => r.hcN ? `${pct(v)} <span class="muted">(${r.hcN})</span>` : '–' },
    { key: 'overRate', label: '오버', num: true, fmt: (v, r) => r.ouN ? `${pct(v)} <span class="muted">(${r.ouN})</span>` : '–' },
    { key: 'oddRate', label: '홀', num: true, fmt: (v, r) => r.sumN ? `${pct(v)} <span class="muted">(${r.sumN})</span>` : '–' },
    { key: 'totalAvg', label: '평균 합계', num: true, fmt: f1 },
  ];
  state.lgSort ??= ['n', -1];
  const t1 = table(cols([{ key: 'key', label: '종목' }]), sp, { sort: ['n', -1] });
  const t2 = table(cols([{ key: 'sport', label: '종목' }, { key: 'league', label: '리그' }]), lg, { sort: state.lgSort, onSort: k => { state.lgSort = [k, state.lgSort[0] === k ? -state.lgSort[1] : -1]; render(); } });
  return {
    html: `<div class="card"><h2>종목별</h2>
      <div class="legend"><span style="--c:var(--series-1)">홈승</span><span style="--c:var(--series-4)">무</span><span style="--c:var(--series-2)">원정승</span></div>${t1.html}</div>
      <div class="card"><h2>리그별</h2><p class="muted" style="margin-bottom:8px">괄호 안은 표본 수입니다. 축구는 정규시간(90분) 기준, 농구·야구·배구는 연장 포함 기준입니다.</p>${t2.html}</div>`,
    bind: root => { t2.bind(root); bindTips(root); },
  };
}

// ── 탭: 상대전적 ─────────────────────────────────────
function viewH2H() {
  const matches = S.buildMatches(state.all).filter(m => m.finished);
  const sports = [...new Set(matches.map(m => m.sport))].sort();
  if (!state.h2h.sport) state.h2h.sport = sports[0] || '';
  const teams = [...new Set(matches.filter(m => m.sport === state.h2h.sport).flatMap(m => [m.home, m.away]))].sort((a, b) => a.localeCompare(b, 'ko'));
  const { a, b } = state.h2h;
  let body = '<p class="muted">두 팀을 고르면 지금까지 쌓인 맞대결 기록을 보여줍니다. 한 팀만 고르면 그 팀의 모든 경기를 보여줍니다.</p>';
  if (a || b) {
    const list = a && b ? S.headToHead(matches, a, b) : matches.filter(m => m.sport === state.h2h.sport && [m.home, m.away].includes(a || b));
    const me = a || b;
    let w = 0, d = 0, l = 0;
    list.forEach(m => { const r = m.res === 'D' ? 'D' : ((m.res === 'H') === (m.home === me) ? 'W' : 'L'); if (r === 'W') w++; else if (r === 'D') d++; else l++; });
    const rows = list.map(m => {
      const mk = m.markets.filter(g => S.isResolved(g) && !g.half);
      return { ...m, mk: mk.map(g => `${S.KIND_LABEL[g.kind]}${g.line != null ? ` ${g.kind === 'handicap' ? (g.line > 0 ? '+' : '') : ''}${g.line}` : ''}: <b>${esc(g.labels[g.outcome])}</b> (${f2(g.odds[g.outcome])})`).join(' · ') };
    });
    body = `<div class="kpis" style="margin:12px 0">${kpi(`${esc(me)} 기준`, `${w}승 ${d}무 ${l}패`, `${list.length}경기`)}${kpi('평균 합계', f1(list.length ? list.reduce((s, m) => s + (m.total ?? 0), 0) / list.length : null), '득점 합')}</div>` +
      table([{ key: 'date', label: '날짜' }, { key: 'league', label: '리그' }, { key: 'home', label: '홈' }, { key: 'hs', label: '스코어', fmt: (v, r) => `<b>${r.hs}:${r.as}</b>` }, { key: 'away', label: '원정' },
        { key: 'mainOdds', label: '승(무)패 배당', fmt: v => v ? v.map(f2).join(' / ') : '–' }, { key: 'mk', label: '상품별 적중', fmt: v => `<span style="white-space:normal">${v}</span>` }], rows).html;
  }
  const opt = (v) => `<option value="">선택</option>` + teams.map(t => `<option${t === v ? ' selected' : ''}>${esc(t)}</option>`).join('');
  return {
    html: `<div class="card"><h2>상대전적</h2>
      <div class="row" style="margin:10px 0">
        <select id="hs">${sports.map(s => `<option${s === state.h2h.sport ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select>
        <select id="ha">${opt(a)}</select><b>VS</b><select id="hb">${opt(b)}</select></div>${body}</div>`,
    bind: root => {
      root.querySelector('#hs').onchange = e => { state.h2h = { sport: e.target.value, a: '', b: '' }; render(); };
      root.querySelector('#ha').onchange = e => { state.h2h.a = e.target.value; render(); };
      root.querySelector('#hb').onchange = e => { state.h2h.b = e.target.value; render(); };
    },
  };
}

// ── 탭: 예측 분석 ────────────────────────────────────
function oddsMove(g, i) {
  const h = g.oddsHistory || [];
  if (h.length < 2) return '';
  const first = h[0].odds[i], cur = h[h.length - 1].odds[i];
  if (first == null || cur == null || first === cur) return '';
  return `<span class="${cur > first ? 'up' : 'down'}" data-tip="${esc(`배당 변동: ${h.map(x => f2(x.odds[i])).join(' → ')}`)}">${cur > first ? '▲' : '▼'}</span>`;
}

// 근거 칩: 각 근거가 배당 대비 이 선택을 지지(▲)하는지, 반대(▼)하는지
function reasonChips(best) {
  const chips = [];
  for (const p of best.parts) {
    if (p.name === '배당') continue;
    const d = (p.raw ?? p.p) - best.implied;
    const cls = d > 0.03 ? 'pos' : d < -0.03 ? 'neg' : 'neu';
    const icon = { '과거구간': '📈 과거', '팀성적': '👥 팀', '상대전적': '⚔️ 상대' }[p.name];
    const val = p.name === '상대전적' ? `${Math.round(p.raw * p.n)}/${p.n}` : `${pct(p.raw)}`;
    chips.push(`<span class="rc ${cls}" data-tip="${esc(p.note)}">${icon} ${val}${p.name !== '상대전적' ? `<small>(${p.n})</small>` : ''}</span>`);
  }
  return chips.length ? chips.join('') : '<span class="rc none" data-tip="같은 조건의 과거 결과·팀 기록이 아직 없어 배당 확률만 사용">배당만</span>';
}

function isTie(s) {
  const ps = s.opts.filter(Boolean).map(o => o.p).sort((a, b) => b - a);
  return ps.length > 1 && ps[0] - ps[1] < 0.01;
}
function optCells(s) {
  const tie = isTie(s);
  return s.opts.map(o => {
    if (!o) return '';
    const isBest = !tie && o === s.best;
    const pp = Math.round(o.p * 100);
    return `<div class="opt${isBest ? ' best' : ''}" data-tip="${esc(`<b>${o.label}</b> 배당 ${f2(o.odds)}<br>예상 확률 <b>${pct(o.p, 1)}</b><br>배당 내재확률 ${pct(o.implied, 1)}<br>기대회수 ${f2(o.ev)}`)}">
      <div class="ot"><span class="ol">${esc(o.label)}</span><span class="oo">${f2(o.odds)}${oddsMove(s.g, o.i)}</span></div>
      <div class="op">${pp}<small>%</small></div>
      <div class="obar"><i style="width:${pp}%"></i></div></div>`;
  }).join('');
}

function marketName(g) {
  const ln = g.line == null ? '' : g.kind === 'handicap' ? ` H${g.line > 0 ? '+' : ''}${g.line}` : g.kind === 'ou' ? ` ${g.line}` : '';
  return `${esc(g.market)}<span class="muted">${ln}</span>`;
}

function viewPredict() {
  const pending = state.all.filter(g => g.resultRaw == null);
  const rounds = [...new Set(pending.map(g => `${g.year}-${g.round}`))].sort().reverse();
  if (!rounds.length) return { html: `<div class="card empty">예측할 경기가 없습니다.<br>베트맨에서 <b>📊 프로토 보내기</b>로 현재 회차를 보내거나, 예측 PDF를 올려주세요.</div>` };
  if (!state.pred.round || !rounds.includes(state.pred.round)) state.pred.round = rounds[0];
  const resolved = state.all.filter(S.isResolved);
  const model = S.buildModel(resolved, S.buildMatches(state.all));
  const now = new Date();
  const startAt = g => new Date(`${g.date}T${g.time || '00:00'}:00+09:00`);
  let list = pending.filter(g => `${g.year}-${g.round}` === state.pred.round);
  const totalN = list.length;
  if (state.pred.hideClosed) list = list.filter(g => startAt(g) > now);
  list = S.applyFilters(list, { ...state.f, roundFrom: null, roundTo: null });
  let scored = list.map(g => S.scoreGame(model, g)).filter(s => s.confidence >= state.pred.minConf);
  const sk = state.pred.sort;
  const byNum = (a, b) => a.g.num - b.g.num;
  scored.sort(sk === 'p' ? (a, b) => b.best.p - a.best.p : sk === 'edge' ? (a, b) => b.best.edge - a.best.edge
    : sk === 'time' ? (a, b) => (a.g.date + a.g.time).localeCompare(b.g.date + b.g.time) || byNum(a, b) : byNum);
  const grouped = sk === 'num' || sk === 'time';

  // 상단 요약: 확률 높은 상품 / 배당 대비 우위 상품
  const top = arr => arr.slice(0, 5).map(s => `<li><span class="muted">${s.g.num}</span> <b>${esc(s.g.home)}</b> vs ${esc(s.g.away)} · ${esc(s.g.market)} → <b class="pick">${esc(s.best.label)}</b> ${pct(s.best.p)} <span class="muted">(${f2(s.best.odds)})</span></li>`).join('');
  const topP = scored.slice().sort((a, b) => b.best.p - a.best.p);
  const topE = scored.filter(s => s.best.edge > 0.01 && s.best.odds >= 1.3).sort((a, b) => b.best.edge - a.best.edge);

  let rows = '', lastMatch = '';
  for (const s of scored.slice(0, 600)) {
    const g = s.g, mk = S.matchKey(g), open = state.pred.open.has(g.key);
    if (grouped && mk !== lastMatch) {
      lastMatch = mk;
      const started = startAt(g) <= now;
      rows += `<tr class="mh"><td colspan="4"><span class="mt">${g.date.slice(5).replace('-', '.')} ${esc(g.time || '')}</span>
        <span class="pill">${esc(g.sport)}</span> <span class="muted">${esc(g.league)}</span>
        <b class="teams">${esc(g.home)} <span class="muted">vs</span> ${esc(g.away)}</b>${started ? ' <span class="pill l">시작됨</span>' : ''}</td></tr>`;
    }
    const det = open ? `<tr class="dt"><td colspan="4"><div class="detail">${s.opts.filter(Boolean).map(o => `<div><b>${esc(o.label)}</b> ${f2(o.odds)} → ${pct(o.p, 1)} <span class="muted">(배당 ${pct(o.implied, 1)}${o.parts.filter(p => p.name !== '배당').map(p => ` · ${esc(p.note)}`).join('')})</span></div>`).join('')}
      ${(g.oddsHistory || []).length > 1 ? `<div style="margin-top:4px">배당 변동: ${g.oddsHistory.map(h => `${new Date(h.t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} [${h.odds.map(f2).join(' / ')}]`).join(' → ')}</div>` : ''}</div></td></tr>` : '';
    rows += `<tr class="mk click" data-k="${esc(g.key)}">
      <td class="num muted">${g.num}</td>
      <td>${marketName(g)}${grouped ? '' : `<div class="muted sm">${esc(g.home)} vs ${esc(g.away)}</div>`}</td>
      <td><div class="opts">${optCells(s)}</div></td>
      <td><div class="rcs">${isTie(s) ? '<span class="rc none">확률 비슷 · 추천 없음</span>' : reasonChips(s.best)}</div></td></tr>${det}`;
  }
  const sortOpt = (k, t) => `<option value="${k}"${sk === k ? ' selected' : ''}>${t}</option>`;
  return {
    html: `<div class="card">
      <div class="row"><h2>예측 분석</h2>
        <select id="pr">${rounds.map(r => `<option value="${r}"${r === state.pred.round ? ' selected' : ''}>${r.split('-')[1]}회차</option>`).join('')}</select>
        <span class="muted">${scored.length} / ${totalN}개 상품</span><span class="spacer"></span>
        <label class="muted">정렬 <select id="ps">${sortOpt('num', '번호 순')}${sortOpt('time', '경기 시간 순')}${sortOpt('p', '확률 높은 순')}${sortOpt('edge', '배당 대비 우위 순')}</select></label>
        <label class="muted">근거 <select id="pc"><option value="0">전체</option><option value="0.4"${state.pred.minConf === 0.4 ? ' selected' : ''}>과거 기록 있는 것만</option><option value="0.8"${state.pred.minConf === 0.8 ? ' selected' : ''}>팀 기록까지 있는 것만</option></select></label>
        <label class="muted"><input type="checkbox" id="ph"${state.pred.hideClosed ? ' checked' : ''}> 시작한 경기 숨기기</label>
      </div>
      <div class="grid2" style="margin:12px 0">
        <div class="mini"><h3>🎯 확률 높은 상품 TOP 5</h3><ol>${top(topP) || '<li class="muted">없음</li>'}</ol></div>
        <div class="mini"><h3>💎 배당 대비 우위 TOP 5 <span class="muted sm">(배당 1.30 이상)</span></h3><ol>${top(topE) || '<li class="muted">아직 우위가 뚜렷한 상품이 없습니다</li>'}</ol></div>
      </div>
      <div class="legend2">
        <span><b class="pick">파란 칸</b> = 확률이 가장 높은 선택</span>
        <span class="rc pos">초록</span> 과거·팀 기록이 이 선택에 유리
        <span class="rc neg">빨강</span> 불리
        <span class="rc neu">회색</span> 배당과 비슷 · 괄호는 표본 수 · 행을 누르면 상세
      </div>
      <div class="tblwrap"><table class="pred"><thead><tr><th class="num">번호</th><th>유형</th><th>선택지 · 배당 · 예상 확률</th><th>근거 (가장 높은 선택 기준)</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="muted">표시할 상품이 없습니다 (필터를 확인하세요)</td></tr>'}</tbody></table></div>
      <p class="muted sm" style="margin-top:8px">예상 확률 = 배당 확률을 기본으로 과거 같은 배당구간 적중률·팀 기록·상대전적을 반영해 보정한 값입니다. 결과를 보장하지 않습니다.</p></div>`,
    bind: root => {
      root.querySelector('#pr').onchange = e => { state.pred.round = e.target.value; render(); };
      root.querySelector('#pc').onchange = e => { state.pred.minConf = +e.target.value; render(); };
      root.querySelector('#ps').onchange = e => { state.pred.sort = e.target.value; render(); };
      root.querySelector('#ph').onchange = e => { state.pred.hideClosed = e.target.checked; render(); };
      root.querySelectorAll('tr[data-k]').forEach(tr => tr.onclick = () => { const k = tr.dataset.k; state.pred.open.has(k) ? state.pred.open.delete(k) : state.pred.open.add(k); render(); });
      bindTips(root);
    },
  };
}

const VIEWS = { upload: viewUpload, flow: viewFlow, team: viewTeam, league: viewLeague, h2h: viewH2H, predict: viewPredict };

function render() {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  $('#filters').hidden = !['flow', 'team', 'league', 'predict'].includes(state.tab);
  const v = VIEWS[state.tab]();
  const root = $('#view');
  const y = scrollY;
  root.innerHTML = v.html;
  v.bind?.(root);
  scrollTo(0, y);
}

document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; tip.hidden = true; render(); });
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { }
};
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch { }
// ── 베트맨 수집기에서 넘어온 데이터 받기 ─────────────────
async function importBetman(payload) {
  const at = Date.now();
  let total = 0, res = 0, chg = 0; const names = [];
  for (const r of payload.rounds || []) {
    const games = betmanRoundToGames(r);
    if (!games.length) continue;
    const m = await DB.mergeGames(games, at);
    const hasRes = games.some(g => g.resultRaw != null);
    await DB.addUpload({ fileName: `베트맨 ${r.round}회차`, at, year: r.year, round: r.round, type: hasRes ? '결과' : '예측', count: games.length, source: 'betman', ...m });
    total += games.length; res += m.resulted; chg += m.oddsChanged; names.push(r.round);
    state.log.unshift({ ok: true, msg: `베트맨 ${r.round}회차 → 상품 ${games.length}개 (신규 ${m.added}, 갱신 ${m.updated}${m.oddsChanged ? `, 배당 변동 ${m.oddsChanged}` : ''}${m.resulted ? `, 결과 반영 ${m.resulted}` : ''})` });
    if (!hasRes || r.saleStatus !== 'SaleComplete') state.pred.round = `${r.year}-${r.round}`;
  }
  await reload();
  return `${names.length}개 회차 · 상품 ${total}개 저장${res ? ` · 결과 ${res}개 반영` : ''}${chg ? ` · 배당 변동 ${chg}개` : ''}`;
}

function listenBetman() {
  window.addEventListener('message', async e => {
    if (e.origin !== BETMAN_ORIGIN || !e.data || e.data.type !== 'proto-import') return;
    if (state._importing) return;
    state._importing = true;
    try {
      const summary = await importBetman(e.data);
      e.source?.postMessage({ type: 'proto-done', summary }, BETMAN_ORIGIN);
      state.tab = 'upload'; render();
      history.replaceState(null, '', location.pathname);
    } catch (err) {
      console.error(err);
      state.log.unshift({ ok: false, msg: `베트맨 데이터 저장 실패: ${err.message}` }); render();
    } finally { state._importing = false; }
  });
  const ready = () => { if (location.hash === '#import' && window.opener) window.opener.postMessage('proto-ready', BETMAN_ORIGIN); };
  window.addEventListener('hashchange', ready);
  ready();
}

// ── 비밀번호 잠금 (매 접속마다 입력, 저장하지 않음) ──────────
async function sha256(t) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function startApp() {
  $('#lock').remove();
  $('#app').hidden = false;
  bindFilters();
  reload().then(listenBetman);
}
$('#lockForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = $('#pw').value;
  if (await sha256('proto-dashboard:' + pw) === PW_HASH) { $('#pw').value = ''; startApp(); return; }
  $('#pwErr').hidden = false; $('#pw').value = '';
  const box = $('#lockForm'); box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
});
$('#pw').focus();
