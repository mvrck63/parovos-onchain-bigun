import { ethers } from 'ethers';
import { eip1559Opts } from './utils.js';

export async function transferPHRS(wallet, toAddress, amountEth) {
  const provider = wallet.provider;
  const value = ethers.parseEther(String(amountEth));
  const opts = await eip1559Opts(provider, 21_000n);

  const tx = await wallet.sendTransaction({
    to: toAddress,
    value,
    ...opts
  });
  const rec = await provider.waitForTransaction(tx.hash);
  return rec;
}
