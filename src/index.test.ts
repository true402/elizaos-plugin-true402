import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./x402', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./x402')>();
  return {
    ...actual,
    payTokenReport: vi.fn(),
    payBacklinks: vi.fn(),
    payKeywordVolume: vi.fn(),
    payRankedKeywords: vi.fn(),
    payKeywordIdeas: vi.fn(),
  };
});
import { payTokenReport, payBacklinks, payKeywordVolume, payRankedKeywords, payKeywordIdeas } from './x402';
import {
  checkTokenSafetyAction,
  getBacklinksAction,
  getKeywordVolumeAction,
  getRankedKeywordsAction,
  getKeywordIdeasAction,
  true402Plugin,
} from './index';

const TEST_ADDR = '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed';
const OK = { token: TEST_ADDR, verdict: { rating: 'ok' as const, score: 90, reasons: [] } };
const BACKLINKS_OK = {
  target: 'example.com', observed: true as const, rank: 42, backlinks: 100, referringDomains: 20,
  referringMainDomains: 18, referringPages: 90, dofollow: { referringDomains: 15, referringMainDomains: 14, referringPages: 70 },
  spamScore: 2, brokenBacklinks: 1, firstSeen: '2020-01-01', composition: { tld: {}, linkTypes: {}, attributes: {}, countries: {} },
  limits: [],
};
// The server's real shape for "the index holds nothing" — a 2xx (the buyer is billed) with only
// these fields. observed/note are the ONLY signal available; everything else is genuinely absent,
// not zero. See src/seo/backlinks.ts, rankedKeywords.ts, keywordIdeas.ts on the server.
const BACKLINKS_NO_DATA = {
  target: 'nodata.example', observed: false as const,
  note: 'The index holds no data for this domain. That is not the same as having no backlinks.',
};
const KEYWORD_VOLUME_OK = {
  keywords: [{ keyword: 'running shoes', searchVolume: 1000, cpc: 1.2, competition: 'MEDIUM', competitionIndex: 50, bidLow: 0.5, bidHigh: 2, trend: [] }],
  requested: 1, returned: 1, location: 2840, language: 'en', limits: [],
};
const RANKED_KEYWORDS_OK = {
  target: 'example.com', observed: true as const, totalRanked: 5, returned: 1,
  // `competition` here is the labs-endpoint's 0–1 numeric shape (`num(keywordInfo.competition)` on
  // the server), NOT keyword-volume's Google-Ads LOW/MEDIUM/HIGH string — Finding 3.
  keywords: [{ keyword: 'widgets', searchVolume: 500, cpc: 0.8, competition: 0.2, position: 3, url: 'https://example.com/widgets', title: 'Widgets' }],
  location: 2840, language: 'en', limits: [],
};
const RANKED_KEYWORDS_NO_DATA = {
  target: 'nodata.example', observed: false as const, location: 2840, language: 'en',
  note: 'The index holds no data for ranked keywords on this domain. That is not the same as this domain ranking for nothing.',
};
const KEYWORD_IDEAS_OK = {
  seed: 'electric bike', observed: true as const, totalAvailable: 5, returned: 1,
  // Same numeric shape as ranked-keywords, not keyword-volume's string — Finding 3.
  ideas: [{ keyword: 'electric bike for sale', searchVolume: 300, cpc: 1.5, competition: 0.8, intent: 'transactional' }],
  location: 2840, language: 'en', limits: [],
};
const KEYWORD_IDEAS_NO_DATA = {
  seed: 'zzznodemand', observed: false as const, location: 2840, language: 'en',
  note: 'The index holds no data for this seed. That is not the same as this seed having no search demand.',
};
// Findings 1 & 2: a PARTIAL batch — some rows have data, some don't — inside a single already-paid
// `observed:true`/`returned>0` 200. This is the common case (`runKeywordVolume` keeps every requested
// keyword in `keywords[]` and only marks the missing ones with an absent `searchVolume`), not the
// top-level no-data case above. `keywords`/`ideas` deliberately omit the undefined-in-JS fields —
// JSON.stringify drops them — to match the true wire shape.
const KEYWORD_VOLUME_PARTIAL = {
  keywords: [
    { keyword: 'running shoes', searchVolume: 1000, cpc: 1.2, competition: 'MEDIUM', competitionIndex: 50, bidLow: 0.5, bidHigh: 2, trend: [] },
    { keyword: 'zzznodemand keyword' },
  ],
  requested: 2, returned: 1, location: 2840, language: 'en', limits: [],
};
const RANKED_KEYWORDS_PARTIAL = {
  target: 'example.com', observed: true as const, totalRanked: 5, returned: 2,
  keywords: [
    { keyword: 'widgets', searchVolume: 500, cpc: 0.8, competition: 0.2, position: 3, url: 'https://example.com/widgets', title: 'Widgets' },
    { competition: 0.5 },
  ],
  location: 2840, language: 'en', limits: [],
};
const KEYWORD_IDEAS_PARTIAL = {
  seed: 'electric bike', observed: true as const, totalAvailable: 5, returned: 2,
  ideas: [
    { keyword: 'electric bike for sale', searchVolume: 300, cpc: 1.5, competition: 0.8, intent: 'transactional' },
    { intent: 'informational' },
  ],
  location: 2840, language: 'en', limits: [],
};

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
  vi.mocked(payBacklinks).mockReset().mockResolvedValue(BACKLINKS_OK);
  vi.mocked(payKeywordVolume).mockReset().mockResolvedValue(KEYWORD_VOLUME_OK);
  vi.mocked(payRankedKeywords).mockReset().mockResolvedValue(RANKED_KEYWORDS_OK);
  vi.mocked(payKeywordIdeas).mockReset().mockResolvedValue(KEYWORD_IDEAS_OK);
});

describe('v2 surface', () => {
  it('declares planner parameters + routingHint (additive fields)', () => {
    const a = checkTokenSafetyAction as { parameters?: Array<{ name: string; schema?: { pattern?: string } }>; routingHint?: string };
    expect(a.parameters?.[0]?.name).toBe('token');
    expect(a.parameters?.[0]?.schema?.pattern).toBe('^0x[a-fA-F0-9]{40}$');
    expect(a.routingHint).toMatch(/before/i);
  });
  it('plugin exports all six actions, in order', () => {
    // Pinned deliberately: the action list is the plugin's public surface, and a rename or a
    // dropped action would break agent configs that reference these names.
    expect(true402Plugin.actions?.map((a) => a.name)).toEqual([
      'CHECK_TOKEN_SAFETY',
      'CHECK_LIQUIDITY_HISTORY',
      'GET_BACKLINKS',
      'GET_KEYWORD_VOLUME',
      'GET_RANKED_KEYWORDS',
      'GET_KEYWORD_IDEAS',
    ]);
  });

  it('the history action is shaped like the safety one', () => {
    const a = true402Plugin.actions?.find((x) => x.name === 'CHECK_LIQUIDITY_HISTORY') as typeof checkTokenSafetyAction;
    expect(a).toBeDefined();
    expect(a.parameters?.[0]?.name).toBe('token');
    expect(a.parameters?.[0]?.schema?.pattern).toBe('^0x[a-fA-F0-9]{40}$');
    // The two must be distinguishable to a planner, or it will pick whichever comes first.
    expect(a.routingHint).toMatch(/before|history|record/i);
    expect(a.description).not.toBe(checkTokenSafetyAction.description);
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

// Every description below must end with the price, and none may mention a free trial — these four
// stalls cost real money upstream and are paid from the first call (unlike the on-chain checks above).
describe('search/SEO actions — descriptions', () => {
  it.each([
    [getBacklinksAction, '~$0.10 USDC over x402.'],
    [getKeywordVolumeAction, '~$0.15 USDC over x402.'],
    [getRankedKeywordsAction, '~$0.05 USDC over x402.'],
    [getKeywordIdeasAction, '~$0.05 USDC over x402.'],
  ] as const)('%s ends with its price and has no free-trial claim', (action, price) => {
    expect(action.description.endsWith(price)).toBe(true);
    expect(action.description.toLowerCase()).not.toMatch(/free trial|free calls?/);
  });
});

describe('GET_BACKLINKS', () => {
  it('validate() true only when the text has a domain', async () => {
    expect(await getBacklinksAction.validate(runtime(), msg('backlinks for example.com'))).toBe(true);
    expect(await getBacklinksAction.validate(runtime(), msg('hello'))).toBe(false);
  });
  it('prefers the planner-extracted parameter', async () => {
    await getBacklinksAction.handler(runtime(), msg('irrelevant'), undefined, { parameters: { target: 'example.com' } } as never, vi.fn());
    expect(vi.mocked(payBacklinks).mock.calls[0][0]).toBe('example.com');
  });
  it('falls back to the message-text regex', async () => {
    await getBacklinksAction.handler(runtime(), msg('what is the backlink profile for example.com?'), undefined, undefined, vi.fn());
    expect(vi.mocked(payBacklinks).mock.calls[0][0]).toBe('example.com');
  });
  it('fails cleanly with no domain anywhere', async () => {
    const res = await getBacklinksAction.handler(runtime(), msg('tell me about backlinks'), undefined, undefined, vi.fn());
    expect(res).toMatchObject({ success: false });
  });
  it('formats the result with rank and dofollow split', async () => {
    const cb = vi.fn();
    await getBacklinksAction.handler(runtime(), msg('example.com'), undefined, undefined, cb);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('rank 42') }));
  });
  // Finding 2: the server answers 2xx (payment already settled) with observed:false and none of the
  // other fields when it holds no data. Must surface the server's note, not throw / not print
  // "undefined". A thrown formatter here means: buyer pays, then is told the call FAILED.
  it('a no-data (observed:false) result reports the server note, not a crash — the buyer already paid', async () => {
    vi.mocked(payBacklinks).mockResolvedValue(BACKLINKS_NO_DATA);
    const cb = vi.fn();
    const res = await getBacklinksAction.handler(runtime(), msg('nodata.example'), undefined, undefined, cb);
    expect(res).toMatchObject({ success: true });
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ text: BACKLINKS_NO_DATA.note }));
  });
});

describe('GET_KEYWORD_VOLUME', () => {
  it('validate() requires the search/keyword-volume trigger phrase', async () => {
    expect(await getKeywordVolumeAction.validate(runtime(), msg('search volume for running shoes'))).toBe(true);
    expect(await getKeywordVolumeAction.validate(runtime(), msg('example.com'))).toBe(false);
  });
  it('prefers the planner-extracted keywords array', async () => {
    await getKeywordVolumeAction.handler(runtime(), msg('irrelevant'), undefined,
      { parameters: { keywords: ['running shoes', 'trail running shoes'] } } as never, vi.fn());
    expect(vi.mocked(payKeywordVolume).mock.calls[0][0]).toEqual(['running shoes', 'trail running shoes']);
  });
  it('falls back to a comma-split of the message text', async () => {
    await getKeywordVolumeAction.handler(runtime(), msg('search volume for running shoes, trail running shoes'), undefined, undefined, vi.fn());
    expect(vi.mocked(payKeywordVolume).mock.calls[0][0]).toEqual(['running shoes', 'trail running shoes']);
  });
  it('fails cleanly with no keywords anywhere', async () => {
    const res = await getKeywordVolumeAction.handler(runtime(), msg('search volume for'), undefined, undefined, vi.fn());
    expect(res).toMatchObject({ success: false });
  });
  it('passes location/language through from planner parameters', async () => {
    await getKeywordVolumeAction.handler(runtime(), msg('irrelevant'), undefined,
      { parameters: { keywords: ['widgets'], location: 2826, language: 'fr' } } as never, vi.fn());
    expect(vi.mocked(payKeywordVolume).mock.calls[0]).toEqual([['widgets'], expect.anything(), 2826, 'fr']);
  });
  it('still accepts a single un-listed keyword phrase via text fallback (no regression)', async () => {
    await getKeywordVolumeAction.handler(runtime(), msg('search volume for running shoes'), undefined, undefined, vi.fn());
    expect(vi.mocked(payKeywordVolume).mock.calls[0][0]).toEqual(['running shoes']);
  });
  // Finding 3: the 1.x fallback used to treat the ENTIRE remaining message as one keyword. A full
  // sentence like this became one "keyword" of that whole sentence, the server found nothing for
  // it, answered 200, and $0.15 settled for junk. It must now refuse rather than guess, and must
  // NOT call the paid endpoint at all.
  it('refuses a sentence-shaped fallback instead of paying for a guess', async () => {
    const cb = vi.fn();
    const res = await getKeywordVolumeAction.handler(
      runtime(),
      msg('Can you get me the search volume for running shoes and hiking boots please'),
      undefined,
      undefined,
      cb,
    );
    expect(res).toMatchObject({ success: false });
    expect(vi.mocked(payKeywordVolume)).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('keyword') }));
  });
  // Finding 1: a partial batch — some requested keywords have upstream data, some don't — inside one
  // already-paid `returned>0` 200. The buyer paid for the WHOLE batch; a row with no data must read
  // as "no data", never interpolate the literal string "undefined" into the paid-for answer.
  it('a partial batch never prints literal "undefined" for the rows with no upstream data', async () => {
    vi.mocked(payKeywordVolume).mockResolvedValue(KEYWORD_VOLUME_PARTIAL);
    const cb = vi.fn();
    await getKeywordVolumeAction.handler(runtime(), msg('search volume for running shoes, zzznodemand keyword'), undefined, undefined, cb);
    const text = (cb.mock.calls[0][0] as { text: string }).text;
    expect(text).not.toContain('undefined');
    expect(text).toContain('running shoes: 1000/mo, CPC $1.2 (MEDIUM)');
    expect(text).toContain('zzznodemand keyword: no data');
  });
});

describe('GET_RANKED_KEYWORDS', () => {
  it('prefers the planner-extracted target', async () => {
    await getRankedKeywordsAction.handler(runtime(), msg('irrelevant'), undefined, { parameters: { target: 'example.com' } } as never, vi.fn());
    expect(vi.mocked(payRankedKeywords).mock.calls[0][0]).toBe('example.com');
  });
  it('falls back to the message-text regex', async () => {
    await getRankedKeywordsAction.handler(runtime(), msg('what does example.com rank for?'), undefined, undefined, vi.fn());
    expect(vi.mocked(payRankedKeywords).mock.calls[0][0]).toBe('example.com');
  });
  it('fails cleanly with no domain anywhere', async () => {
    const res = await getRankedKeywordsAction.handler(runtime(), msg('rankings please'), undefined, undefined, vi.fn());
    expect(res).toMatchObject({ success: false });
  });
  it('the two target-based actions are distinguishable to a planner', () => {
    expect(getRankedKeywordsAction.routingHint).not.toBe(getBacklinksAction.routingHint);
    expect(getRankedKeywordsAction.description).not.toBe(getBacklinksAction.description);
  });
  it('a no-data (observed:false) result reports the server note, not a crash — the buyer already paid', async () => {
    vi.mocked(payRankedKeywords).mockResolvedValue(RANKED_KEYWORDS_NO_DATA);
    const cb = vi.fn();
    const res = await getRankedKeywordsAction.handler(runtime(), msg('nodata.example'), undefined, undefined, cb);
    expect(res).toMatchObject({ success: true });
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ text: RANKED_KEYWORDS_NO_DATA.note }));
  });
  // Finding 1/2 (ranked-keywords variant): a row's fields can be individually absent even though the
  // row itself is present, inside an already-paid `observed:true`, `returned>0` 200 — never print
  // literal "undefined" for one.
  it('a row with individually-absent fields never prints literal "undefined"', async () => {
    vi.mocked(payRankedKeywords).mockResolvedValue(RANKED_KEYWORDS_PARTIAL);
    const cb = vi.fn();
    await getRankedKeywordsAction.handler(runtime(), msg('example.com'), undefined, undefined, cb);
    const text = (cb.mock.calls[0][0] as { text: string }).text;
    expect(text).not.toContain('undefined');
    expect(text).toContain('widgets — #3, 500/mo (https://example.com/widgets)');
    expect(text).toContain('(unknown keyword) — unranked, no volume data');
  });
});

describe('GET_KEYWORD_IDEAS', () => {
  it('validate() requires the keyword-ideas trigger phrase', async () => {
    expect(await getKeywordIdeasAction.validate(runtime(), msg('keyword ideas for electric bike'))).toBe(true);
    expect(await getKeywordIdeasAction.validate(runtime(), msg('example.com'))).toBe(false);
  });
  it('prefers the planner-extracted seed', async () => {
    await getKeywordIdeasAction.handler(runtime(), msg('irrelevant'), undefined, { parameters: { seed: 'electric bike' } } as never, vi.fn());
    expect(vi.mocked(payKeywordIdeas).mock.calls[0][0]).toBe('electric bike');
  });
  it('falls back to the message text with the lead-in stripped', async () => {
    await getKeywordIdeasAction.handler(runtime(), msg('keyword ideas for electric bike'), undefined, undefined, vi.fn());
    expect(vi.mocked(payKeywordIdeas).mock.calls[0][0]).toBe('electric bike');
  });
  it('fails cleanly with no seed anywhere', async () => {
    const res = await getKeywordIdeasAction.handler(runtime(), msg('keyword ideas for'), undefined, undefined, vi.fn());
    expect(res).toMatchObject({ success: false });
  });
  it('payment failure surfaces the reason via the callback', async () => {
    vi.mocked(payKeywordIdeas).mockRejectedValue(new Error('over the $0.05 cap'));
    const cb = vi.fn();
    const res = await getKeywordIdeasAction.handler(runtime(), msg('keyword ideas for electric bike'), undefined, undefined, cb);
    expect(res).toMatchObject({ success: false });
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('cap') }));
  });
  it('a no-data (observed:false) result reports the server note, not a crash — the buyer already paid', async () => {
    vi.mocked(payKeywordIdeas).mockResolvedValue(KEYWORD_IDEAS_NO_DATA);
    const cb = vi.fn();
    const res = await getKeywordIdeasAction.handler(runtime(), msg('keyword ideas for zzznodemand'), undefined, undefined, cb);
    expect(res).toMatchObject({ success: true });
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ text: KEYWORD_IDEAS_NO_DATA.note }));
  });
  // Finding 3, same shape as keyword-volume's fallback bug at the sibling handler.
  it('refuses a sentence-shaped fallback instead of paying for a guess', async () => {
    const cb = vi.fn();
    const res = await getKeywordIdeasAction.handler(
      runtime(),
      msg('Can you give me keyword ideas for running shoes and hiking boots please'),
      undefined,
      undefined,
      cb,
    );
    expect(res).toMatchObject({ success: false });
    expect(vi.mocked(payKeywordIdeas)).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('seed') }));
  });
  // Finding 1/2 (keyword-ideas variant): a row's fields can be individually absent even though the
  // row itself is present, inside an already-paid `observed:true`, `returned>0` 200 — never print
  // literal "undefined" for one.
  it('a row with individually-absent fields never prints literal "undefined"', async () => {
    vi.mocked(payKeywordIdeas).mockResolvedValue(KEYWORD_IDEAS_PARTIAL);
    const cb = vi.fn();
    await getKeywordIdeasAction.handler(runtime(), msg('keyword ideas for electric bike'), undefined, undefined, cb);
    const text = (cb.mock.calls[0][0] as { text: string }).text;
    expect(text).not.toContain('undefined');
    expect(text).toContain('electric bike for sale — 300/mo, transactional');
    expect(text).toContain('(unknown keyword) — no volume data, informational');
  });
});
