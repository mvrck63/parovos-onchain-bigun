// src/onchain/utils.js
import { ethers } from 'ethers';
import 'dotenv/config';

export const KYIV_TZ = 'Europe/Kyiv';

// ───────── helpers
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const randInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
export const randBetween = (a, b) => a + Math.random() * (b - a);

// ───────── Provider (без батчингу) + Fallback на кілька RPC
export function getProvider() {
  const chainId = Number(process.env.CHAIN_ID || 688688);
  const name = 'pharos-testnet';

  const urls = (process.env.RPC_URLS || process.env.RPC_URL || '')
    .split(/[,\s]+/)
    .filter(Boolean);

  if (!urls.length) {
    throw new Error('Set RPC_URLS or RPC_URL in .env');
  }

  // мережу задаємо у 2-му аргументі, а в options ставимо staticNetwork: true
  const network = { chainId, name };

  const mk = (url) =>
    new ethers.JsonRpcProvider(
      url,
      network,
      {
        staticNetwork: true,  // <- БУЛЕВЕ; зафіксувати мережу й не "перемикати"
        batchMaxCount: 1,     // без батчингу
        batchMaxSize: 0,
        batchStallTime: 1,
      }
    );

  if (urls.length === 1) return mk(urls[0]);

  const provs = urls.map((u) => ({ provider: mk(u), priority: 1, weight: 1 }));
  // кворум 1: достатньо відповіді будь-якого RPC
  return new ethers.FallbackProvider(provs, 1);
}


// ───────── універсальні ретраї на тимчасові RPC-помилки
export async function withRpcRetry(label, fn, { retries = 5, base = 800 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const txt = `${e.code || ''} ${e.shortMessage || e.message || e}`;
      // тимчасові: код -32008, SERVER_ERROR, busy/system error, timeouts, мережеві
      const transient =
        e.code === 'SERVER_ERROR' ||
        /-32008|busy|service was busy|system error|ECONNRESET|ETIMEDOUT|fetch|network/i.test(
          txt
        );

      if (!transient || i === retries) throw e;

      const delay = Math.round(base * Math.pow(2, i) + Math.random() * 500);
      console.log(`[rpc-retry] ${label}: ${txt} — retry in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
}

// ───────── чек квитанції з ретраями / експон. backoff
export async function waitForReceiptWithRetry(
  provider,
  txHash,
  { maxRetries = 12, baseDelayMs = 1000 } = {}
) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const rc = await provider.getTransactionReceipt(txHash);
      if (rc) return rc;
    } catch (e) {
      const txt = `${e.code || ''} ${e.shortMessage || e.message || e}`;
      const transient =
        e.code === 'SERVER_ERROR' ||
        /-32008|busy|service was busy|system error|ECONNRESET|ETIMEDOUT|fetch|network/i.test(
          txt
        );
      if (!transient || i === maxRetries) throw e;
    }
    const delay = Math.round(baseDelayMs * Math.pow(2, i) + Math.random() * 400);
    await sleep(delay);
  }
  throw new Error(`Failed to get receipt for ${txHash}`);
}
