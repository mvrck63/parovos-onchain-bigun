import { config as loadEnv } from 'dotenv';
import { ethers } from 'ethers';

loadEnv();

// ---------- RPC & Wallet ----------
export function getProvider() {
  const rpcUrl = process.env.RPC_URL;
  const chainId = Number(process.env.CHAIN_ID || 0);
  if (!rpcUrl || !chainId) throw new Error('RPC_URL/CHAIN_ID not set');
  return new ethers.JsonRpcProvider(rpcUrl, { chainId, name: 'pharos' });
}

export function getWallet(provider) {
  const pk = process.env.PRIVATE_KEY;
  if (!pk || !pk.startsWith('0x')) throw new Error('PRIVATE_KEY not set');
  return new ethers.Wallet(pk, provider);
}

// ---------- Gas opts (EIP-1559) ----------
export async function eip1559Opts(provider, gasLimit) {
  const fee = await provider.getFeeData();
  return {
    gasLimit,
    maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('3', 'gwei'),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei'),
  };
}

// ---------- Helpers ----------
export function parseAmount(amountStr, decimals) {
  return ethers.parseUnits(String(amountStr), decimals);
}

export function mask(s) {
  if (!s) return '';
  const str = String(s);
  return str.length <= 12 ? str : `${str.slice(0, 6)}...${str.slice(-6)}`;
}

export function tzFormat(unixSeconds, tz = 'Europe/Kyiv') {
  return new Date(unixSeconds * 1000).toLocaleString('en-GB', { timeZone: tz });
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function randInt(min, max) {
  const a = Math.ceil(min), b = Math.floor(max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

export function randBetween(min, max, precision = 6) {
  const v = Math.random() * (max - min) + min;
  return Number(v.toFixed(precision));
}

// ---------- Robust receipt polling ----------
export async function waitForReceiptWithRetry(provider, txHash, maxRetries = 8, baseDelayMs = 800) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const rec = await provider.getTransactionReceipt(txHash);
      if (rec) return rec;
    } catch (e) {
      // -32004 = "The service was busy." на вашому RPC
      if (e?.code !== -32004) throw e;
    }
    await sleep(baseDelayMs * (2 ** i)); // експоненційна пауза
  }
  throw new Error(`Timeout waiting receipt for ${txHash}`);
}
