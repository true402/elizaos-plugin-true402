// x402.ts — pay a true402 endpoint and return its JSON. The whole protocol: 402 → sign EIP-3009 → 200.
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const USDC_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

export interface Verdict {
  rating: 'avoid' | 'caution' | 'ok';
  score: number;
  reasons: string[];
}
export interface TokenReport {
  token: string;
  verdict?: Verdict;
  safety?: Record<string, unknown>;
}

interface Accept {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount?: string;
  maxAmountRequired?: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

/** Run token-report for a Base token over x402, paying with the given Base wallet. */
export async function payTokenReport(
  token: string,
  opts: { payerPrivateKey: string; baseUrl?: string; rpcUrl?: string },
): Promise<TokenReport> {
  const baseUrl = opts.baseUrl ?? 'https://true402.dev/api';
  const rpcUrl = opts.rpcUrl ?? 'https://mainnet.base.org';
  const key = (opts.payerPrivateKey.startsWith('0x') ? opts.payerPrivateKey : `0x${opts.payerPrivateKey}`) as Hex;
  const account = privateKeyToAccount(key);
  const url = `${baseUrl}/v1/base/token-report`;
  const body = JSON.stringify({ token });

  const first = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (first.status === 200) return (await first.json()) as TokenReport;
  if (first.status !== 402) throw new Error(`expected HTTP 402, got ${first.status}`);

  const challenge = (await first.json()) as { accepts?: Accept[] };
  const req = (challenge.accepts ?? []).find((a) => a.scheme === 'exact');
  if (!req) throw new Error('no x402 "exact" payment requirement in the 402');

  const usdc = getAddress(req.asset);
  const value = BigInt(req.amount ?? req.maxAmountRequired ?? '0');
  const pub = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const held = (await pub.readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [account.address] })) as bigint;
  if (held < value) throw new Error(`payer ${account.address} holds ${held} < ${value} USDC base units — fund it`);

  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: getAddress(req.payTo),
    value,
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + (req.maxTimeoutSeconds ?? 120)),
    nonce: `0x${randomBytes(32).toString('hex')}` as Hex,
  };
  const signature = await account.signTypedData({
    domain: { name: req.extra?.name ?? 'USD Coin', version: req.extra?.version ?? '2', chainId: base.id, verifyingContract: usdc },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  });
  const xPayment = Buffer.from(JSON.stringify({
    x402Version: 2, scheme: 'exact', network: req.network,
    payload: {
      signature,
      authorization: {
        from: authorization.from, to: authorization.to, value: value.toString(),
        validAfter: authorization.validAfter.toString(), validBefore: authorization.validBefore.toString(), nonce: authorization.nonce,
      },
    },
  })).toString('base64');

  const paid = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-PAYMENT': xPayment }, body });
  if (paid.status !== 200) throw new Error(`paid request failed (HTTP ${paid.status})`);
  return (await paid.json()) as TokenReport;
}
