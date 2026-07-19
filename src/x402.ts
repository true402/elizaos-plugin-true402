// x402.ts — pay a true402 endpoint and return its JSON. The whole protocol: 402 → sign EIP-3009 → 200.
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const USDC_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// Never sign an authorization window longer than 10 min — a rogue 402 must not get an
// open-ended EIP-3009 authorization (same class as MCP audit F11). Floor keeps a sane minimum.
const MAX_AUTH_WINDOW_S = 600;
const MIN_AUTH_WINDOW_S = 30;
const PROBE_TIMEOUT_MS = 30_000;
const PAID_TIMEOUT_MS = 120_000; // token-report legitimately takes tens of seconds

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

/**
 * Parse the auto-pay ceiling FAIL-CLOSED: unset/empty → the $0.10 default; a non-numeric,
 * negative, or non-finite value → 0 = refuse ALL auto-pay (never silently unlimited).
 */
export function parseMaxPaymentUsdc(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === '') return 0.1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** Run token-report for a Base token over x402, paying with the given Base wallet. */
export async function payTokenReport(
  token: string,
  opts: {
    payerPrivateKey: string;
    baseUrl?: string;
    rpcUrl?: string;
    maxAmountUsd?: number;
    /** Test seam: override the on-chain USDC balance read. */
    readBalance?: (owner: `0x${string}`) => Promise<bigint>;
  },
): Promise<TokenReport> {
  const baseUrl = opts.baseUrl ?? 'https://true402.dev/api';
  const rpcUrl = opts.rpcUrl ?? 'https://mainnet.base.org';
  const key = (opts.payerPrivateKey.startsWith('0x') ? opts.payerPrivateKey : `0x${opts.payerPrivateKey}`) as Hex;
  const account = privateKeyToAccount(key);
  const url = `${baseUrl}/v1/base/token-report`;
  const body = JSON.stringify({ token });

  const first = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (first.status === 200) return (await first.json()) as TokenReport;
  if (first.status !== 402) throw new Error(`expected HTTP 402, got ${first.status}`);

  const challenge = (await first.json()) as { accepts?: Accept[] };
  const req = (challenge.accepts ?? []).find((a) => a.scheme === 'exact');
  if (!req) throw new Error('no x402 "exact" payment requirement in the 402');

  // Only sign a USDC-on-Base charge within the caller's cap — a rogue/compromised endpoint can't make
  // the agent authorize an unexpected asset/network, an excessive amount, or a zero/garbage amount.
  if (req.network && req.network !== 'eip155:8453') throw new Error(`unexpected payment network "${req.network}" (expected eip155:8453) — refusing to sign`);
  const usdc = getAddress(req.asset);
  if (usdc !== getAddress(BASE_USDC)) throw new Error(`unexpected payment asset ${usdc} (expected Base USDC) — refusing to sign`);
  const rawAmount = req.amount ?? req.maxAmountRequired;
  if (!rawAmount || !/^\d+$/.test(rawAmount) || BigInt(rawAmount) <= 0n) {
    throw new Error('402 carries no positive payment amount — refusing to sign');
  }
  const value = BigInt(rawAmount);
  const capUsd = opts.maxAmountUsd ?? 0.1;
  const capAtomic = BigInt(Math.round(capUsd * 1e6));
  if (value > capAtomic) throw new Error(`402 demands ${value} USDC base units, over the $${capUsd} cap (maxAmountUsd) — refusing to sign`);

  const readBalance =
    opts.readBalance ??
    (async (owner: `0x${string}`) => {
      const pub = createPublicClient({ chain: base, transport: http(rpcUrl) });
      return (await pub.readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [owner] })) as bigint;
    });
  const held = await readBalance(account.address);
  if (held < value) throw new Error(`payer ${account.address} holds ${held} < ${value} USDC base units — fund it`);

  const now = Math.floor(Date.now() / 1000);
  const windowS = Math.min(MAX_AUTH_WINDOW_S, Math.max(MIN_AUTH_WINDOW_S, req.maxTimeoutSeconds ?? 120));
  const authorization = {
    from: account.address,
    to: getAddress(req.payTo),
    value,
    validAfter: BigInt(now - 60),
    validBefore: BigInt(now + windowS),
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

  const paid = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-PAYMENT': xPayment },
    body,
    signal: AbortSignal.timeout(PAID_TIMEOUT_MS),
  });
  if (paid.status !== 200) throw new Error(`paid request failed (HTTP ${paid.status})`);
  return (await paid.json()) as TokenReport;
}
