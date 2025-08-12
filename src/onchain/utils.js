import { config as loadEnv } from 'dotenv';
import { ethers } from 'ethers';
import fs from 'fs';

loadEnv();

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

export async function eip1559Opts(provider, gasLimit) {
  const fee = await provider.getFeeData();
  return {
    gasLimit,
    maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('3', 'gwei'),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei'),
  };
}

export function parseAmount(amountStr, decimals) {
  return ethers.parseUnits(String(amountStr), decimals);
}

export function mask(addrOrKey) {
  if (!addrOrKey) return '';
  const s = String(addrOrKey);
  return s.length <= 12 ? s : `${s.slice(0, 6)}...${s.slice(-6)}`;
}
