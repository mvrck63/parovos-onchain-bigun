// src/storage/stats.js
import fs from 'fs';

const STATS_FILE = process.env.STATS_FILE || './src/wallet-stats.json';

function loadDB() {
  if (!fs.existsSync(STATS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveDB(db) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(db, null, 2));
}

function ensureSchemaEntry(entry, address = null) {
  const nowIso = new Date().toISOString();
  if (!entry.createdAt) entry.createdAt = nowIso;
  entry.lastUpdatedAt = entry.lastUpdatedAt || nowIso;

  if (address && !entry.address) entry.address = address;

  entry.swaps = entry.swaps || { total: 0, Zenith: 0, Faroswap: 0 };
  entry.liquidityAdds = entry.liquidityAdds || { total: 0, Zenith: 0, Faroswap: 0 };
  if (typeof entry.transfers !== 'number') entry.transfers = 0;

  entry.targets = entry.targets || { Zenith: 0, Faroswap: 0 };

  return entry;
}

function touch(entry) {
  entry.lastUpdatedAt = new Date().toISOString();
}

export async function initWalletStats(privateKey, address) {
  const db = loadDB();
  db[privateKey] = ensureSchemaEntry(db[privateKey] || {}, address);
  saveDB(db);
}

export async function ensureTargets(privateKey, min, max) {
  const db = loadDB();
  db[privateKey] = ensureSchemaEntry(db[privateKey] || {});
  const s = db[privateKey];

  if (!s.targets || (s.targets.Zenith === 0 && s.targets.Faroswap === 0)) {
    const z = Math.floor(Math.random() * (max - min + 1)) + min;
    const f = Math.floor(Math.random() * (max - min + 1)) + min;
    s.targets = { Zenith: z, Faroswap: f };
    touch(s);
    saveDB(db);
  }
  return s.targets;
}

export async function getStats(privateKey) {
  const db = loadDB();
  return db[privateKey] ? ensureSchemaEntry(db[privateKey]) : null;
}

export async function recordSwap(privateKey, dexName) {
  const db = loadDB();
  db[privateKey] = ensureSchemaEntry(db[privateKey] || {});
  const s = db[privateKey];

  const key = (dexName || '').toLowerCase();
  s.swaps.total = (s.swaps.total || 0) + 1;
  if (key === 'zenith')    s.swaps.Zenith   = (s.swaps.Zenith   || 0) + 1;
  else if (key === 'faroswap') s.swaps.Faroswap = (s.swaps.Faroswap || 0) + 1;

  touch(s);
  saveDB(db);
}

// — на майбутнє —
export async function recordLiquidityAdd(privateKey, dexName) {
  const db = loadDB();
  db[privateKey] = ensureSchemaEntry(db[privateKey] || {});
  const s = db[privateKey];

  const key = (dexName || '').toLowerCase();
  s.liquidityAdds.total = (s.liquidityAdds.total || 0) + 1;
  if (key === 'zenith')    s.liquidityAdds.Zenith   = (s.liquidityAdds.Zenith   || 0) + 1;
  else if (key === 'faroswap') s.liquidityAdds.Faroswap = (s.liquidityAdds.Faroswap || 0) + 1;

  touch(s);
  saveDB(db);
}

export async function recordTransfer(privateKey) {
  const db = loadDB();
  db[privateKey] = ensureSchemaEntry(db[privateKey] || {});
  const s = db[privateKey];

  s.transfers = (s.transfers || 0) + 1;

  touch(s);
  saveDB(db);
}
