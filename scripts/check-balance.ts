import "dotenv/config";
import { createPublicClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { normalizePrivateKey } from "../src/analysis.js";

const account = privateKeyToAccount(normalizePrivateKey(process.env.PRIVATE_KEY));
const publicClient = createPublicClient({ chain: somniaShannon, transport: http() });

const balance = await publicClient.getBalance({ address: account.address });
console.log(`Address: ${account.address}`);
console.log(`Balance: ${formatEther(balance)} STT`);
