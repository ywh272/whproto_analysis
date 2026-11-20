// 베트맨(www.betman.co.kr) 프로토 승부식 화면에서 실행되는 수집기.
// 즐겨찾기 버튼(북마클릿)이 이 파일을 불러옵니다. 베트맨 화면에 이미 받아져 있는 회차 데이터를 읽고,
// 사용자가 원하면 지난 회차를 베트맨 화면과 같은 방식으로 하나씩(간격을 두고) 조회해서 대시보드로 보냅니다.
(function () {
  'use strict';
  var SCRIPT = document.currentScript && document.currentScript.src;
  var DASH = SCRIPT ? SCRIPT.replace(/js\/collector\.js.*$/, '') : null;
  var DASH_ORIGIN = DASH ? new URL(DASH).origin : null;
  var GAP_MS = 1500; // 지난 회차 조회 간격 (서버 부담 최소화)

  if (!/betman\.co\.kr$/.test(location.hostname)) { alert('베트맨(www.betman.co.kr) 화면에서 눌러주세요.'); return; }
  var mem = window.memoryScheduleInfo;
  if (!mem || !mem.currentLottery || mem.currentLottery.gmId !== 'G101') {
    alert('프로토 승부식 회차 화면에서 눌러주세요.\n\n게임구매 → 프로토 승부식 (진행 중 회차)\n또는 지난 회차의 결과 화면을 연 뒤 다시 눌러주세요.');
    return;
  }
  var old = document.getElementById('__protoCollector'); if (old) old.remove();

  function pack(info) {
    var lot = info.currentLottery || {};
    var cs = info.compSchedules || {};
    return {
      year: lot.gmOsidTsYear, round: lot.gmOsidTs, gmTs: lot.gmTs, saleStatus: lot.saleStatus,
      keys: cs.keys || [], datas: cs.datas || [],
      votes: (info.voteStatus || []).map(function (v) { return [v.GM_SEQ, v.W_BET_CNT, v.D_BET_CNT, v.L_BET_CNT]; }),
    };
  }
  var cur = pack(mem);
  var resN = cur.datas.filter(function (d) { return d[cur.keys.indexOf('gameResult')] != null; }).length;

  // ── 패널 UI ──
  var box = document.createElement('div');
  box.id = '__protoCollector';
  box.style.cssText = 'position:fixed;right:16px;top:16px;z-index:2147483647;width:300px;background:#fff;color:#111;border:1px solid #ddd;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.2);font:13px/1.5 "Malgun Gothic",sans-serif;padding:14px';
  box.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><b style="font-size:14px">📊 프로토 대시보드로 보내기</b>' +
    '<button data-x style="border:0;background:none;font-size:16px;cursor:pointer">✕</button></div>' +
    '<div style="color:#555;margin-bottom:10px">' + cur.round + '회차 · 상품 ' + cur.datas.length + '개 · 결과 ' + resN + '개</div>' +
    '<button data-one style="width:100%;padding:8px;border:0;border-radius:8px;background:#2a78d6;color:#fff;font-weight:700;cursor:pointer">이 회차 보내기</button>' +
    '<div style="margin:12px 0 4px;color:#555">지난 회차 결과도 함께 가져오기 (' + String(cur.year).slice(2) + '년)</div>' +
    '<div style="display:flex;gap:6px;align-items:center"><input data-from type="number" min="1" style="width:70px;padding:4px;border:1px solid #ccc;border-radius:6px"> ~ ' +
    '<input data-to type="number" min="1" style="width:70px;padding:4px;border:1px solid #ccc;border-radius:6px"> 회차</div>' +
    '<button data-many style="width:100%;margin-top:8px;padding:7px;border:1px solid #2a78d6;border-radius:8px;background:#fff;color:#2a78d6;font-weight:700;cursor:pointer">지난 회차 포함해서 보내기</button>' +
    '<div data-msg style="margin-top:10px;color:#555;white-space:pre-line"></div>';
  document.body.appendChild(box);
  var $ = function (s) { return box.querySelector(s); };
  $('[data-from]').value = Math.max(1, cur.round - 10);
  $('[data-to]').value = cur.round - 1;
  var msg = function (t) { $('[data-msg]').textContent = t; };
  $('[data-x]').onclick = function () { box.remove(); };

  function fetchRound(gmTs) {
    return new Promise(function (res, rej) {
      var done = false;
      setTimeout(function () { if (!done) rej(new Error('응답 없음')); }, 15000);
      window.requestClient.requestPostMethod('/buyPsblGame/gameInfoInq.do', { gmId: 'G101', gmTs: gmTs, gameYear: '' }, true, function (d) { done = true; res(d); });
    });
  }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function send(rounds) {
    if (!DASH) { alert('대시보드 주소를 찾지 못했습니다. 대시보드에서 버튼을 다시 설치해 주세요.'); return; }
    var payload = { type: 'proto-import', source: 'betman', at: Date.now(), rounds: rounds };
    msg('대시보드를 여는 중… (비밀번호를 입력하면 자동으로 들어갑니다)');
    function onMsg(e) {
      if (e.origin !== DASH_ORIGIN) return;
      if (e.data === 'proto-ready') e.source.postMessage(payload, DASH_ORIGIN);
      if (e.data && e.data.type === 'proto-done') {
        msg('✅ 완료: ' + e.data.summary);
        window.removeEventListener('message', onMsg);
      }
    }
    window.addEventListener('message', onMsg);
    var w = window.open(DASH + '#import', 'protodash');
    if (!w) msg('팝업이 차단되었습니다. 주소창 오른쪽의 팝업 차단 아이콘에서 www.betman.co.kr 팝업을 허용한 뒤 다시 눌러주세요.');
  }

  $('[data-one]').onclick = function () { send([cur]); };
  $('[data-many]').onclick = async function () {
    var from = +$('[data-from]').value, to = +$('[data-to]').value;
    if (!from || !to || from > to) { msg('회차 범위를 확인해 주세요.'); return; }
    if (to - from > 60) { msg('한 번에 60회차까지만 가져올 수 있습니다. 나눠서 받아주세요.'); return; }
    if (!window.requestClient || !window.requestClient.requestPostMethod) { msg('이 화면에서는 지난 회차를 불러올 수 없습니다. 승부식 구매 화면에서 다시 시도해 주세요.'); return; }
    var btns = box.querySelectorAll('button'); btns.forEach(function (b) { b.disabled = true; });
    var rounds = [cur], fail = [];
    var yy = Math.floor(cur.gmTs / 10000);
    for (var r = from; r <= to; r++) {
      if (r === cur.round) continue;
      msg((r - from + 1) + '/' + (to - from + 1) + ' · ' + r + '회차 불러오는 중…');
      try { rounds.push(pack(await fetchRound(yy * 10000 + r))); } catch (e) { fail.push(r); }
      await sleep(GAP_MS);
    }
    btns.forEach(function (b) { b.disabled = false; });
    if (fail.length) alert('불러오지 못한 회차: ' + fail.join(', '));
    send(rounds);
  };
})();
