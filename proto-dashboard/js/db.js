// IndexedDB 저장소 (브라우저 안에만 저장, 서버 전송 없음)
const DB_NAME = 'proto-dashboard';
const DB_VER = 1;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, DB_VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('games')) db.createObjectStore('games', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('uploads')) db.createObjectStore('uploads', { keyPath: 'id', autoIncrement: true });
    };
    rq.onsuccess = () => { _db = rq.result; res(_db); };
    rq.onerror = () => rej(rq.error);
  });
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then(v => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  }));
}

function reqP(rq) { return new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); }

export const keyOf = g => `${g.year}-${g.round}-${g.num}`;

export async function getAll(store = 'games') {
  return tx(store, 'readonly', s => reqP(s.getAll()));
}

const sameOdds = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

// 파싱 결과를 병합 저장. 같은 회차·번호는 덮어쓰되 배당 변동 이력과 결과를 유지.
export async function mergeGames(games, uploadedAt = Date.now()) {
  const existing = new Map((await getAll()).map(g => [g.key, g]));
  let added = 0, updated = 0, oddsChanged = 0, resulted = 0;
  const rows = games.map(g => {
    const key = keyOf(g);
    const old = existing.get(key);
    const hist = old?.oddsHistory ? old.oddsHistory.slice() : [];
    const lastOdds = hist.length ? hist[hist.length - 1].odds : null;
    if (!sameOdds(lastOdds, g.odds)) {
      hist.push({ t: uploadedAt, odds: g.odds });
      if (lastOdds) oddsChanged++;
    }
    const row = { ...old, ...g, key, oddsHistory: hist, updatedAt: uploadedAt };
    if (g.resultRaw == null && old?.resultRaw != null) { // 예측 재업로드가 결과를 지우지 않도록
      row.resultRaw = old.resultRaw; row.outcome = old.outcome; row.void = old.void; row.status = old.status;
      row.odds = old.odds; row.oddsHistory = old.oddsHistory;
    }
    if (old) updated++; else added++;
    if (g.resultRaw != null && old?.resultRaw == null) resulted++;
    return row;
  });
  await tx('games', 'readwrite', s => { rows.forEach(r => s.put(r)); });
  return { added, updated, oddsChanged, resulted };
}

export async function addUpload(info) { return tx('uploads', 'readwrite', s => reqP(s.add(info))); }

export async function deleteRound(year, round) {
  const all = await getAll();
  await tx('games', 'readwrite', s => { all.filter(g => g.year === year && g.round === round).forEach(g => s.delete(g.key)); });
  const ups = await getAll('uploads');
  await tx('uploads', 'readwrite', s => { ups.filter(u => u.year === year && u.round === round).forEach(u => s.delete(u.id)); });
}

export async function clearAll() {
  await tx('games', 'readwrite', s => s.clear());
  await tx('uploads', 'readwrite', s => s.clear());
}

export async function exportJson() {
  return { version: 1, exportedAt: new Date().toISOString(), games: await getAll(), uploads: await getAll('uploads') };
}

export async function importJson(obj, replace = false) {
  if (!obj || !Array.isArray(obj.games)) throw new Error('올바른 백업 파일이 아닙니다');
  if (replace) await clearAll();
  const existing = new Map((await getAll()).map(g => [g.key, g]));
  await tx('games', 'readwrite', s => {
    obj.games.forEach(g => {
      const old = existing.get(g.key);
      if (old && old.updatedAt > (g.updatedAt || 0)) return;
      s.put(g);
    });
  });
  if (Array.isArray(obj.uploads)) {
    const ups = await getAll('uploads');
    const seen = new Set(ups.map(u => `${u.fileName}|${u.at}`));
    await tx('uploads', 'readwrite', s => {
      obj.uploads.forEach(u => { if (!seen.has(`${u.fileName}|${u.at}`)) { const { id, ...rest } = u; s.add(rest); } });
    });
  }
  return obj.games.length;
}
