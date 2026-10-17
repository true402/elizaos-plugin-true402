import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { payTokenReport, parseMaxPaymentUsdc } from './x402';

// Well-known throwaway key (anvil #0) — never funded on mainnet by us.
const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDR = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

function challenge(over: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    accepts: [{
      scheme: 'exact', network: 'eip155:8453', asset: USDC,
      payTo: '0xFe257Ef6Dc89F5b688aC52Ef3eb8648C629fA9C4',
      amount: '10000', maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2' },
      ...over,
    }],
  };
}

/** fetch mock: first call → 402 challenge, second call → 200 report. Records calls. */
function mockFetch(ch: unknown = challenge(), paidStatus = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return new Response(JSON.stringify(ch), { status: 402 });
    }
    return new Response(JSON.stringify({ token: TEST_ADDR, verdict: { rating: 'ok', score: 90, reasons: [] } }), { status: paidStatus });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

const funded = async () => 1_000_000n; // readBalance seam: 1 USDC

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('parseMaxPaymentUsdc — fail-closed', () => {
  it('defaults to 0.25 when unset/empty', () => {
    expect(parseMaxPaymentUsdc(undefined)).toBe(0.25);
    expect(parseMaxPaymentUsdc(null)).toBe(0.25);
    expect(parseMaxPaymentUsdc('')).toBe(0.25);
  });
  it('parses valid numbers', () => {
    expect(parseMaxPaymentUsdc('0.05')).toBe(0.05);
    expect(parseMaxPaymentUsdc('1')).toBe(1);
    expect(parseMaxPaymentUsdc('0')).toBe(0);
  });
  it('refuses ALL auto-pay (0) on garbage — never silently unlimited', () => {
    expect(parseMaxPaymentUsdc('abc')).toBe(0);
    expect(parseMaxPaymentUsdc('-1')).toBe(0);
    expect(parseMaxPaymentUsdc('Infinity')).toBe(0);
    expect(parseMaxPaymentUsdc('NaN')).toBe(0);
    expect(parseMaxPaymentUsdc('0,10')).toBe(0); // comma decimal
  });
});

describe('payTokenReport — happy path', () => {
  it('402 → signs EIP-3009 → retries with PAYMENT-SIGNATURE → returns report', async () => {
    const { calls } = mockFetch();
    const report = await payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, readBalance: funded });
    expect(report.verdict?.rating).toBe('ok');
    expect(calls).toHaveLength(2);
    const hdrs = calls[1].init.headers as Record<string, string>;
    const payload = JSON.parse(Buffer.from(hdrs['PAYMENT-SIGNATURE'], 'base64').toString());
    expect(payload.accepted.scheme).toBe('exact');
    expect(payload.payload.authorization.value).toBe('10000');
    expect(payload.payload.signature).toMatch(/^0x[0-9a-f]+$/i);
  });

  it('passes an abort signal to both fetches (hang guard)', async () => {
    const { calls } = mockFetch();
    await payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, readBalance: funded });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1].init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('payTokenReport — refusals (never sign a bad deal)', () => {
  it('refuses a 402 with no positive amount (malformed → no zero-value signing)', async () => {
    mockFetch(challenge({ amount: undefined, maxAmountRequired: undefined }));
    await expect(payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, readBalance: funded }))
      .rejects.toThrow(/no positive payment amount/);
  });

  it('refuses a non-numeric amount', async () => {
    mockFetch(challenge({ amount: 'lots' }));
    await expect(payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, readBalance: funded }))
      .rejects.toThrow(/no positive payment amount/);
  });

  it('refuses over the default $0.25 cap', async () => {
    mockFetch(challenge({ amount: '300000' })); // $0.30
    await expect(payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, readBalance: funded }))
      .rejects.toThrow(/cap/);
  });

  it('honors a caller-raised cap', async () => {
    mockFetch(challenge({ amount: '300000' })); // $0.30 — over the $0.25 default, under a raised cap
    const r = await payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, maxAmountUsd: 0.5, readBalance: funded });
    expect(r.verdict?.rating).toBe('ok');
  });

  it('cap 0 refuses everything (fail-closed wiring)', async () => {
    mockFetch();
    await expect(payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, maxAmountUsd: 0, readBalance: funded }))
      .rejects.toThrow(/cap/);
  });

  it('refuses a non-Base network — and signs nothing', async () => {
    // Asserts the PROPERTY (no signature leaves the process), not which guard fired. Rail selection
    // now skips a non-Base entry before the network check can reach it, so a message-match here was
    // pinning an implementation detail; "was anything signed?" is what actually protects the wallet.
    const { fn } = mockFetch(challenge({ network: 'eip155:1' }));
    await expect(payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, readBalance: funded })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1); // the 402 probe only — never a paid retry
    const sent = (fn.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(sent['PAYMENT-SIGNATURE']).toBeUndefined();
  });

  it('refuses a non-USDC asset', async () => {
    mockFetch(challenge({ asset: '0x4200000000000000000000000000000000000006' }));
    await expect(payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, readBalance: funded }))
      .rejects.toThrow(/unexpected payment asset/);
  });

  it('refuses when the payer balance is short', async () => {
    mockFetch();
    await expect(payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, readBalance: async () => 1n }))
      .rejects.toThrow(/fund it/);
  });
});

describe('payTokenReport — authorization window clamp', () => {
  async function windowFor(maxTimeoutSeconds: number) {
    const { calls } = mockFetch(challenge({ maxTimeoutSeconds }));
    await payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, readBalance: funded });
    const hdrs = calls[1].init.headers as Record<string, string>;
    const auth = JSON.parse(Buffer.from(hdrs['PAYMENT-SIGNATURE'], 'base64').toString()).payload.authorization;
    return Number(auth.validBefore) - Math.floor(Date.now() / 1000);
  }
  it('clamps a huge server window to 600s (rogue-402 guard)', async () => {
    expect(await windowFor(999_999)).toBeLessThanOrEqual(601);
  });
  it('floors a tiny server window at 30s', async () => {
    expect(await windowFor(1)).toBeGreaterThanOrEqual(29);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A buyer must be told WHY a call failed. The server already says so in the body —
// `{"error":{"type":"price_limit_exceeded","message":"Request price $0.24 exceeds ..."}}`,
// or a 503 `<stall>_unavailable` — and this client used to throw that body away, leaving only
// "expected HTTP 402, got 400". A buyer cannot tell a fixable problem (raise your cap, fix the
// input) from an outage, so they give up on a sale that was one edit away. The sibling Python
// clients have always included the body; these TypeScript ones did not.
// ─────────────────────────────────────────────────────────────────────────────
describe('server error reasons reach the caller', () => {
  const opts = { payerPrivateKey: KEY, readBalance: funded };

  it('surfaces the reason when the first (unpaid) request is not a 402', async () => {
    const body = JSON.stringify({
      error: { type: 'price_limit_exceeded', message: 'Request price $0.24 exceeds the per-request limit of $0.2' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 400 })));
    await expect(payTokenReport(TEST_ADDR, opts)).rejects.toThrow(/price_limit_exceeded/);
    await expect(payTokenReport(TEST_ADDR, opts)).rejects.toThrow(/exceeds the per-request limit/);
  });

  it('surfaces the reason when the PAID request fails', async () => {
    const { fn } = mockFetch();
    fn.mockImplementation(async (_url: string, init: RequestInit) => {
      const paid = Boolean((init.headers as Record<string, string> | undefined)?.['PAYMENT-SIGNATURE']);
      if (!paid) return new Response(JSON.stringify(challenge()), { status: 402 });
      return new Response(JSON.stringify({ error: { type: 'upstream_unavailable', message: 'provider timed out' } }), { status: 503 });
    });
    await expect(payTokenReport(TEST_ADDR, opts)).rejects.toThrow(/upstream_unavailable|provider timed out/);
  });

  it('reports a failed paid request without promising that nothing was charged', async () => {
    const { fn } = mockFetch();
    fn.mockImplementation(async (_url: string, init: RequestInit) => {
      const paid = Boolean((init.headers as Record<string, string> | undefined)?.['PAYMENT-SIGNATURE']);
      if (!paid) return new Response(JSON.stringify(challenge()), { status: 402 });
      return new Response(JSON.stringify({ error: { type: 'render_unavailable' } }), { status: 503 });
    });
    // The client cannot know whether the seller settled — `baseUrl` can be any seller — so it states
    // what the server reported and what x402 specifies, never "you were not charged".
    const err = await payTokenReport(TEST_ADDR, opts).catch((e: Error) => e);
    expect(String(err)).toMatch(/server reported failure/);
    expect(String(err)).toMatch(/settles only on a 2xx/);
    expect(String(err)).not.toMatch(/not charged/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Picking the rail out of `accepts[]`. true402 quotes EVM *and* Solana and BOTH carry
// `scheme: "exact"`, so matching on scheme alone returns whatever the server listed first. It works
// only because the server deliberately keeps EVM at accepts[0] — an invariant maintained in another
// codebase, which this published client cannot be hot-fixed to follow if it ever moves.
// ─────────────────────────────────────────────────────────────────────────────
describe('rail selection — pick the rail we can pay, not the one listed first', () => {
  const opts = { payerPrivateKey: KEY, readBalance: funded };
  const solana = {
    scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    payTo: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', amount: '10000',
  };
  const evm = challenge().accepts[0];

  const withAccepts = (accepts: unknown[]) => {
    const { fn } = mockFetch();
    fn.mockImplementation(async (_url: string, init: RequestInit) => {
      const paid = Boolean((init.headers as Record<string, string> | undefined)?.['PAYMENT-SIGNATURE']);
      if (!paid) return new Response(JSON.stringify({ x402Version: 2, accepts }), { status: 402 });
      return new Response(JSON.stringify({ token: TEST_ADDR, verdict: { rating: 'ok', score: 90, reasons: [] } }), { status: 200 });
    });
    return fn;
  };

  it('pays when the Solana "exact" entry is listed FIRST', async () => {
    const fn = withAccepts([solana, evm]);
    await expect(payTokenReport(TEST_ADDR, opts)).resolves.toBeDefined();
    const hdrs = (fn.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    const payload = JSON.parse(Buffer.from(hdrs['PAYMENT-SIGNATURE'], 'base64').toString());
    expect(payload.accepted.network).toBe('eip155:8453'); // signed for the EVM rail, not Solana
  });

  it('still pays when the EVM entry is first (no behaviour change today)', async () => {
    withAccepts([evm, solana]);
    await expect(payTokenReport(TEST_ADDR, opts)).resolves.toBeDefined();
  });

  it('refuses an entry that omits `network` — the chain must be named to be signed for', async () => {
    const { network: _drop, ...noNetwork } = evm as Record<string, unknown>;
    withAccepts([noNetwork]);
    await expect(payTokenReport(TEST_ADDR, opts)).rejects.toThrow(/no payable x402 requirement/);
  });

  it('refuses when the ONLY exact entry is a rail we cannot pay', async () => {
    withAccepts([solana]);
    await expect(payTokenReport(TEST_ADDR, opts)).rejects.toThrow();
  });
});
