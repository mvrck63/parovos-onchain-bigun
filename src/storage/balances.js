// src/storage/balances.js
import fs from 'fs';
import { ethers } from 'ethers';

const KYIV_TZ = 'Europe/Kyiv';

function getFilePath() {
  return process.env.BALANCES_FILE || './src/wallet-balances.json';
}

function readDB() {
  const file = getFilePath();
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function writeDB(db) {
  const file = getFilePath();
  const dir = file.split('/').slice(0, -1).join('/');
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8');
}

/**
 * Зберігає знімок балансів (без історії — тільки останні значення).
 * @param {string} privateKey - ключ як ідентифікатор
 * @param {string} address    - адреса гаманця
 * @param {Object} balancesRaw - { SYM: BigInt }, напр. { PHRS: 123n, WPHRS: 456n, ... }
 * @param {(sym:string)=>number} decimalsOf - функція повертає decimals для символу
 */
export async function saveBalancesSnapshot(privateKey, address, balancesRaw, decimalsOf) {
  const now = new Date();
  const iso = now.toISOString();
  const kyiv = now.toLocaleString('uk-UA', { timeZone: KYIV_TZ });

  // перетворення у «людські» одиниці
  const tokens = {};
  const raw = {};
  for (const [sym, v] of Object.entries(balancesRaw)) {
    const symForDec = sym === 'PHRS' ? 'WPHRS' : sym; // PHRS трактуємо як 18
    const dec = decimalsOf(symForDec);
    let formatted;
    try {
      formatted = ethers.formatUnits(v, dec);
    } catch {
      formatted = '0';
    }
    tokens[sym] = formatted; // "людські" значення
    raw[sym] = v.toString(); // сирі BigInt як рядки
  }

  const db = readDB();
  db[privateKey] = {
    address,
    updatedAt: iso,
    updatedAtKyiv: kyiv,
    tokens,
    raw
  };
  writeDB(db);
}
