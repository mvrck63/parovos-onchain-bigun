// src/index.js
import 'dotenv/config';
import fs from 'fs';
import { ethers } from 'ethers';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import {
  getProvider,
  withRpcRetry,
  sleep,
  randInt,
  randBetween,
  KYIV_TZ,
} from './onchain/utils.js';
import net from './config/network.json' with { type: 'json' };
import contracts from './config/contracts.json' with { type: 'json' };
import { swapExactIn } from './onchain/swap.js';
import { wrapPHRS, unwrapPHRS } from './onchain/wrap.js';
import {
  initWalletStats,
  ensureTargets,
  getStats,
  recordSwap,
  // recordLiquidityAdd,
  // recordTransfer,
} from './storage/stats.js';

/* =========================
   КОЛЬОРИ + ЧАСОВА ПОЗНАЧКА
========================= */
const COLOR = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
};
const USE_COLOR = String(process.env.NO_COLOR || '') !== '1';
const paint = (c, s) => (USE_COLOR ? `${c}${s}${COLOR.reset}` : s);

const fmtTime = () =>
  `${new Date().toLocaleTimeString('uk-UA', {
    timeZone: KYIV_TZ,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })} Kyiv`;

function mkLogger(prefix = '') {
  const p = prefix ? `[${prefix}] ` : '';
  return {
    ok:  (m) => console.log(`${paint(COLOR.cyan, `[${fmtTime()}]`)} ${p}${paint(COLOR.green,  `[+] ${m}`)}`),
    info:(m) => console.log(`${paint(COLOR.cyan, `[${fmtTime()}]`)} ${p}${paint(COLOR.cyan,   `[i] ${m}`)}`),
    warn:(m) => console.log(`${paint(COLOR.cyan, `[${fmtTime()}]`)} ${p}${paint(COLOR.yellow, `[!] ${m}`)}`),
    err: (m) => console.log(`${paint(COLOR.cyan, `[${fmtTime()}]`)} ${p}${paint(COLOR.red,    `[x] ${m}`)}`),
  };
}
const G = mkLogger();

/* =========================
   ENV ПАРАМЕТРИ
========================= */
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3);

const SWAPS_MIN = Number(process.env.SWAPS_MIN ?? 80);
const SWAPS_MAX = Number(process.env.SWAPS_MAX ?? 137);

const MIN_BASE = Number(process.env.RAND_MIN ?? 0.0008);
const MAX_BASE = Number(process.env.RAND_MAX ?? 0.004);

const ST_MIN   = Number(process.env.STABLE_MIN ?? 0.02);
const ST_MAX   = Number(process.env.STABLE_MAX ?? 0.20);
const ST_FRMIN = Number(process.env.STABLE_FRAC_MIN ?? 0.08);
const ST_FRMAX = Number(process.env.STABLE_FRAC_MAX ?? 0.25);

const CAP_PCT  = Number(process.env.SWAP_CAP_PCT ?? 0.30);

const GLOBAL_GAP_MIN_SEC = Number(process.env.GLOBAL_GAP_MIN_SEC ?? 60);
const GLOBAL_GAP_MAX_SEC = Number(process.env.GLOBAL_GAP_MAX_SEC ?? 120);

const START_JITTER_MIN_MS = Number(process.env.START_JITTER_MIN_MS ?? 0);
const START_JITTER_MAX_MS = Number(process.env.START_JITTER_MAX_MS ?? 15000);

const NIGHT_SILENCE = Number(process.env.NIGHT_SILENCE ?? 0) === 1;
const NIGHT_START = Number(process.env.NIGHT_START ?? 0);
const NIGHT_END = Number(process.env.NIGHT_END ?? 6);

const BATCH_MIN = Number(process.env.BATCH_MIN ?? 2);
const BATCH_MAX = Number(process.env.BATCH_MAX ?? Math.max(2, CONCURRENCY));

const WAVE_MIN_MIN = Number(process.env.WAVE_MIN_MIN ?? 12);
const WAVE_MAX_MIN = Number(process.env.WAVE_MAX_MIN ?? 25);

const WAVE_COOLDOWN_MIN_MIN = Number(process.env.WAVE_COOLDOWN_MIN_MIN ?? 3);
const WAVE_COOLDOWN_MAX_MIN = Number(process.env.WAVE_COOLDOWN_MAX_MIN ?? 5);

/* =========================
   МЕРЕЖА/РОУТЕРИ/ТОКЕНИ
========================= */
const EXPLORER = net.explorerBase || 'https://testnet.pharosscan.xyz';

const ROUTER_ADDR = {
  Zenith:   contracts.routerMulticall,
  Faroswap: contracts.routerMulticall2,
};
const ROUTERS = Object.values(ROUTER_ADDR).filter(Boolean);

// address(lower) -> 'Zenith' | 'Faroswap'
const DEX_KEY_BY_ADDR = {};
for (const [key, addr] of Object.entries(ROUTER_ADDR)) {
  if (addr) DEX_KEY_BY_ADDR[addr.toLowerCase()] = key;
}
const shortAddr = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

// які стабли реально присутні у config
const POSSIBLE_STABLES = ['USD_coin', 'tether_usd', 'USDC', 'USDT'];
const STABLES = new Set(
  Object.keys(contracts.tokens || {}).filter((s) => POSSIBLE_STABLES.includes(s))
);
const WRAPPED = new Set(['WPHRS']);

/* =========================
   ПОБУДОВА ПАР ДЛЯ СВОПІВ
========================= */
function buildSwapPairs() {
  const pairs = [];
  for (const s of STABLES) {
    if (contracts.tokens[s]) {
      pairs.push({ fromSym: 'PHRS', toSym: s });
      pairs.push({ fromSym: s,      toSym: 'PHRS' });
    }
  }
  for (const w of WRAPPED) {
    for (const s of STABLES) {
      if (contracts.tokens[w] && contracts.tokens[s]) {
        pairs.push({ fromSym: w, toSym: s });
        pairs.push({ fromSym: s, toSym: w });
      }
    }
  }
  const stabs = Array.from(STABLES).filter((sym) => contracts.tokens[sym]);
  for (let i = 0; i < stabs.length; i++) {
    for (let j = i + 1; j < stabs.length; j++) {
      const a = stabs[i], b = stabs[j];
      pairs.push({ fromSym: a, toSym: b });
      pairs.push({ fromSym: b, toSym: a });
    }
  }
  // прямий PHRS<->WPHRS ми *не* додаємо сюди принципово
  return pairs;
}
const SWAP_PAIRS = buildSwapPairs();

/* =========================
   DECIMALS CACHE
========================= */
const DEC = { ...(contracts.decimals || {}) };
const fmtUnits = (v, dec) => Number(ethers.formatUnits(v, dec));
function getDec(sym) { return DEC[sym] ?? 18; }

async function prefetchDecimals(provider, L = G) {
  const abi = ['function decimals() view returns (uint8)'];
  const tokens = contracts.tokens || {};
  for (const [sym, addr] of Object.entries(tokens)) {
    if (DEC[sym] != null) continue;
    try {
      const c = new ethers.Contract(addr, abi, provider);
      const d = await withRpcRetry(`decimals(${sym})`, () => c.decimals());
      DEC[sym] = Number(d);
    } catch {
      L.warn(`decimals() failed for ${sym}, defaulting 18`);
      DEC[sym] = 18;
    }
  }
}

/* =========================
   КЛЮЧІ/ГАМАНЦІ
========================= */
function loadPrivateKeys() {
  const file = './wallets.txt';
  let keys = [];
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    keys = raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    G.info(`Loaded ${keys.length} private key(s) from wallets.txt (raw)`);
  } else {
    const single = process.env.PRIVATE_KEY || '';
    const list = process.env.PRIVATE_KEYS || '';
    if (single) keys.push(single.trim());
    if (list) list.split(/[,\s]+/).forEach((k) => k && keys.push(k.trim()));
    if (!keys.length) throw new Error('No keys: provide wallets.txt or env PRIVATE_KEY(S)');
  }
  const valid = keys.filter((k) => /^0x[0-9a-fA-F]{64}$/.test(k));
  G.info(`Using ${valid.length}/${keys.length} valid key(s) after validation`);
  return valid;
}

/* =========================
   БАЛАНСИ
========================= */
async function getAllBalances(wallet) {
  const provider = wallet.provider;
  const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
  const syms = Object.keys(contracts.tokens || {});
  const map = {};
  for (const sym of syms) {
    const addr = contracts.tokens[sym];
    const c = new ethers.Contract(addr, erc20Abi, wallet);
    const bal = await withRpcRetry(`balanceOf(${sym})`, () => c.balanceOf(wallet.address));
    map[sym] = bal;
  }
  map.PHRS = await withRpcRetry('getBalance(PHRS)', () => provider.getBalance(wallet.address));
  return map;
}

/* =========================
   ВИБІР СУМИ СВОПУ
========================= */
function pickSwapAmount(pair, balances) {
  const sym = pair.fromSym;
  const decIn = getDec(sym === 'PHRS' ? 'WPHRS' : sym);
  const balUnits = fmtUnits(balances[sym] ?? 0n, decIn);

  let desired;
  if (STABLES.has(sym)) {
    const base = randBetween(ST_MIN, ST_MAX);
    const frac = randBetween(ST_FRMIN, ST_FRMAX);
    desired = Math.max(base, balUnits * frac);
  } else if (sym === 'PHRS' || decIn === 18) {
    const base = randBetween(MIN_BASE, MAX_BASE);
    const fr = randBetween(0.02, 0.08);
    desired = Math.max(base, balUnits * fr);
  } else {
    const base = randBetween(MIN_BASE * 2, MAX_BASE * 2);
    desired = Math.max(base, balUnits * 0.05);
  }

  const cap = balUnits * CAP_PCT;
  const amount = Math.min(desired, cap);

  const minFloor = (sym === 'PHRS' || decIn === 18) ? MIN_BASE * 0.5 : 0.005;
  if (!amount || amount < minFloor) return null;

  const precision = (sym === 'PHRS' || decIn === 18) ? 6 : 4;
  return Number(amount.toFixed(precision));
}

/* =========================
   ГЛОБАЛЬНИЙ GAP МІЖ TX
========================= */
// helper для експоненційного розподілу (Пуассонівський процес інтервалів)
function randExp(meanSec) {
  const u = Math.random();
  return -Math.log(1 - u) * meanSec; // секунди
}

let nextAllowedAt = 0;

/**
 * Глобальний мінімальний інтервал + персональний джиттер воркера.
 * - Глобальна частина гарантує, що транзакції не ліпляться близько.
 * - Персональний джиттер робить час очікування різним у кожного воркера.
 */
async function waitGlobalGap(L) {
  const now = Date.now();

  // скільки ще треба дочекатися до глобальної “наступної мітки”
  const baseWaitMs = Math.max(0, nextAllowedAt - now);

  // персональний додатковий джиттер
  const extraMin = Number(process.env.EXTRA_GAP_MIN_SEC ?? 10);
  const extraMax = Number(process.env.EXTRA_GAP_MAX_SEC ?? 45);
  const extraSec = randInt(extraMin, extraMax);
  const extraMs = extraSec * 1000 + randInt(0, 750); // +трохи мілісекунд для більшої «солі»

  const totalWaitMs = baseWaitMs + extraMs;

  if (totalWaitMs > 0) {
    const totalSec = Math.ceil(totalWaitMs / 1000);
    L.info(`Global gap: waiting ${totalSec}s before next tx`);
    await sleep(totalWaitMs);
  }

  // після виконання — ставимо НОВУ глобальну “наступну мітку”
  const mode = (process.env.GLOBAL_GAP_MODE || 'uniform').toLowerCase();
  if (mode === 'poisson') {
    const mean = Number(process.env.GLOBAL_GAP_MEAN_SEC ?? 75);
    const gapSec = Math.max(5, Math.round(randExp(mean))); // не менше 5с
    nextAllowedAt = Date.now() + gapSec * 1000;
  } else {
    const min = Number(process.env.GLOBAL_GAP_MIN_SEC ?? 60);
    const max = Number(process.env.GLOBAL_GAP_MAX_SEC ?? 120);
    const gapSec = randInt(min, max);
    nextAllowedAt = Date.now() + gapSec * 1000;
  }
}


/* =========================
   БАН DEX ДЛЯ ПАР
========================= */
const PAIR_DEX_BAN = new Map(); // key: "A->B", value: Set('Zenith'|'Faroswap'|routerAddr)
const pairKey = (p) => `${p.fromSym}->${p.toSym}`;

/* =========================
   РЕЖИМ РОБОТИ (1/2)
========================= */
let MODE = 1;          // 1 = стандартний; 2 = тільки свопи зі стейблами (без прямого PHRS<->WPHRS)
let ALLOW_WRAP = true; // wrap/unwrap дозволені під капотом для PHRS↔стейбл

async function selectMode() {
  const envMode = (process.env.MODE || '').trim();
  if (envMode === '1' || envMode === '2') {
    MODE = Number(envMode);
  } else if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input, output });
    console.log('');
    console.log(paint(COLOR.cyan, '=== Оберіть режим запуску ==='));
    console.log(paint(COLOR.cyan, '1) Стандартний (wrap+swap, swap+unwrap, усі свопи)'));
    console.log(paint(COLOR.cyan, '2) Лише свопи зі стейблами (PHRS↔стейбл, WPHRS↔стейбл, стейбл↔стейбл; БЕЗ PHRS↔WPHRS)'));
    const ans = (await rl.question(paint(COLOR.yellow, 'Введіть 1 або 2: '))).trim();
    rl.close();
    MODE = (ans === '2') ? 2 : 1;
  } else {
    MODE = 1;
  }

  ALLOW_WRAP = true; // під капотом для PHRS↔стейбл завжди можна

  const modeLabel = MODE === 1
    ? 'Стандартний'
    : 'Лише свопи зі стейблами (без прямого PHRS↔WPHRS)';
  console.log(paint(COLOR.cyan, `[${fmtTime()}] [i] Режим: ${modeLabel}`));
}

/* =========================
   SWAP З ПРІОРИТЕТОМ DEX
========================= */
async function swapWithPreference(L, wallet, pair, amount, preferDexKey) {
  if (ROUTERS.length === 0) {
    L.warn('No routers configured');
    return { ok: false };
  }

  const preferAddr = preferDexKey ? ROUTER_ADDR[preferDexKey] : null;
  const otherAddrs = ROUTERS.filter((a) => a && a !== preferAddr);
  const order = preferAddr ? [preferAddr, ...otherAddrs] : [...ROUTERS];

  const banned = PAIR_DEX_BAN.get(pairKey(pair)) || new Set();

  for (const routerAddr of order) {
    const dexKey = DEX_KEY_BY_ADDR[routerAddr.toLowerCase()] || null;
    const label = dexKey || shortAddr(routerAddr);
    if (banned.has(dexKey || routerAddr)) {
      L.info(`Skip ${label} for ${pairKey(pair)} (banned)`);
      continue;
    }

    let succeeded = false;
    for (const fee of [500, 3000]) {
      try {
        await waitGlobalGap(L);
        L.info(`Swap ${amount} ${pair.fromSym} → ${pair.toSym} via ${label} (fee ${fee/10000}%)`);
        const rec = await swapExactIn(wallet, {
          ...pair,
          amount,
          fee,
          routerAddress: routerAddr,
        });
        L.ok(`Swap tx: ${EXPLORER}/tx/${rec.hash}`);
        succeeded = true;
        return { ok: true, dexKey, tx: rec };
      } catch (e) {
        const msg = e?.shortMessage || e?.message || String(e);
        L.warn(`Swap failed (${label}, fee ${fee}): ${msg}`);
      }
    }

    if (!succeeded) {
      banned.add(dexKey || routerAddr);
      PAIR_DEX_BAN.set(pairKey(pair), banned);
      L.info(`Ban ${label} for pair ${pairKey(pair)} (both fee tiers failed)`);
    }
  }

  return { ok: false };
}

/* =========================
   UNIFIED SWAP (усі сценарії)
========================= */
async function unifiedSwap(L, wallet, privateKey, balances, preferDexName) {
  // кандидати з балансом + фільтр: режим 2 забороняє лише прямий PHRS↔WPHRS
  const candidates = SWAP_PAIRS.filter((p) => {
    if ((p.fromSym === 'PHRS' && p.toSym === 'WPHRS') ||
        (p.fromSym === 'WPHRS' && p.toSym === 'PHRS')) {
      return false; // заборонено в обох режимах (ми так задумали)
    }

    const dec = getDec(p.fromSym === 'PHRS' ? 'WPHRS' : p.fromSym);
    const balUnits = fmtUnits(balances[p.fromSym] ?? 0n, dec);
    const minNeed = (p.fromSym === 'PHRS' || dec === 18) ? 0.0005 : 0.005;
    return balUnits > minNeed;
  });

  if (!candidates.length) {
    L.warn('Skip: no sufficient balances for any pair');
    return false;
  }

  const pair = candidates[randInt(0, candidates.length - 1)];
  const amount = pickSwapAmount(pair, balances);
  if (!amount) {
    L.warn(`Skip ${pair.fromSym}->${pair.toSym}: too small amount`);
    return false;
  }

  // PHRS → стейбл (wrap під капотом)
  if (pair.fromSym === 'PHRS' && STABLES.has(pair.toSym)) {
    const need = ethers.parseEther(String(amount));
    if ((balances.PHRS ?? 0n) < need) {
      L.warn(`Skip PHRS→${pair.toSym}: insufficient PHRS`);
      return false;
    }
    const head = (MODE === 2 ? 'Swap' : 'Wrap+Swap');
    L.info(`${head} ${amount} PHRS → ${pair.toSym} (pref=${preferDexName || 'auto'})`);

    if (MODE !== 2) { // у режимі 2 можна приховати wrap у логах; але транзакція все одно відбудеться на роутері
      await waitGlobalGap(L);
      const recW = await wrapPHRS(wallet, amount);
      L.ok(`Wrap tx: ${EXPLORER}/tx/${recW.hash}`);
    }

    const { ok, dexKey } = await swapWithPreference(
      L, wallet,
      { fromSym: 'WPHRS', toSym: pair.toSym },
      amount,
      preferDexName
    );
    if (!ok) return false;

    await recordSwap(privateKey, dexKey || '');
    L.info(`${head} completed via ${dexKey || 'Unknown'}`);
    return true;
  }

  // стейбл → PHRS (unwrap під капотом)
  if (STABLES.has(pair.fromSym) && pair.toSym === 'PHRS') {
    const decIn = getDec(pair.fromSym);
    const need = ethers.parseUnits(String(amount), decIn);
    if ((balances[pair.fromSym] ?? 0n) < need) {
      L.warn(`Skip ${pair.fromSym}→PHRS: insufficient ${pair.fromSym}`);
      return false;
    }
    const head = (MODE === 2 ? 'Swap' : 'Swap+Unwrap');
    L.info(`${head} ${amount} ${pair.fromSym} → PHRS (pref=${preferDexName || 'auto'})`);

    const w = new ethers.Contract(contracts.tokens.WPHRS, ['function balanceOf(address) view returns (uint256)'], wallet);
    const before = await withRpcRetry('WPHRS.balanceOf(before)', () => w.balanceOf(wallet.address));

    const { ok, dexKey } = await swapWithPreference(
      L, wallet,
      { fromSym: pair.fromSym, toSym: 'WPHRS' },
      amount,
      preferDexName
    );
    if (!ok) return false;
    await recordSwap(privateKey, dexKey || '');

    const after = await withRpcRetry('WPHRS.balanceOf(after)', () => w.balanceOf(wallet.address));
    const delta = after - before;
    if (delta > 0n && MODE !== 2) {
      const outAmt = Number(ethers.formatUnits(delta, 18));
      await waitGlobalGap(L);
      const recU = await unwrapPHRS(wallet, outAmt);
      L.ok(`Unwrap ${outAmt} WPHRS → PHRS: ${EXPLORER}/tx/${recU.hash} (after ${dexKey || 'Unknown'})`);
    }
    return true;
  }

  // інші напрями: WPHRS↔стейбл, стейбл↔стейбл
  {
    const { ok, dexKey } = await swapWithPreference(L, wallet, pair, amount, preferDexName);
    if (ok) await recordSwap(privateKey, dexKey || '');
    return !!ok;
  }
}

/* =========================
   ВОРКЕР ГАМАНЦЯ (на час хвилі)
========================= */
async function runWallet(provider, privateKey, workerId, stopAtTs) {
  const L = mkLogger(`W${workerId}`);
  const wallet = new ethers.Wallet(privateKey, provider);

  // стартовий джиттер
  const startJ = randInt(START_JITTER_MIN_MS, START_JITTER_MAX_MS);
  L.info(`Start jitter: ${Math.round(startJ / 1000)}s`);
  await sleep(startJ);

  await initWalletStats(privateKey, wallet.address);
  const targets = await ensureTargets(privateKey, SWAPS_MIN, SWAPS_MAX);

  L.info(`=== Wallet ${wallet.address} ===`);
  L.info(`Targets → Zenith: ${targets.Zenith}, Faroswap: ${targets.Faroswap}`);

  await prefetchDecimals(provider, L);

  while (true) {
    if (NIGHT_SILENCE) {
      const hour = Number(new Date().toLocaleString('uk-UA', { timeZone: KYIV_TZ, hour12: false, hour: '2-digit' }));
      const start = NIGHT_START % 24;
      const end   = NIGHT_END % 24;
      const inNight = start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
      if (inNight) {
        L.info(`Night silence: sleeping 5 min`);
        await sleep(5 * 60 * 1000);
        continue;
      }
    }

    if (Date.now() >= stopAtTs) {
      L.ok(`Wave deadline reached for ${wallet.address}`);
      break;
    }

    const stats = await getStats(privateKey);
    const z = stats?.swaps?.Zenith || 0;
    const f = stats?.swaps?.Faroswap || 0;
    const tz = stats?.targets?.Zenith ?? targets.Zenith;
    const tf = stats?.targets?.Faroswap ?? targets.Faroswap;
    if (z >= tz && f >= tf) {
      L.ok(`Reached targets (Z:${z}/${tz}, F:${f}/${tf})`);
      break;
    }

    let prefer = null;
    const needZ = Math.max(0, tz - z);
    const needF = Math.max(0, tf - f);
    if (needZ > needF)      prefer = 'Zenith';
    else if (needF > needZ) prefer = 'Faroswap';
    else if (needZ > 0)     prefer = Math.random() < 0.5 ? 'Zenith' : 'Faroswap';

    let balances;
    try {
      balances = await getAllBalances(wallet);
    } catch (e) {
      L.warn(`Balances fetch failed: ${e?.message || e}`);
      await sleep(randInt(3000, 7000));
      continue;
    }

    try {
      await unifiedSwap(L, wallet, privateKey, balances, prefer);
    } catch (e) {
      L.err(`worker error: ${e?.message || e}`);
      await sleep(randInt(3000, 8000));
    }
  }
}

/* =========================
   ПУЛ/ХВИЛІ
========================= */
async function runPool(keys, limit, runMinutes) {
  const provider = getProvider();
  const total = keys.length;
  const workers = Math.min(limit, total);
  const stopAt = Date.now() + Math.round(runMinutes * 60 * 1000);

  G.info(`Spawning ${workers} worker(s) for ${total} wallet(s)`);

  const tasks = [];
  for (let i = 0; i < workers; i++) {
    const pk = keys[i];
    tasks.push(runWallet(provider, pk, i + 1, stopAt));
  }
  await Promise.allSettled(tasks);
}

/* =========================
   WAVES РЕЖИМ
========================= */
async function runWaves(allKeys) {
  G.info(`Starting WAVES mode (random batches, random durations)…`);

  let wave = 1;
  while (true) {
    const batchSize = Math.min(
      randInt(BATCH_MIN, BATCH_MAX),
      CONCURRENCY,
      allKeys.length
    );
    const runMin = randBetween(WAVE_MIN_MIN, WAVE_MAX_MIN);
    G.info(`Wave #${wave}: running ${batchSize} wallet(s) for ${runMin.toFixed(1)} min`);

    const shuffled = [...allKeys];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const batch = shuffled.slice(0, batchSize);
    batch.forEach((pk, idx) => {
      const addr = new ethers.Wallet(pk).address;
      G.info(`  • W${idx + 1} ${addr} (${addr.slice(0, 6)}…${addr.slice(-4)})`);
    });

    await runPool(batch, batchSize, runMin);

    const cdMin = randInt(WAVE_COOLDOWN_MIN_MIN, WAVE_COOLDOWN_MAX_MIN);
    G.info(`Wave #${wave} done. Cooldown ${cdMin} min…`);
    await sleep(cdMin * 60 * 1000);
    wave++;
  }
}

/* =========================
   MAIN
========================= */
(async () => {
  try {
    await selectMode(); // вибір режиму 1/2

    const statsPath = process.env.STATS_FILE || './src/wallet-stats.json';
    G.info(`STATS_FILE: ${statsPath}`);

    const keys = loadPrivateKeys();
    await runWaves(keys);
  } catch (e) {
    G.err(e?.message || e);
    process.exit(1);
  }
})();
