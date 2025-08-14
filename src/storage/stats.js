import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';

const FILE = process.env.STATS_FILE || './data/wallet-stats.json';

// простенький локальний «лок», щоб записи не топтались одночасно
let queue = Promise.resolve();
function withLock(fn) {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {}); // не зриваємо ланцюжок
  return p;
}

async function ensureFile() {
  const dir = FILE.slice(0, FILE.lastIndexOf('/')) || '.';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(FILE)) await fs.writeFile(FILE, '{}', 'utf8');
}

async function loadDB() {
  await ensureFile();
  try {
    const txt = await fs.readFile(FILE, 'utf8');
    return txt ? JSON.parse(txt) : {};
  } catch {
    return {};
  }
}

async function saveDB(db) {
  await fs.writeFile(FILE, JSON.stringify(db, null, 2), 'utf8');
}

function emptyRec(address = '') {
  return {
    address,
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    swaps: { total: 0, Zenith: 0, Faroswap: 0 },
    liquidityAdds: { total: 0, Zenith: 0, Faroswap: 0 },
    transfers: 0,
    targets: { Zenith: null, Faroswap: null } // заповнимо при ініціалізації
  };
}

function touch(rec) {
  rec.lastUpdatedAt = new Date().toISOString();
}

export async function initWalletStats(privateKey, address) {
  return withLock(async () => {
    const db = await loadDB();
    if (!db[privateKey]) db[privateKey] = emptyRec(address);
    if (!db[privateKey].address) db[privateKey].address = address;
    touch(db[privateKey]);
    await saveDB(db);
  });
}

export async function ensureTargets(privateKey, min = 80, max = 137) {
  return withLock(async () => {
    const db = await loadDB();
    db[privateKey] ??= emptyRec();
    const rec = db[privateKey];
    const pick = () => Math.floor(Math.random() * (max - min + 1)) + min;
    if (!rec.targets || typeof rec.targets !== 'object') {
      rec.targets = { Zenith: pick(), Faroswap: pick() };
    } else {
      if (rec.targets.Zenith == null)  rec.targets.Zenith = pick();
      if (rec.targets.Faroswap == null) rec.targets.Faroswap = pick();
    }
    touch(rec);
    await saveDB(db);
    return rec.targets;
  });
}

export async function getStats(privateKey) {
  const db = await loadDB();
  return db[privateKey] || null;
}

export async function recordSwap(privateKey, dexName) {
  return withLock(async () => {
    const db = await loadDB();
    db[privateKey] ??= emptyRec();
    const rec = db[privateKey];
    rec.swaps.total += 1;
    if (dexName === 'Zenith') rec.swaps.Zenith += 1;
    else if (dexName === 'Faroswap') rec.swaps.Faroswap += 1;
    touch(rec);
    await saveDB(db);
    return rec;
  });
}

export async function recordLiquidityAdd(privateKey, dexName) {
  return withLock(async () => {
    const db = await loadDB();
    db[privateKey] ??= emptyRec();
    const rec = db[privateKey];
    rec.liquidityAdds.total += 1;
    if (dexName === 'Zenith') rec.liquidityAdds.Zenith += 1;
    else if (dexName === 'Faroswap') rec.liquidityAdds.Faroswap += 1;
    touch(rec);
    await saveDB(db);
    return rec;
  });
}

export async function recordTransfer(privateKey) {
  return withLock(async () => {
    const db = await loadDB();
    db[privateKey] ??= emptyRec();
    const rec = db[privateKey];
    rec.transfers += 1;
    touch(rec);
    await saveDB(db);
    return rec;
  });
}
