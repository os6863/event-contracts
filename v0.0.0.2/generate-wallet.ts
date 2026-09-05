/**
 * generate-wallet.ts — v0.0.0.2 helper
 *
 * Generates a brand-new, disposable private key + address. Use this instead
 * of reusing any real wallet — this key will hold a small amount of free
 * testnet STT and nothing else of value.
 *
 * Run:
 *   npm run generate-wallet
 *
 * Then:
 *   1. Copy the address, fund it at the Somnia testnet faucet (linked in
 *      this version's CHANGES.md).
 *   2. Copy the private key into .env as PRIVATE_KEY.
 *   3. Never commit .env, never reuse this key anywhere else.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

console.log("\n🔑 New disposable testnet wallet generated.\n");
console.log(`Address:     ${account.address}`);
console.log(`Private key: ${privateKey}\n`);
console.log("Next steps:");
console.log("  1. Fund this ADDRESS with free STT from the Somnia testnet faucet.");
console.log("  2. Put the PRIVATE KEY above into .env as PRIVATE_KEY=...");
console.log("  3. This wallet is disposable — never reuse it for anything real.\n");
