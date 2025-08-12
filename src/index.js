import { getProvider, getWallet, mask } from './onchain/utils.js';
import net from './config/network.json' assert { type: 'json' };
import contracts from './config/contracts.json' assert { type: 'json' };
import { transferPHRS } from './onchain/transfer.js';
import { wrapPHRS } from './onchain/wrap.js';
import { swapExactIn } from './onchain/swap.js';
import { ethers } from 'ethers';

function logOk(msg)  { console.log('\x1b[32m%s\x1b[0m', `[+] ${msg}`); }
function logInfo(msg){ console.log('\x1b[36m%s\x1b[0m', `[i] ${msg}`); }
function logWarn(msg){ console.log('\x1b[33m%s\x1b[0m', `[!] ${msg}`); }
function logErr(msg) { console.log('\x1b[31m%s\x1b[0m', `[x] ${msg}`); }

(async () => {
  try {
    const provider = getProvider();
    const wallet = getWallet(provider);
    logInfo(`Wallet: ${wallet.address}`);

    // 0) показати баланс
    const bal = await provider.getBalance(wallet.address);
    logInfo(`PHRS balance: ${ethers.formatEther(bal)} PHRS`);

    // 1) простий transfer на рандомну адресу (0.000001 PHRS)
    const to = ethers.Wallet.createRandom().address;
    logInfo(`Transfer → ${mask(to)} (0.000001 PHRS)`);
    const rec1 = await transferPHRS(wallet, to, 0.000001);
    logOk(`Transfer tx: ${net.explorerBase}/tx/${rec1.hash}`);

    // 2) wrap 0.001 PHRS → WPHRS
    logInfo('Wrap 0.001 PHRS → WPHRS');
    const rec2 = await wrapPHRS(wallet, 0.001);
    logOk(`Wrap tx: ${net.explorerBase}/tx/${rec2.hash}`);

    // 3) свап невеликої суми: WPHRS → USDC (0.0001 WPHRS)
    logInfo('Swap 0.0001 WPHRS → USDC (fee 0.05%)');
    const rec3 = await swapExactIn(wallet, {
      fromSym: 'WPHRS',
      toSym: 'USDC',
      amount: 0.0001,
      fee: 500
    });
    logOk(`Swap tx: ${net.explorerBase}/tx/${rec3.hash}`);

    logOk('Done (single-wallet run).');
  } catch (e) {
    logErr(e.message || e);
    process.exit(1);
  }
})();
