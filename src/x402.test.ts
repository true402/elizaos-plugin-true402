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
  it('defaults to 0.10 when unset/empty', () => {
    expect(parseMaxPaymentUsdc(undefined)).toBe(0.1);
    expect(parseMaxPaymentUsdc(null)).toBe(0.1);
    expect(parseMaxPaymentUsdc('')).toBe(0.1);
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
  it('402 → signs EIP-3009 → retries with X-PAYMENT → returns report', async () => {
    const { calls } = mockFetch();
    const report = await payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, readBalance: funded });
    expect(report.verdict?.rating).toBe('ok');
    expect(calls).toHaveLength(2);
    const hdrs = calls[1].init.headers as Record<string, string>;
    const payload = JSON.parse(Buffer.from(hdrs['X-PAYMENT'], 'base64').toString());
    expect(payload.scheme).toBe('exact');
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

  it('refuses over the default $0.10 cap', async () => {
    mockFetch(challenge({ amount: '200000' })); // $0.20
    await expect(payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, readBalance: funded }))
      .rejects.toThrow(/cap/);
  });

  it('honors a caller-raised cap', async () => {
    mockFetch(challenge({ amount: '200000' }));
    const r = await payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, maxAmountUsd: 0.5, readBalance: funded });
    expect(r.verdict?.rating).toBe('ok');
  });

  it('cap 0 refuses everything (fail-closed wiring)', async () => {
    mockFetch();
    await expect(payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, maxAmountUsd: 0, readBalance: funded }))
      .rejects.toThrow(/cap/);
  });

  it('refuses a non-Base network', async () => {
    mockFetch(challenge({ network: 'eip155:1' }));
    await expect(payTokenReport(TEST_ADDR, { payerPrivateKey: KEY, readBalance: funded }))
      .rejects.toThrow(/unexpected payment network/);
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
    const auth = JSON.parse(Buffer.from(hdrs['X-PAYMENT'], 'base64').toString()).payload.authorization;
    return Number(auth.validBefore) - Math.floor(Date.now() / 1000);
  }
  it('clamps a huge server window to 600s (rogue-402 guard)', async () => {
    expect(await windowFor(999_999)).toBeLessThanOrEqual(601);
  });
  it('floors a tiny server window at 30s', async () => {
    expect(await windowFor(1)).toBeGreaterThanOrEqual(29);
  });
});
