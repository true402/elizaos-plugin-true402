import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./x402', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./x402')>();
  return { ...actual, payTokenReport: vi.fn() };
});
import { payTokenReport } from './x402';
import { checkTokenSafetyAction, true402Plugin } from './index';

const TEST_ADDR = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed';
const OK = { token: TEST_ADDR, verdict: { rating: 'ok' as const, score: 90, reasons: [] } };

function runtime(settings: Record<string, string | undefined> = { TRUE402_PAYER_PRIVATE_KEY: '0x'.padEnd(66, '1') }) {
  return { getSetting: (k: string) => settings[k] ?? null } as never;
}
const msg = (text: string) => ({ content: { text } }) as never;

// Block body (no implicit return) is required here: an arrow function with an expression
// body would implicitly `return` the mock stub (mockResolvedValue returns the stub itself
// for chaining, and a mock fn is a `function`). Vitest's runner treats any function returned
// from a beforeEach as a post-test cleanup callback and auto-invokes it — which would call
// payTokenReport() a second time, unawaited by any test, using whatever implementation the
// test itself installed later (e.g. mockRejectedValue in the "payment failure" test below).
// That produces a real unhandled rejection attributed to the test, independent of the
// handler's own (correct) try/catch. See git history for the failure this caused.
beforeEach(() => {
  vi.mocked(payTokenReport).mockReset().mockResolvedValue(OK);
});

describe('v2 surface', () => {
  it('declares planner parameters + routingHint (additive fields)', () => {
    const a = checkTokenSafetyAction as { parameters?: Array<{ name: string; schema?: { pattern?: string } }>; routingHint?: string };
    expect(a.parameters?.[0]?.name).toBe('token');
    expect(a.parameters?.[0]?.schema?.pattern).toBe('^0x[a-fA-F0-9]{40}$');
    expect(a.routingHint).toMatch(/before/i);
  });
  it('plugin still exports the action', () => {
    expect(true402Plugin.actions?.map((a) => a.name)).toEqual(['CHECK_TOKEN_SAFETY']);
  });
});

describe('token resolution', () => {
  it('prefers the planner-extracted parameter (2.0 path)', async () => {
    const cb = vi.fn();
    const res = await checkTokenSafetyAction.handler(runtime(), msg('check this token please'), undefined,
      { parameters: { token: TEST_ADDR } } as never, cb);
    expect(res).toMatchObject({ success: true });
    expect(vi.mocked(payTokenReport).mock.calls[0][0]).toBe(TEST_ADDR);
  });
  it('falls back to the message-text regex (1.x path)', async () => {
    const cb = vi.fn();
    await checkTokenSafetyAction.handler(runtime(), msg(`should I ape into ${TEST_ADDR}?`), undefined, undefined, cb);
    expect(vi.mocked(payTokenReport).mock.calls[0][0]).toBe(TEST_ADDR);
  });
  it('ignores a malformed planner parameter and falls back to text', async () => {
    await checkTokenSafetyAction.handler(runtime(), msg(`buy ${TEST_ADDR}`), undefined,
      { parameters: { token: 'not-an-address' } } as never, vi.fn());
    expect(vi.mocked(payTokenReport).mock.calls[0][0]).toBe(TEST_ADDR);
  });
  it('fails cleanly when no address anywhere', async () => {
    const cb = vi.fn();
    const res = await checkTokenSafetyAction.handler(runtime(), msg('is this safe?'), undefined, undefined, cb);
    expect(res).toMatchObject({ success: false });
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('No Base token address') }));
  });
});

describe('settings wiring', () => {
  it('fails cleanly without the payer key', async () => {
    const res = await checkTokenSafetyAction.handler(runtime({}), msg(TEST_ADDR), undefined, undefined, vi.fn());
    expect(res).toMatchObject({ success: false });
  });
  it('passes the fail-closed cap from TRUE402_MAX_PAYMENT_USDC', async () => {
    await checkTokenSafetyAction.handler(
      runtime({ TRUE402_PAYER_PRIVATE_KEY: '0x'.padEnd(66, '1'), TRUE402_MAX_PAYMENT_USDC: '0.05' }),
      msg(TEST_ADDR), undefined, undefined, vi.fn());
    expect(vi.mocked(payTokenReport).mock.calls[0][1]).toMatchObject({ maxAmountUsd: 0.05 });
  });
  it('invalid cap → 0 (refuse-all) is forwarded, not defaulted', async () => {
    await checkTokenSafetyAction.handler(
      runtime({ TRUE402_PAYER_PRIVATE_KEY: '0x'.padEnd(66, '1'), TRUE402_MAX_PAYMENT_USDC: 'abc' }),
      msg(TEST_ADDR), undefined, undefined, vi.fn());
    expect(vi.mocked(payTokenReport).mock.calls[0][1]).toMatchObject({ maxAmountUsd: 0 });
  });
});

describe('outcomes', () => {
  it('formats an avoid verdict with reasons', async () => {
    vi.mocked(payTokenReport).mockResolvedValue({ token: TEST_ADDR, verdict: { rating: 'avoid', score: 5, reasons: ['honeypot_sell_blocked'] } });
    const cb = vi.fn();
    await checkTokenSafetyAction.handler(runtime(), msg(TEST_ADDR), undefined, undefined, cb);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('AVOID') }));
  });
  it('payment failure surfaces the reason via the callback', async () => {
    vi.mocked(payTokenReport).mockRejectedValue(new Error('over the $0.05 cap'));
    const cb = vi.fn();
    const res = await checkTokenSafetyAction.handler(runtime(), msg(TEST_ADDR), undefined, undefined, cb);
    expect(res).toMatchObject({ success: false });
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('cap') }));
  });
  it('validate() true only when the text has an address', async () => {
    expect(await checkTokenSafetyAction.validate(runtime(), msg(TEST_ADDR))).toBe(true);
    expect(await checkTokenSafetyAction.validate(runtime(), msg('hello'))).toBe(false);
  });
});
