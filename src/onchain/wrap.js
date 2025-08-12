import { ethers } from 'ethers';
import contracts from '../config/contracts.json' assert { type: 'json' };
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

  // gas estimate
  const est = await w.deposit.estimateGas({ value });
  const opts = await eip1559Opts(provider, (est * 12n) / 10n);

  const tx = await w.deposit({ value, ...opts });
  const rec = await provider.waitForTransaction(tx.hash);
  return rec;
}
