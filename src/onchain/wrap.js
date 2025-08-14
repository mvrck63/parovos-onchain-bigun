import { ethers } from 'ethers';
import contracts from '../config/contracts.json' with { type: 'json' };
import { eip1559Opts } from './utils.js';

const erc20WethLike = [
  'function deposit() payable',
  'function withdraw(uint256 wad)',
  'function balanceOf(address) view returns (uint256)'
];

export async function wrapPHRS(wallet, amountEth) {
  const provider = wallet.provider;
  const w = new ethers.Contract(contracts.tokens.WPHRS, erc20WethLike, wallet);
  const value = ethers.parseEther(String(amountEth));
  const est = await w.deposit.estimateGas({ value });
  const opts = await eip1559Opts(provider, (est * 12n) / 10n);
  const tx = await w.deposit({ value, ...opts });
  return await provider.waitForTransaction(tx.hash);
}

// NEW: unwrap WPHRS -> PHRS
export async function unwrapPHRS(wallet, amountWPHRS) {
  const provider = wallet.provider;
  const w = new ethers.Contract(contracts.tokens.WPHRS, erc20WethLike, wallet);
  const wad = ethers.parseUnits(String(amountWPHRS), 18);
  const est = await w.withdraw.estimateGas(wad);
  const opts = await eip1559Opts(provider, (est * 12n) / 10n);
  const tx = await w.withdraw(wad, opts);
  return await provider.waitForTransaction(tx.hash);
}
