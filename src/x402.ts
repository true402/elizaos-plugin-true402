// x402.ts — pay a true402 endpoint and return its JSON. The whole protocol: 402 → sign EIP-3009 → 200.
import { randomBytes } from 'node:crypto';
import { createPublicClient, http, getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { CLIENT } from './client.js';

const USDC_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** The only rail this client settles on. true402 also quotes Solana, with the SAME `exact` scheme. */
const BASE_NETWORK = 'eip155:8453';
// Never sign an authorization window longer than 10 min — a rogue 402 must not get an
// open-ended EIP-3009 authorization (same class as MCP audit F11). Floor keeps a sane minimum.
const MAX_AUTH_WINDOW_S = 600;
const MIN_AUTH_WINDOW_S = 30;
// Update notice. Every request says which client it is (`true402-<id>/<version>`); when a newer
// release exists, true402 answers with `X-True402-Client-Latest` and `X-True402-Client-Update`
// (`recommended` | `required`), and we print ONE line, once per process, on stderr.
//
// The message is built HERE, from this package's own name and install command. Only a strictly
// validated version number is taken from the response — `baseUrl` can point at any seller, and
// printing a server's free text would let a hostile one tell the user to install something else.
const USER_AGENT = `true402-${CLIENT.id}/${CLIENT.version} (+https://true402.dev/integrations)`;
let updateNoticeShown = false;

const DEFAULT_ORIGIN = 'https://true402.dev/api';
const isTrue402 = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return host === 'true402.dev' || host.endsWith('.true402.dev');
  } catch {
    return false;
  }
};

const isNewer = (a: string, b: string): boolean => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/** The line to print for this response, or null. Exported for `src/published-clients.test.ts`. */
export function updateNotice(res: Response, fromUrl: string = DEFAULT_ORIGIN): string | null {
  // Only true402 itself may say we are out of date. Any other seller could otherwise make this
  // client print a fake "security fix pending" — it could not change what gets installed (that
  // command is ours), but it could alarm the user.
  if (!isTrue402(fromUrl)) return null;
  // Never throws: a notice must not be able to break a paid call (or a stub without headers).
  let latest = '';
  let required = false;
  try {
    latest = res.headers.get('x-true402-client-latest')?.trim() ?? '';
    required = res.headers.get('x-true402-client-update') === 'required';
  } catch {
    return null;
  }
  if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(latest) || !isNewer(latest, CLIENT.version)) return null;
  return required
    ? `[true402] ${CLIENT.package} ${CLIENT.version} has a security fix pending — update to ${latest}: ${CLIENT.install}`
    : `[true402] ${CLIENT.package} ${latest} is available (you have ${CLIENT.version}): ${CLIENT.install}`;
}

function noteUpdate(res: Response, fromUrl: string): void {
  if (updateNoticeShown) return;
  const line = updateNotice(res, fromUrl);
  if (!line) return;
  updateNoticeShown = true;
  console.warn(line);
}

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
 * Parse the auto-pay ceiling FAIL-CLOSED: unset/empty → the $0.25 default; a non-numeric,
 * negative, or non-finite value → 0 = refuse ALL auto-pay (never silently unlimited).
 *
 * $0.25 is deliberately ABOVE the server's own per-request ceiling (MAX_REQUEST_PRICE_USD,
 * currently $0.20 in production) — a legitimately-priced stall can never be blocked by this
 * default, while an out-of-catalog demand still is. The prior $0.10 default was silently below
 * the catalog's own top price (keyword-volume, $0.15 — every call would have been refused) and had
 * zero headroom against the next one up (backlinks, $0.10 exactly — a one-cent price rise would
 * have killed it the same silent way).
 */
export function parseMaxPaymentUsdc(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === '') return 0.25;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** Run token-report for a Base token over x402, paying with the given Base wallet. */
export interface PayOpts {
  payerPrivateKey: string;
  baseUrl?: string;
  rpcUrl?: string;
  maxAmountUsd?: number;
  /** Test seam: override the on-chain USDC balance read. */
  readBalance?: (owner: `0x${string}`) => Promise<bigint>;
}

/**
 * Pay any true402 stall. `payTokenReport` delegates here and keeps its original signature, so the
 * published API is unchanged — the generalisation exists only so a second action does not have to
 * duplicate the payment flow, and with it every one of the safety checks below.
 */
/**
 * The server's own words, appended to a client error.
 *
 * Every true402 error body is `{"error":{"type":"...","message":"..."}}` — "price_limit_exceeded:
 * Request price $0.24 exceeds the per-request limit of $0.2", or a 503 `<stall>_unavailable`. Without
 * it a caller sees only "got 400" and cannot tell a fixable problem (raise the cap, fix the input)
 * from an outage, so a sale that was one edit away is abandoned. Reading is best-effort and capped:
 * a body that will not read must never mask the failure we are already reporting.
 */
async function serverReason(res: Response): Promise<string> {
  try {
    const text = (await res.text()).trim();
    return text ? ` — ${text.slice(0, 300)}` : '';
  } catch {
    return '';
  }
}

/**
 * May a signed payment be sent to this URL? https, or plain http to THIS machine for development.
 *
 * Decided on the PARSED hostname: the prefix regex this replaced also accepted
 * `http://localhost:x@evil.example/` — userinfo first, then the real host — and sent the payment there
 * in cleartext.
 */
function isSecureUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

/**
 * Redirects are never followed. fetch re-sends a 307/308 with the same method, body AND headers —
 * PAYMENT-SIGNATURE included — to wherever `Location` points, https to http included, so following
 * one would hand a signed, claimable authorization to a host this client never vetted. Both requests
 * use `redirect: 'manual'` and any 3xx is an error.
 */
function refuseRedirect(res: Response, url: string): void {
  if (String(res.type) === 'opaqueredirect' || (res.status >= 300 && res.status < 400))
    throw new Error(`${url} answered HTTP ${res.status}: server redirected; refusing to send a payment elsewhere`);
}

export async function payStall<T>(path: string, payload: Record<string, unknown>, opts: PayOpts): Promise<T> {
  const baseUrl = opts.baseUrl ?? 'https://true402.dev/api';
  const rpcUrl = opts.rpcUrl ?? 'https://mainnet.base.org';
  const key = (opts.payerPrivateKey.startsWith('0x') ? opts.payerPrivateKey : `0x${opts.payerPrivateKey}`) as Hex;
  const account = privateKeyToAccount(key);
  const url = `${baseUrl}${path}`;
  const body = JSON.stringify(payload);

  const first = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  noteUpdate(first, url);
  refuseRedirect(first, url);
  // Any 2xx is a served response (the free trial answers 200 without payment); the gate settles on
  // 2xx too, so these two checks must agree on what "served" means.
  if (first.ok) return (await first.json()) as T;
  if (first.status !== 402) throw new Error(`expected HTTP 402, got ${first.status}${await serverReason(first)}`);

  const challenge = (await first.json()) as { accepts?: Accept[] };
  /**
   * The rail we can actually pay.
   *
   * true402 quotes MORE THAN ONE rail and both carry `scheme: "exact"` — EVM and Solana. Matching on
   * scheme alone returns whatever the server listed FIRST, which works only because the server
   * deliberately keeps EVM at `accepts[0]`. That invariant is maintained in a different codebase from
   * this published client, and a copy already installed in the field cannot be hot-fixed if it moves.
   *
   * The network is REQUIRED: an entry that does not name its chain is not one this client can pay.
   */
  const req = (challenge.accepts ?? []).find((a) => a.scheme === 'exact' && a.network === BASE_NETWORK);
  if (!req)
    throw new Error(
      `no payable x402 requirement in the 402 — this client settles USDC on ${BASE_NETWORK} only`,
    );

  // Only sign a USDC-on-Base charge within the caller's cap — a rogue/compromised endpoint can't make
  // the agent authorize an unexpected asset/network, an excessive amount, or a zero/garbage amount.
  if (req.network !== BASE_NETWORK) throw new Error(`unexpected payment network "${req.network}" (expected ${BASE_NETWORK}) — refusing to sign`);
  const usdc = getAddress(req.asset);
  if (usdc !== getAddress(BASE_USDC)) throw new Error(`unexpected payment asset ${usdc} (expected Base USDC) — refusing to sign`);
  const rawAmount = req.amount ?? req.maxAmountRequired;
  if (rawAmount === undefined || !/^\d+$/.test(String(rawAmount)) || BigInt(rawAmount) <= 0n) {
    throw new Error('402 carries no positive payment amount — refusing to sign');
  }
  const value = BigInt(rawAmount);
  const capUsd = opts.maxAmountUsd ?? 0.25;
  const capAtomic = BigInt(Math.round(capUsd * 1e6));
  if (value > capAtomic) throw new Error(`402 demands ${value} USDC base units, over the $${capUsd} cap (maxAmountUsd) — refusing to sign`);

  const readBalance =
    opts.readBalance ??
    (async (owner: `0x${string}`) => {
      const pub = createPublicClient({ chain: base, transport: http(rpcUrl) });
      return (await pub.readContract({ address: usdc, abi: USDC_ABI, functionName: 'balanceOf', args: [owner] })) as bigint;
    });
  // The balance pre-check is ADVISORY: it only turns "you will be refused" into a clear local
  // message. The server verifies the balance itself and charges nothing when it is short, so an RPC
  // that cannot answer (the free public endpoint rate-limits) must not abort a payable call —
  // measured 2026-10-02: a paid call died on a 429 from mainnet.base.org with a raw viem error.
  const held = await readBalance(account.address).catch(() => null);
  if (held !== null && held < value) throw new Error(`payer ${account.address} holds ${held} < ${value} USDC base units — fund it`);

  // Never send a signed payment over cleartext: an on-path observer could lift the authorization
  // and race it to settlement. Localhost is allowed for development.
  if (!isSecureUrl(url)) {
    throw new Error(`refusing to send a signed payment over cleartext (${url}) — use https`);
  }
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
    x402Version: 2, accepted: req,
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
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, 'PAYMENT-SIGNATURE': xPayment },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(PAID_TIMEOUT_MS),
  });
  noteUpdate(paid, url);
  refuseRedirect(paid, url);
  if (!paid.ok)
    throw new Error(
      `paid request failed (HTTP ${paid.status}): the server reported failure — a seller following ` +
        `x402 settles only on a 2xx${await serverReason(paid)}`,
    );
  return (await paid.json()) as T;
}

/**
 * Composite rug/honeypot report for a Base ERC-20. Unchanged signature — this is the published entry
 * point the plugin has always exposed; it now just names the path for `payStall`.
 */
export function payTokenReport(token: string, opts: PayOpts): Promise<TokenReport> {
  return payStall<TokenReport>('/v1/base/token-report', { token }, opts);
}

/** Everything the true402 archive has observed happen to one Base token's liquidity. */
export interface LiquidityHistory {
  token: string;
  indexed: boolean;
  removals: { count: number; totalQuoteRemoved: number; distinctPools: number; eventsTruncated: boolean };
  linkedTokens: { token: string; txHash: string; block: number }[];
  coverage: { removalsIndexedFromBlock: number | null; removalsIndexedToBlock: number | null; complete: boolean; note: string };
  verdict: string;
}

export function payLiquidityHistory(token: string, opts: PayOpts, limit?: number): Promise<LiquidityHistory> {
  return payStall<LiquidityHistory>('/v1/base/liquidity-history', { token, ...(limit !== undefined ? { limit } : {}) }, opts);
}

/**
 * A domain's crawled backlink profile — the one SEO signal that can't be computed from a page fetch.
 *
 * A discriminated union, not one interface with optional fields: the server settles payment on a 2xx
 * even when its index holds nothing for the domain, and that response carries ONLY
 * `{ target, observed: false, note }` — every other field is genuinely absent, not zero. Modelling it
 * this way makes `r.backlinks` etc. a compile error unless `r.observed` has first been narrowed to
 * `true`, so a formatter can no longer reach into an absent field on the no-data branch.
 */
export type BacklinksResult =
  | {
      target: string;
      observed: true;
      rank: number;
      backlinks: number;
      referringDomains: number;
      referringMainDomains: number;
      referringPages: number;
      dofollow: { referringDomains: number; referringMainDomains: number; referringPages: number };
      spamScore: number;
      brokenBacklinks: number;
      firstSeen: string | null;
      composition: { tld: Record<string, number>; linkTypes: Record<string, number>; attributes: Record<string, number>; countries: Record<string, number> };
      limits: string[];
    }
  | { target: string; observed: false; note: string };

export function payBacklinks(target: string, opts: PayOpts): Promise<BacklinksResult> {
  return payStall<BacklinksResult>('/v1/backlinks', { target }, opts);
}

/** Google Ads search volume/CPC/competition for a batch of keywords — priced per CALL, not per keyword. */
export interface KeywordVolumeResult {
  // Every field but `keyword` is genuinely absent on the wire (not present-with-`undefined` — that
  // value never survives JSON.stringify) whenever the upstream had no data for that specific term,
  // even inside an `observed:true` 200 that has already settled payment: `src/seo/keywordVolume.ts`
  // returns `{ keyword, searchVolume: undefined }` alone for such a row, dropping cpc/competition/
  // competitionIndex/bidLow/bidHigh/trend entirely. This is a PER-ITEM gap, not the top-level
  // observed:false case (keyword-volume has no such top-level case at all).
  keywords: {
    keyword: string;
    searchVolume?: number;
    cpc?: number;
    competition?: string;
    competitionIndex?: number;
    bidLow?: number;
    bidHigh?: number;
    trend?: { year: number; month: number; volume: number }[];
  }[];
  requested: number;
  returned: number;
  location: number;
  language: string;
  limits: string[];
}

export function payKeywordVolume(keywords: string[], opts: PayOpts, location?: number, language?: string): Promise<KeywordVolumeResult> {
  return payStall<KeywordVolumeResult>(
    '/v1/keyword-volume',
    { keywords, ...(location !== undefined ? { location } : {}), ...(language !== undefined ? { language } : {}) },
    opts,
  );
}

/**
 * Which keywords a domain already ranks for in organic search, with position and the ranking URL.
 *
 * Discriminated union — see `BacklinksResult` for why. `location`/`language` echo the request and are
 * always present; `totalRanked`/`returned`/`keywords`/`limits` are genuinely absent on a no-data 2xx.
 */
export type RankedKeywordsResult =
  | {
      target: string;
      observed: true;
      totalRanked: number;
      returned: number;
      // `toKeyword()` in `src/seo/rankedKeywords.ts` always returns all seven keys, but each is
      // individually `T | undefined` — and JSON.stringify drops an `undefined`-valued key, so on the
      // wire that means genuinely absent, not the string "undefined". This can happen on ANY row of
      // an `observed:true`, `returned>0` 200 that has already settled payment. `competition` here is
      // a 0–1 float (`num(keywordInfo.competition)`), NOT the LOW/MEDIUM/HIGH string keyword-volume's
      // sibling field uses — the two labs-derived endpoints (this one and keyword-ideas) share that
      // numeric shape, and only keyword-volume's Google-Ads field is the string.
      keywords: { keyword?: string; searchVolume?: number; cpc?: number; competition?: number; position?: number; url?: string; title?: string }[];
      location: number;
      language: string;
      limits: string[];
    }
  | { target: string; observed: false; location: number; language: string; note: string };

export function payRankedKeywords(
  target: string,
  opts: PayOpts,
  limit?: number,
  location?: number,
  language?: string,
): Promise<RankedKeywordsResult> {
  return payStall<RankedKeywordsResult>(
    '/v1/ranked-keywords',
    {
      target,
      ...(limit !== undefined ? { limit } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(language !== undefined ? { language } : {}),
    },
    opts,
  );
}

/**
 * Related / long-tail keyword ideas for a seed term — measured search data, not model-invented guesses.
 *
 * Discriminated union — see `BacklinksResult` for why. `location`/`language` echo the request and are
 * always present; `totalAvailable`/`returned`/`ideas`/`limits` are genuinely absent on a no-data 2xx.
 */
export type KeywordIdeasResult =
  | {
      seed: string;
      observed: true;
      totalAvailable: number;
      returned: number;
      // Same per-item absence as ranked-keywords (see its comment above): every field but the
      // presence of the row itself can be missing on a settled `observed:true` 200, and
      // `competition` is the same 0–1 numeric shape, not keyword-volume's LOW/MEDIUM/HIGH string.
      ideas: { keyword?: string; searchVolume?: number; cpc?: number; competition?: number; intent?: string }[];
      location: number;
      language: string;
      limits: string[];
    }
  | { seed: string; observed: false; location: number; language: string; note: string };

export function payKeywordIdeas(
  seed: string,
  opts: PayOpts,
  limit?: number,
  location?: number,
  language?: string,
): Promise<KeywordIdeasResult> {
  return payStall<KeywordIdeasResult>(
    '/v1/keyword-ideas',
    {
      seed,
      ...(limit !== undefined ? { limit } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(language !== undefined ? { language } : {}),
    },
    opts,
  );
}
