import fs from 'fs';
import { ethers } from 'ethers';
import { getProvider, sleep, randInt, randBetween } from './onchain/utils.js';
import net from './config/network.json' with { type: 'json' };
import contracts from './config/contracts.json' with { type: 'json' };
import { swapExactIn } from './onchain/swap.js';
import { wrapPHRS, unwrapPHRS } from './onchain/wrap.js';
import { saveBalancesSnapshot } from './storage/balances.js';
import {
  initWalletStats, ensureTargets, getStats, recordSwap
  // recordLiquidityAdd, recordTransfer
} from './storage/stats.js';

/* ───────── LOGGERS with Kyiv timestamp ──────── */
function mkLogger(prefix = '') {
  const p = prefix ? `[${prefix}] ` : '';
  const tz = 'Europe/Kyiv';
  const ts = () =>
    new Date().toLocaleTimeString('uk-UA', { timeZone: tz, hour12: false }); // HH:MM:SS

  const line = (tag, color, msg) =>
    console.log(`${color}%s\x1b[0m`, `[${ts()} Kyiv] ${p}${tag} ${msg}`);

  return {
    ok:   (m) => line('[+]', '\x1b[32m', m),
    info: (m) => line('[i]', '\x1b[36m', m),
    warn: (m) => line('[!]', '\x1b[33m', m),
    err:  (m) => line('[x]', '\x1b[31m', m),
  };
}
const G = mkLogger();

/* ──────────────────────────────── ENV PARAMS ───────────────────────────── */
const MIN_BASE = Number(process.env.RAND_MIN ?? 0.0008);     // PHRS/WPHRS
const MAX_BASE = Number(process.env.RAND_MAX ?? 0.004);

const ST_MIN   = Number(process.env.STABLE_MIN ?? 0.02);     // стейбли (для USD_coin/tether_usd)
const ST_MAX   = Number(process.env.STABLE_MAX ?? 0.20);
const ST_FRMIN = Number(process.env.STABLE_FRAC_MIN ?? 0.08);
const ST_FRMAX = Number(process.env.STABLE_FRAC_MAX ?? 0.25);

const CAP_PCT        = Number(process.env.SWAP_CAP_PCT ?? 0.30);    // ≤30% балансу
const STABLE_ABS_MIN = Number(process.env.STABLE_ABS_MIN ?? 0.02);
const STABLE_ABS_MAX = Number(process.env.STABLE_ABS_MAX ?? 1.5);
const PHRS_ABS_MAX   = Number(process.env.PHRS_ABS_MAX   ?? 0.02);

const SWAPS_MIN = Number(process.env.SWAPS_MIN ?? 80);       // цілі DEX
const SWAPS_MAX = Number(process.env.SWAPS_MAX ?? 137);

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 5);    // паралельність

// анти-кластер
const GLOBAL_GAP_MIN_SEC = Number(process.env.GLOBAL_GAP_MIN_SEC ?? 60);
const GLOBAL_GAP_MAX_SEC = Number(process.env.GLOBAL_GAP_MAX_SEC ?? 120);

// стартовий джиттер воркерів
const START_JITTER_MIN_MS = Number(process.env.START_JITTER_MIN_MS ?? 0);
const START_JITTER_MAX_MS = Number(process.env.START_JITTER_MAX_MS ?? 300000);

// хвилі (waves)
const BATCH_MIN = Number(process.env.BATCH_MIN ?? 2);
const BATCH_MAX = Number(process.env.BATCH_MAX ?? CONCURRENCY);
const WAVE_MIN_MIN = Number(process.env.WAVE_MIN_MIN ?? 12);
const WAVE_MAX_MIN = Number(process.env.WAVE_MAX_MIN ?? 25);
const WAVE_COOLDOWN_MIN_MIN = Number(process.env.WAVE_COOLDOWN_MIN_MIN ?? 3);
const WAVE_COOLDOWN_MAX_MIN = Number(process.env.WAVE_COOLDOWN_MAX_MIN ?? 7);


// нічний режим (Europe/Kyiv)
const NIGHT_SILENCE = Number(process.env.NIGHT_SILENCE ?? 0) === 1;
const NIGHT_START   = Number(process.env.NIGHT_START ?? 0);   // 0..23
const NIGHT_END     = Number(process.env.NIGHT_END ?? 6);     // 0..23

/* ──────────────────────────────── TOKEN SETS ───────────────────────────── */
/** УВАГА: USDC/USDT видалені за побажанням */
const STABLES = new Set(['USD_coin', 'tether_usd']);
const WRAPPED = new Set(['WPHRS']);

/* ───────────────────────────── PAIR GENERATION ─────────────────────────── */
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
  const stabs = Array.from(STABLES).filter(sym => contracts.tokens[sym]);
  for (let i = 0; i < stabs.length; i++) {
    for (let j = i + 1; j < stabs.length; j++) {
      const a = stabs[i], b = stabs[j];
      pairs.push({ fromSym: a, toSym: b });
      pairs.push({ fromSym: b, toSym: a });
    }
  }
  return pairs;
}
const SWAP_PAIRS = buildSwapPairs();

/* ─────────────────────────────── ROUTERS / DEX ─────────────────────────── */
const ROUTER_ADDR = {
  Zenith:   contracts.routerMulticall,
  Faroswap: contracts.routerMulticall2,
};
const ROUTERS = Object.values(ROUTER_ADDR).filter(Boolean);
const ROUTER_NAMES = {};
if (contracts.routerMulticall)  ROUTER_NAMES[contracts.routerMulticall.toLowerCase()]  = 'Zenith';
if (contracts.routerMulticall2) ROUTER_NAMES[contracts.routerMulticall2.toLowerCase()] = 'Faroswap';
const dexLabel = (addr) => ROUTER_NAMES[addr.toLowerCase()] ?? `${addr.slice(0, 6)}…`;

/* ──────────────────────────────── DECIMALS ─────────────────────────────── */
const DEC = { ...(contracts.decimals || {}) };
const fmtUnits = (v, dec) => Number(ethers.formatUnits(v, dec));
function getDec(sym) {
  if (sym === 'PHRS' || sym === 'WPHRS') return 18;
  if (STABLES.has(sym)) return 6;
  return DEC[sym] ?? 18;
}

async function prefetchDecimals(provider, L = G) {
  const abi = ['function decimals() view returns (uint8)'];
  const tokens = contracts.tokens || {};
  for (const [sym, addr] of Object.entries(tokens)) {
    if (DEC[sym] != null) continue;
    try {
      const c = new ethers.Contract(addr, abi, provider);
      const d = await c.decimals();
      DEC[sym] = Number(d);
    } catch {
      L.warn(`decimals() failed for ${sym}, defaulting to 18`);
      DEC[sym] = 18;
    }
  }
}

/* ────────────────────────────── LOAD KEYS (DIAG) ───────────────────────── */
function loadPrivateKeys() {
  const file = './wallets.txt';
  let keys = [];
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    keys = raw
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('#'));
    G.info(`Loaded ${keys.length} private key(s) from wallets.txt (raw)`);
  } else {
    const single = process.env.PRIVATE_KEY || '';
    const list = process.env.PRIVATE_KEYS || '';
    if (single) keys.push(single.trim());
    if (list) list.split(/[,\s]+/).forEach(k => k && keys.push(k.trim()));
    if (keys.length === 0) throw new Error('No private keys found. Create wallets.txt or set PRIVATE_KEY(S) in .env');
    G.info(`Loaded ${keys.length} private key(s) from environment (raw)`);
  }

  const uniq = Array.from(new Set(keys));
  const valid = uniq.filter(k => /^0x[0-9a-fA-F]{64}$/.test(k));
  const invalid = uniq.filter(k => !valid.includes(k));

  if (invalid.length) {
    G.warn(`Filtered out ${invalid.length} invalid key(s):`);
    invalid.forEach((k, i) => {
      const mask = k.length > 12 ? `${k.slice(0,6)}…${k.slice(-4)}` : k;
      G.warn(`  [bad ${i+1}] "${mask}" (len=${k.length})`);
    });
  }
  G.info(`Using ${valid.length}/${uniq.length} valid key(s) after validation`);

  // перемішати
  for (let i = valid.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [valid[i], valid[j]] = [valid[j], valid[i]];
  }
  return valid;
}

/* ──────────────────────────────── BALANCES ─────────────────────────────── */
async function getAllBalances(wallet) {
  const provider = wallet.provider;
  const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
  const syms = Object.keys(contracts.tokens || {});
  const entries = await Promise.all(syms.map(async (sym) => {
    const addr = contracts.tokens[sym];
    const c = new ethers.Contract(addr, erc20Abi, wallet);
    const bal = await c.balanceOf(wallet.address);
    return [sym, bal];
  }));
  const map = Object.fromEntries(entries);
  map.PHRS = await provider.getBalance(wallet.address);
  return map;
}

/* ───────────────────────────── AMOUNT PICKER ───────────────────────────── */
function pickSwapAmount(pair, balances) {
  const sym = pair.fromSym;
  const decIn = getDec(sym === 'PHRS' ? 'WPHRS' : sym);
  const balUnits = fmtUnits(balances[sym] ?? 0n, decIn);

  let desired;
  if (STABLES.has(sym)) {
    const base = randBetween(ST_MIN, ST_MAX);
    const frac = randBetween(ST_FRMIN, ST_FRMAX);
    desired = Math.max(base, balUnits * frac);
    desired = Math.min(desired, balUnits * CAP_PCT, STABLE_ABS_MAX);
    if (desired < STABLE_ABS_MIN) return null;
    return Number(desired.toFixed(4));
  } else {
    const base = randBetween(MIN_BASE, MAX_BASE);
    const frac = randBetween(0.02, 0.08);
    desired = Math.max(base, balUnits * frac);
    desired = Math.min(desired, balUnits * CAP_PCT, PHRS_ABS_MAX);
    const minFloor = MIN_BASE * 0.5;
    if (desired < minFloor) return null;
    return Number(desired.toFixed(6));
  }
}

/* ───────────────────────────── ANTI-CLUSTER GATE ───────────────────────── */
let _txGate = Promise.resolve();
let _lastTxAt = 0;

function withTxGate(fn) {
  const p = _txGate.then(fn, fn);
  _txGate = p.catch(() => {});
  return p;
}

async function waitGlobalGap(L) {
  const minMs = GLOBAL_GAP_MIN_SEC * 1000;
  const maxMs = GLOBAL_GAP_MAX_SEC * 1000;
  const gap   = randInt(minMs, maxMs);
  return withTxGate(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, _lastTxAt + gap - now);
    if (waitMs > 0) {
      L.info(`Global gap: waiting ${(waitMs/1000).toFixed(0)}s before next tx`);
      await sleep(waitMs);
    }
    _lastTxAt = Date.now();
  });
}

function isNightNowKyiv() {
  if (!NIGHT_SILENCE) return false;
  const now = new Date();
  const kyiv = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kyiv' }));
  const h = kyiv.getHours();
  return (NIGHT_START < NIGHT_END)
    ? (h >= NIGHT_START && h < NIGHT_END)
    : (h >= NIGHT_START || h < NIGHT_END);
}

/* ─────────────────────────────── SWAP HELPERS ──────────────────────────── */
async function swapWithPreference(L, wallet, privateKey, pair, amount, preferDexName) {
  if (ROUTERS.length === 0) {
    L.warn('No routers configured in contracts.json');
    return false;
  }
  const preferAddr = preferDexName ? ROUTER_ADDR[preferDexName] : null;
  const otherAddrs = ROUTERS.filter(a => a && a !== preferAddr);
  const order = preferAddr ? [preferAddr, ...otherAddrs] : [...ROUTERS].sort(() => Math.random() - 0.5);

  for (const routerAddr of order) {
    for (const fee of [500, 3000]) {
      try {
        const dexName = dexLabel(routerAddr);
        L.info(`Swap ${amount} ${pair.fromSym} → ${pair.toSym} via ${dexName} (fee ${fee/10000}%)`);
        await waitGlobalGap(L); // анти-кластер перед будь-яким swap
        const rec = await swapExactIn(wallet, { ...pair, amount, fee, routerAddress: routerAddr });
        L.ok(`Swap tx: ${net.explorerBase}/tx/${rec.hash}`);
        await recordSwap(privateKey, dexName);
        return true;
      } catch (e) {
        L.warn(`Swap failed (${dexLabel(routerAddr)}, fee ${fee}): ${e.shortMessage || e.message || e}`);
      }
    }
  }
  L.warn('Swap skipped: all routers and fee tiers failed.');
  return false;
}

async function unifiedSwap(L, wallet, privateKey, balances, preferDexName) {
  const candidates = SWAP_PAIRS.filter(p => {
    const dec = getDec(p.fromSym === 'PHRS' ? 'WPHRS' : p.fromSym);
    const balUnits = fmtUnits(balances[p.fromSym] ?? 0n, dec);
    const minNeed = (p.fromSym === 'PHRS' || dec === 18) ? 0.0005 : 0.005;
    return balUnits > minNeed;
  });
  if (candidates.length === 0) {
    L.warn('Skip: no sufficient balances for any swap');
    return false;
  }

  const pair = candidates[randInt(0, candidates.length - 1)];
  const amount = pickSwapAmount(pair, balances);
  if (!amount) {
    L.warn(`Skip ${pair.fromSym}->${pair.toSym}: too small affordable amount`);
    return false;
  }

  // PHRS → стейбл: wrap + swap(WPHRS→стейбл)
  if (pair.fromSym === 'PHRS' && STABLES.has(pair.toSym)) {
    const need = ethers.parseEther(String(amount));
    if ((balances.PHRS ?? 0n) < need) {
      L.warn(`Skip PHRS→${pair.toSym}: insufficient PHRS`);
      return false;
    }
    L.info(`Wrap+Swap ${amount} PHRS → ${pair.toSym}`);
    await waitGlobalGap(L); // анти-кластер перед wrap
    const recW = await wrapPHRS(wallet, amount);
    L.ok(`Wrap tx: ${net.explorerBase}/tx/${recW.hash}`);
    return await swapWithPreference(L, wallet, privateKey, { fromSym: 'WPHRS', toSym: pair.toSym }, amount, preferDexName);
  }

  // стейбл → PHRS: swap(стейбл→WPHRS) + unwrap
  if (STABLES.has(pair.fromSym) && pair.toSym === 'PHRS') {
    const decIn = getDec(pair.fromSym);
    const need = ethers.parseUnits(String(amount), decIn);
    if ((balances[pair.fromSym] ?? 0n) < need) {
      L.warn(`Skip ${pair.fromSym}→PHRS: insufficient ${pair.fromSym}`);
      return false;
    }
    L.info(`Swap+Unwrap ${amount} ${pair.fromSym} → PHRS`);
    const w = new ethers.Contract(contracts.tokens.WPHRS, ['function balanceOf(address) view returns (uint256)'], wallet);
    const before = await w.balanceOf(wallet.address);
    const ok = await swapWithPreference(L, wallet, privateKey, { fromSym: pair.fromSym, toSym: 'WPHRS' }, amount, preferDexName);
    if (!ok) return false;
    const after = await w.balanceOf(wallet.address);
    const delta = after - before;
    if (delta > 0n) {
      const outAmt = Number(ethers.formatUnits(delta, 18));
      await waitGlobalGap(L); // анти-кластер перед unwrap
      const recU = await unwrapPHRS(wallet, outAmt);
      L.ok(`Unwrap ${outAmt} WPHRS → PHRS: ${net.explorerBase}/tx/${recU.hash}`);
    }
    return true;
  }

  // інші випадки
  return await swapWithPreference(L, wallet, privateKey, pair, amount, preferDexName);
}

/* ──────────────────────────────── WORKER ───────────────────────────────── */
async function runWallet(provider, privateKey, workerId, stopAt) {
  const L = mkLogger(`W${workerId}`);
  const wallet = new ethers.Wallet(privateKey, provider);

  L.info(`=== Wallet ${wallet.address} ===`);

  let targets;
  try {
    await initWalletStats(privateKey, wallet.address);
    targets = await ensureTargets(privateKey, SWAPS_MIN, SWAPS_MAX);
  } catch (e) {
    L.err(`init/targets failed: ${e.message || e}`);
    return;
  }

  L.info(`Targets → Zenith: ${targets.Zenith}, Faroswap: ${targets.Faroswap}`);

  {
  const balances0 = await getAllBalances(wallet);
  await saveBalancesSnapshot(privateKey, wallet.address, balances0, (s) => getDec(s));
  }

  while (true) {
    // ←— додано: м’яка зупинка хвилі
    if (stopAt && Date.now() >= stopAt) {
      L.info('Wave deadline reached → stopping this wallet loop');
      break;
    }

    if (isNightNowKyiv()) {
      L.info('Night-silence window → sleeping 5 min');
      await sleep(5 * 60 * 1000);
      continue;
    }

    const stats = await getStats(privateKey);
    const z = stats?.swaps?.Zenith || 0;
    const f = stats?.swaps?.Faroswap || 0;
    const tz = stats?.targets?.Zenith ?? targets.Zenith;
    const tf = stats?.targets?.Faroswap ?? targets.Faroswap;

    if (z >= tz && f >= tf) {
      L.ok(`Reached targets (Z:${z}/${tz}, F:${f}/${tf}).`);
      break;
    }

    let prefer = null;
    const needZ = Math.max(0, tz - z);
    const needF = Math.max(0, tf - f);
    if (needZ > needF)      prefer = 'Zenith';
    else if (needF > needZ) prefer = 'Faroswap';
    else if (needZ > 0)     prefer = Math.random() < 0.5 ? 'Zenith' : 'Faroswap';

    const balances = await getAllBalances(wallet);
    try {
      await unifiedSwap(L, wallet, privateKey, balances, prefer);
    } catch (e) {
      L.err(e.message || e);
    }

    await sleep(randInt(3000, 12000)); // локальна пауза воркера
  }
}


/* ──────────────────────────────── POOL ─────────────────────────────────── */
async function runPool(provider, keys, limit, stopAt) {
  await prefetchDecimals(provider, G);

  let index = 0;
  const total = keys.length;
  const active = [];

  const startWorker = async (workerId) => {
    const L = mkLogger(`W${workerId}`);
    await sleep(randInt(START_JITTER_MIN_MS, START_JITTER_MAX_MS));
    while (true) {
      const myIdx = index++;
      if (myIdx >= total) break;
      const pk = keys[myIdx];
      try {
        await runWallet(provider, pk, workerId, stopAt);
      } catch (e) {
        L.err(`worker crashed: ${e.message || e}`);
      }
    }
  };

  const workers = Math.min(limit, total);
  G.info(`Spawning ${workers} worker(s) for ${keys.length} wallet(s)`);
  for (let w = 1; w <= workers; w++) {
    active.push(startWorker(w));
  }
  await Promise.allSettled(active);
}

function maskAddr(a) { return a.slice(0,6) + '…' + a.slice(-4); }

async function runWaves() {
  const provider = getProvider();
  await prefetchDecimals(provider, G);

  let wave = 1;
  while (true) {
    // щоразу перечитуємо wallets.txt — раптом ти додав/забрав ключі
    const allKeys = loadPrivateKeys();
    if (allKeys.length === 0) {
      G.warn('No wallets found — sleeping 1 min');
      await sleep(60_000);
      continue;
    }

    // випадковий розмір батчу
    const targetBatch = Math.max(1, Math.min(
      randInt(BATCH_MIN, BATCH_MAX),
      CONCURRENCY,
      allKeys.length
    ));

    // випадковий вибір targetBatch ключів
    const shuffled = [...allKeys].sort(() => Math.random() - 0.5);
    const keys = shuffled.slice(0, targetBatch);

    // випадкова тривалість хвилі
    const durationMs = randInt(WAVE_MIN_MIN * 60_000, WAVE_MAX_MIN * 60_000);
    const stopAt = Date.now() + durationMs;

    G.info(`Wave #${wave}: running ${keys.length} wallet(s) for ${(durationMs/60000).toFixed(1)} min`);
    keys.forEach((pk, i) => {
      const addr = new ethers.Wallet(pk).address;
      G.info(`  • W${i+1} ${addr} (${maskAddr(addr)})`);
    });

    // погнали хвилю
    await runPool(provider, keys, keys.length, stopAt);
    G.ok(`Wave #${wave} finished`);

    // випадкова пауза між хвилями
    const coolMs = randInt(WAVE_COOLDOWN_MIN_MIN * 60_000, WAVE_COOLDOWN_MAX_MIN * 60_000);
    G.info(`Cooldown ${(coolMs/60000).toFixed(1)} min…`);
    await sleep(coolMs);

    wave++;
  }
}

/* ──────────────────────────────── MAIN ─────────────────────────────────── */
(async () => {
  try {
    const statsPath = process.env.STATS_FILE || './src/wallet-stats.json';
    console.log(
      '\x1b[36m%s\x1b[0m',
      `[${new Date().toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour12: false })} Kyiv] [i] STATS_FILE: ${statsPath}`
    );
    G.info(`Starting WAVES mode (random batches, random durations)…`);
    await runWaves(); // безкінечний цикл хвиль
  } catch (e) {
    G.err(e.message || e);
    process.exit(1);
  }
})();