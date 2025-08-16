// src/onchain/wrap.js
import { ethers } from 'ethers';
import contracts from '../config/contracts.json' with { type: 'json' };
import { withRpcRetry, waitForReceiptWithRetry } from './utils.js';

function getWphrsAddress() {
  const a = contracts.tokens?.WPHRS;
  if (!a) throw new Error('WPHRS address is missing in contracts.json');
  return a;
}

/**
 * wrapPHRS — deposit() у WPHRS (1:1)
 * @param {ethers.Wallet} wallet
 * @param {number} amount amount in PHRS (ether units)
 * @returns {Promise<ethers.TransactionReceipt>}
 */
export async function wrapPHRS(wallet, amount) {
  const addr = getWphrsAddress();
  const w = new ethers.Contract(addr, ['function deposit() payable'], wallet);

  const value = ethers.parseEther(String(amount));

  const est = await withRpcRetry('estimateGas:wrap(deposit)', () =>
    w.deposit.estimateGas({ value })
  );
  const fee = await withRpcRetry('getFeeData', () => wallet.provider.getFeeData());

  const overrides = { gasLimit: Math.ceil(Number(est) * 1.2), value };
  if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
    overrides.maxFeePerGas = fee.maxFeePerGas;
    overrides.maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
  } else if (fee.gasPrice) {
    overrides.gasPrice = fee.gasPrice;
  }

  const tx = await w.deposit(overrides);
  const rc = await waitForReceiptWithRetry(wallet.provider, tx.hash);
  return rc;
}

/**
 * unwrapPHRS — withdraw(wad) з WPHRS у PHRS
 * @param {ethers.Wallet} wallet
 * @param {number} amount amount in WPHRS (ether units)
 * @returns {Promise<ethers.TransactionReceipt>}
 */
export async function unwrapPHRS(wallet, amount) {
  const addr = getWphrsAddress();
  const w = new ethers.Contract(addr, ['function withdraw(uint256)'], wallet);

  const wad = ethers.parseUnits(String(amount), 18);

  const est = await withRpcRetry('estimateGas:unwrap(withdraw)', () =>
    w.withdraw.estimateGas(wad)
  );
  const fee = await withRpcRetry('getFeeData', () => wallet.provider.getFeeData());

  const overrides = { gasLimit: Math.ceil(Number(est) * 1.2) };
  if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
    overrides.maxFeePerGas = fee.maxFeePerGas;
    overrides.maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
  } else if (fee.gasPrice) {
    overrides.gasPrice = fee.gasPrice;
  }

  const tx = await w.withdraw(wad, overrides);
  const rc = await waitForReceiptWithRetry(wallet.provider, tx.hash);
  return rc;
}
