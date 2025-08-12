import { ethers } from 'ethers';
import contracts from '../config/contracts.json' assert { type: 'json' };
import { eip1559Opts, parseAmount } from './utils.js';

const erc20 = [
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)'
];

const multicallAbi = [
  'function multicall(uint256 deadline, bytes[] data) payable'
];

// селектор exactInputSingle
const EXACT_INPUT_SINGLE_SELECTOR = '0x04e45aaf';

export async function swapExactIn(wallet, { fromSym, toSym, amount, fee = 500 }) {
  const provider = wallet.provider;

  const tokenIn = contracts.tokens[fromSym];
  const tokenOut = contracts.tokens[toSym];
  if (!tokenIn || !tokenOut) throw new Error('Bad token symbols');

  const decIn = contracts.decimals[fromSym];
  const amountIn = parseAmount(amount, decIn);

  // 1) баланс
  const tIn = new ethers.Contract(tokenIn, erc20, wallet);
  const bal = await tIn.balanceOf(wallet.address);
  if (bal < amountIn) throw new Error(`Insufficient ${fromSym} balance`);

  // 2) approve на роутер
  const spender = contracts.routerMulticall;
  const current = await tIn.allowance(wallet.address, spender);
  if (current < amountIn) {
    const estA = await tIn.approve.estimateGas(spender, ethers.MaxUint256);
    const optsA = await eip1559Opts(provider, (estA * 12n) / 10n);
    const txA = await tIn.approve(spender, ethers.MaxUint256, optsA);
    await provider.waitForTransaction(txA.hash);
  }

  // 3) exactInputSingle params (tuple)
  const types = [
    'address','address','uint24','address','uint256','uint256','uint256','uint160'
  ];
  const values = [
    tokenIn,          // tokenIn
    tokenOut,         // tokenOut
    fee,              // fee tier
    wallet.address,   // recipient
    amountIn,         // amountIn
    0,                // amountOutMinimum (0 = без ліміту, для тестнету ок)
    0,                // sqrtPriceLimitX96
    0
  ];
  const encodedParams = ethers.AbiCoder.defaultAbiCoder()
    .encode([`tuple(${types.join(',')})`], [values]);

  const callData = ethers.concat([EXACT_INPUT_SINGLE_SELECTOR, encodedParams]);

  // 4) multicall
  const router = new ethers.Contract(contracts.routerMulticall, multicallAbi, wallet);
  const deadline = Math.floor(Date.now() / 1000) + 300;

  const est = await router.multicall.estimateGas(deadline, [callData]);
  const opts = await eip1559Opts(provider, (est * 12n) / 10n);

  const tx = await router.multicall(deadline, [callData], opts);
  const rec = await provider.waitForTransaction(tx.hash);
  return rec;
}
