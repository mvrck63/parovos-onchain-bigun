// src/onchain/swap.js
import { ethers } from 'ethers';
import contracts from '../config/contracts.json' with { type: 'json' };
import { withRpcRetry, waitForReceiptWithRetry } from './utils.js';

// Кеш decimals за символом токена (WPHRS, USD_coin, tether_usd)
const decCache = new Map();
function getDecFromConfig(sym) {
  const d = (contracts.decimals || {})[sym];
  if (d != null) return Number(d);
  // PHRS нативний: беремо як 18, а свопимо через WPHRS
  if (sym === 'PHRS') return 18;
  return null;
}

async function getTokenDecimals(wallet, sym) {
  if (decCache.has(sym)) return decCache.get(sym);
  let d = getDecFromConfig(sym);
  if (d == null) {
    try {
      const addr = contracts.tokens[sym];
      const c = new ethers.Contract(addr, ['function decimals() view returns (uint8)'], wallet);
      d = await withRpcRetry(`decimals(${sym})`, () => c.decimals());
      d = Number(d);
    } catch {
      d = 18; // дефолт
    }
  }
  decCache.set(sym, d);
  return d;
}

async function ensureAllowance(wallet, tokenAddr, owner, spender, needWei) {
  const erc20 = new ethers.Contract(
    tokenAddr,
    [
      'function allowance(address,address) view returns (uint256)',
      'function approve(address,uint256) returns (bool)'
    ],
    wallet
  );

  const current = await withRpcRetry('allowance', () => erc20.allowance(owner, spender));
  if (current >= needWei) return;

  const est = await withRpcRetry('estimateGas:approve', () =>
    erc20.approve.estimateGas(spender, ethers.MaxUint256)
  );
  const fee = await withRpcRetry('getFeeData', () => wallet.provider.getFeeData());
  const overrides = { gasLimit: Math.ceil(Number(est) * 1.2) };
  if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
    overrides.maxFeePerGas = fee.maxFeePerGas;
    overrides.maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
  } else if (fee.gasPrice) {
    overrides.gasPrice = fee.gasPrice;
  }
  const tx = await erc20.approve(spender, ethers.MaxUint256, overrides);
  await waitForReceiptWithRetry(wallet.provider, tx.hash);
}

/**
 * swapExactIn — своп exactInputSingle через uniswap-вподібний роутер з multicall(deadline, data[]).
 * Очікує, що fromSym — ERC-20 (тобто для PHRS зроби wrap перед цим).
 *
 * @param {ethers.Wallet} wallet
 * @param {{fromSym:string,toSym:string,amount:number,fee:number,routerAddress:string}} p
 * @returns {Promise<ethers.TransactionReceipt>}
 */
export async function swapExactIn(wallet, p) {
  const { fromSym, toSym, amount, fee, routerAddress } = p;

  if (!contracts.tokens[fromSym] || !contracts.tokens[toSym]) {
    throw new Error(`Unknown token symbol in contracts.json: ${fromSym} or ${toSym}`);
  }
  if (!routerAddress) throw new Error('routerAddress is required');

  const tokenIn = contracts.tokens[fromSym];
  const tokenOut = contracts.tokens[toSym];

  const decIn = await getTokenDecimals(wallet, fromSym);
  const amountIn = ethers.parseUnits(String(amount), decIn);

  // allowance
  await ensureAllowance(wallet, tokenIn, wallet.address, routerAddress, amountIn);

  // exactInputSingle params as per 0x04e45aaf
  // encode: (address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ['address', 'address', 'uint24', 'address', 'uint256', 'uint256', 'uint160'],
    [tokenIn, tokenOut, fee, wallet.address, amountIn, 0n, 0n]
  );
  const selector = '0x04e45aaf'; // exactInputSingle
  const callData = ethers.concat([selector, encoded]);

  const router = new ethers.Contract(
    routerAddress,
    ['function multicall(uint256 deadline, bytes[] data) payable'],
    wallet
  );

  const deadline = Math.floor(Date.now() / 1000) + 600; // 10 хв
  const est = await withRpcRetry('estimateGas:multicall', () =>
    router.multicall.estimateGas(deadline, [callData])
  );
  const feeData = await withRpcRetry('getFeeData', () => wallet.provider.getFeeData());

  const overrides = { gasLimit: Math.ceil(Number(est) * 1.2), value: 0n };
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    overrides.maxFeePerGas = feeData.maxFeePerGas;
    overrides.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
  } else if (feeData.gasPrice) {
    overrides.gasPrice = feeData.gasPrice;
  }

  const tx = await router.multicall(deadline, [callData], overrides);
  const rc = await waitForReceiptWithRetry(wallet.provider, tx.hash);
  return rc;
}
