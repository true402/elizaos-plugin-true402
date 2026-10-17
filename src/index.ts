import type { Action, Plugin, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import {
  payBacklinks,
  payKeywordIdeas,
  payKeywordVolume,
  payLiquidityHistory,
  payRankedKeywords,
  payTokenReport,
  parseMaxPaymentUsdc,
  type BacklinksResult,
  type KeywordIdeasResult,
  type KeywordVolumeResult,
  type RankedKeywordsResult,
  type Verdict,
} from './x402';

const ADDR = /0x[a-fA-F0-9]{40}/;
const ADDR_EXACT = /^0x[a-fA-F0-9]{40}$/;
// A bare domain, optionally schemed and/or path-suffixed — "target" for backlinks/ranked-keywords.
// Loose on purpose: same idiom as ADDR above, disambiguation is left to the planner, not validate().
const TARGET_RE = /(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/\S*)?/i;
// Trigger phrases used ONLY to strip a lead-in when falling back to the 1.x message-text path —
// the 2.0 planner-extracted parameter is the real input source for these two (see each handler).
const KEYWORD_VOLUME_LEADIN = /\b(?:search|keyword)\s+volume\s+(?:for|of)?\s*/i;
const KEYWORD_IDEAS_LEADIN = /\b(?:keyword\s+ideas?|related\s+keywords?|long-?tail\s+keywords?|keyword\s+suggestions?)\s+(?:for|from|about)?\s*/i;

/**
 * Finding 3: stripping the lead-in used to leave the ENTIRE rest of the message as the "input" —
 * so "Can you get me the search volume for running shoes and hiking boots please" became one
 * keyword of that whole sentence. The server finds nothing, answers 200, and $0.05–0.15 settles for
 * a guess. These two helpers make the 1.x text fallback REFUSE rather than guess: they only accept
 * something that plausibly reads as a keyword/seed term, never a leftover sentence fragment. The
 * 2.0 planner-parameter path is untouched by any of this — it never goes through these helpers.
 */
// "and", a trailing courtesy word, or an embedded request-phrase are strong signals that what's left
// is conversational filler around the real ask, not itself one keyword/seed term.
const SENTENCE_FRAGMENT_RE = /\b(?:and|please|thanks?(?:\s+you)?|for\s+me|could\s+you|would\s+you|can\s+you)\b/i;
const MAX_FALLBACK_TERM_WORDS = 6;

/** Single- or double-quoted substrings in `text`, trimmed, in order, blanks dropped. */
function extractQuoted(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]+)"|'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const v = (m[1] ?? m[2] ?? '').trim();
    if (v) out.push(v);
  }
  return out;
}

/** Is `text` plausibly ONE keyword/seed term, rather than a leftover sentence fragment? */
function looksLikeTerm(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (SENTENCE_FRAGMENT_RE.test(t)) return false;
  return t.split(/\s+/).filter(Boolean).length <= MAX_FALLBACK_TERM_WORDS;
}

/**
 * Extract a plausible keyword LIST from 1.x message text, or undefined to refuse. Accepts quoted
 * terms, an explicit comma-separated list (2+ items — unambiguously intentional), or a single bare
 * phrase that itself looks like a term. Anything else (a sentence fragment) is refused.
 */
function extractFallbackKeywords(text: string): string[] | undefined {
  const quoted = extractQuoted(text);
  if (quoted.length > 0) return quoted;
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) return parts;
  if (parts.length === 1 && looksLikeTerm(parts[0])) return parts;
  return undefined;
}

/** Extract a plausible single seed term from 1.x message text, or undefined to refuse. */
function extractFallbackSeed(text: string): string | undefined {
  const quoted = extractQuoted(text);
  if (quoted.length === 1) return quoted[0].slice(0, 80);
  const plain = text.trim();
  return looksLikeTerm(plain) ? plain.slice(0, 80) : undefined;
}

/**
 * ElizaOS 2.0 planner fields — additive, ignored by 1.x runtimes. Declared locally because
 * @elizaos/core 1.7.2 (our dev pin) doesn't ship these types yet; on 2.0 they match
 * ActionParameter/routingHint and are picked up by the planner's tool conversion.
 */
interface ActionParameter {
  name: string;
  description: string;
  required?: boolean;
  schema?: Record<string, unknown>;
  examples?: string[];
}
type ActionV2 = Action & { parameters?: ActionParameter[]; routingHint?: string };

function format(token: string, v: Verdict): string {
  const tag = v.rating === 'avoid' ? '🛑 AVOID' : v.rating === 'caution' ? '⚠️ CAUTION' : '✅ OK';
  const reasons = v.reasons?.length ? '\n' + v.reasons.map((r) => `• ${r}`).join('\n') : '';
  return `${tag} — ${token}\nstructural safety ${v.score}/100${reasons}\n(true402: on-chain honeypot simulation + liquidity + ownership)`;
}

/**
 * CHECK_TOKEN_SAFETY — before an Eliza agent buys a Base ERC-20, ask true402 whether it can actually be
 * sold (on-chain honeypot simulation + liquidity + ownership). Pay-per-call over x402 (~$0.01 USDC on
 * Base), no API key. Needs the secret TRUE402_PAYER_PRIVATE_KEY (a Base wallet holding a little USDC).
 */
export const checkTokenSafetyAction: ActionV2 = {
  name: 'CHECK_TOKEN_SAFETY',
  similes: ['RUG_CHECK', 'HONEYPOT_CHECK', 'TOKEN_SAFETY', 'IS_THIS_A_RUG', 'CAN_I_SELL_THIS'],
  description:
    'Check a Base ERC-20 for rug/honeypot risk via true402 before trading it. Runs an on-chain buy/sell ' +
    'simulation (proves the token is actually sellable) plus liquidity + ownership, and returns an ' +
    'avoid|caution|ok verdict. Pay-per-call over x402 (~$0.01 USDC, no API key). Use whenever a token ' +
    'address is about to be bought.',
  routingHint:
    'Use before the agent buys, holds, or recommends any Base ERC-20 token, or when asked whether a ' +
    'token is safe, a rug, or sellable. Do not use for price quotes, for chains other than Base, or ' +
    'for a token already vetted in this conversation.',
  parameters: [
    {
      name: 'token',
      description: 'Base ERC-20 contract address to check (0x + 40 hex chars)',
      required: true,
      schema: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
      examples: ['0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed'],
    },
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    ADDR.test(message.content?.text ?? ''),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    // 2.0 planner-extracted parameter first (validated), then the 1.x message-text regex.
    const fromParams = (options as { parameters?: { token?: unknown } } | undefined)?.parameters?.token;
    const token =
      (typeof fromParams === 'string' && ADDR_EXACT.test(fromParams) ? fromParams : undefined) ??
      (message.content?.text ?? '').match(ADDR)?.[0];
    if (!token) {
      const text = 'No Base token address (0x…) found to check.';
      await callback?.({ text });
      return { success: false, text };
    }
    const payerPrivateKey = runtime.getSetting('TRUE402_PAYER_PRIVATE_KEY');
    if (!payerPrivateKey) {
      const text = 'TRUE402_PAYER_PRIVATE_KEY is not configured (a Base wallet holding a little USDC).';
      await callback?.({ text });
      return { success: false, text, error: new Error('missing TRUE402_PAYER_PRIVATE_KEY') };
    }
    const baseUrl = runtime.getSetting('TRUE402_BASE_URL');
    const rawCap = runtime.getSetting('TRUE402_MAX_PAYMENT_USDC');
    const maxAmountUsd = parseMaxPaymentUsdc(rawCap == null ? undefined : String(rawCap));
    try {
      const report = await payTokenReport(token, {
        payerPrivateKey: String(payerPrivateKey),
        baseUrl: baseUrl ? String(baseUrl) : undefined,
        maxAmountUsd,
      });
      const v = report.verdict;
      if (!v) {
        const text = `Could not get a safety verdict for ${token}.`;
        await callback?.({ text });
        return { success: false, text };
      }
      const text = format(token, v);
      await callback?.({ text });
      return { success: true, text, data: { token, verdict: v } };
    } catch (e) {
      const text = `Token safety check failed: ${e instanceof Error ? e.message : String(e)}`;
      await callback?.({ text });
      return { success: false, text, error: e instanceof Error ? e : new Error(String(e)) };
    }
  },
  examples: [[
    { name: '{{user}}', content: { text: 'Should I ape into 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed?' } },
    { name: '{{agent}}', content: { text: 'Let me run an on-chain safety check first.', actions: ['CHECK_TOKEN_SAFETY'] } },
  ]],
};

/**
 * CHECK_LIQUIDITY_HISTORY — the question a safety check cannot answer, because it is about the past.
 * A pool drained last month simulates perfectly today if someone re-seeded it, so an honeypot
 * simulation is blind to it. This reads true402's own archive of observed Base liquidity removals,
 * including the other tokens drained in the SAME transaction (one actor, several pools).
 */
export const checkLiquidityHistoryAction: ActionV2 = {
  name: 'CHECK_LIQUIDITY_HISTORY',
  similes: ['LIQUIDITY_HISTORY', 'WAS_IT_RUGGED', 'HAS_IT_BEEN_DRAINED', 'RUG_HISTORY', 'PAST_RUGS'],
  description:
    "Look up what has ALREADY happened to a Base token's liquidity via true402: every removal event " +
    'observed, with amounts and transaction hashes, plus the other tokens drained in the same ' +
    'transaction. Complements the live safety check, which can only see the present — a re-seeded ' +
    'pool looks healthy today. Pay-per-call over x402 (~$0.005 USDC, no API key).',
  routingHint:
    'Use when asked whether a token has been rugged or drained BEFORE, about its history or track ' +
    'record, or who else is connected to it. For "is it safe to buy right now" use CHECK_TOKEN_SAFETY ' +
    'instead. Both are worth running before a large position.',
  parameters: [
    {
      name: 'token',
      description: 'Base ERC-20 contract address to look up (0x + 40 hex chars)',
      required: true,
      schema: { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' },
      examples: ['0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed'],
    },
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    ADDR.test(message.content?.text ?? ''),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const fromParams = (options as { parameters?: { token?: unknown } } | undefined)?.parameters?.token;
    const token =
      (typeof fromParams === 'string' && ADDR_EXACT.test(fromParams) ? fromParams : undefined) ??
      (message.content?.text ?? '').match(ADDR)?.[0];
    if (!token) {
      const text = 'No Base token address (0x…) found to look up.';
      await callback?.({ text });
      return { success: false, text };
    }
    const payerPrivateKey = runtime.getSetting('TRUE402_PAYER_PRIVATE_KEY');
    if (!payerPrivateKey) {
      const text = 'TRUE402_PAYER_PRIVATE_KEY is not configured (a Base wallet holding a little USDC).';
      await callback?.({ text });
      return { success: false, text, error: new Error('missing TRUE402_PAYER_PRIVATE_KEY') };
    }
    const baseUrl = runtime.getSetting('TRUE402_BASE_URL');
    const rawCap = runtime.getSetting('TRUE402_MAX_PAYMENT_USDC');
    const maxAmountUsd = parseMaxPaymentUsdc(rawCap == null ? undefined : String(rawCap));
    try {
      const h = await payLiquidityHistory(token, {
        payerPrivateKey: String(payerPrivateKey),
        baseUrl: baseUrl ? String(baseUrl) : undefined,
        maxAmountUsd,
      });
      // Report the coverage window with the answer. An absence of removals inside a partial index is
      // not a clean record, and an agent relaying this to a user must not imply that it is.
      const linked = h.linkedTokens?.length ?? 0;
      const text =
        `${token}: ${h.verdict}` +
        (linked > 0 ? ` ${linked} other token(s) were drained in the same transaction(s).` : '') +
        (h.coverage?.complete === false ? ' Note: the removal index is partial — absence is not proof.' : '');
      await callback?.({ text });
      return { success: true, text, data: { token, removals: h.removals, linkedTokens: h.linkedTokens, coverage: h.coverage } };
    } catch (e) {
      const text = `Liquidity-history lookup failed: ${e instanceof Error ? e.message : String(e)}`;
      await callback?.({ text });
      return { success: false, text, error: e instanceof Error ? e : new Error(String(e)) };
    }
  },
  examples: [[
    { name: '{{user}}', content: { text: 'Has 0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed ever been rugged?' } },
    { name: '{{agent}}', content: { text: 'Let me check what true402 has observed happen to its liquidity.', actions: ['CHECK_LIQUIDITY_HISTORY'] } },
  ]],
};

function formatBacklinks(target: string, r: BacklinksResult): string {
  // The server settles payment on a 2xx even when its index holds nothing for this domain (Finding
  // 2) — that response carries ONLY `note`, so this must be checked FIRST. Getting this wrong isn't
  // cosmetic: `r.rank`/`r.dofollow` etc. don't exist on the no-data branch and TS now refuses to
  // compile a reference to them without this narrowing.
  if (r.observed === false) return r.note;
  return (
    `${target}: rank ${r.rank}, ${r.backlinks} backlinks from ${r.referringDomains} referring domains ` +
    `(${r.dofollow.referringDomains} dofollow), spam score ${r.spamScore}, ${r.brokenBacklinks} broken.`
  );
}

/**
 * GET_BACKLINKS — the one SEO signal an agent cannot compute from a page fetch, because it needs a
 * crawled link graph: referring domains and pages, the dofollow split that actually carries
 * authority, authority rank, and spam score.
 */
export const getBacklinksAction: ActionV2 = {
  name: 'GET_BACKLINKS',
  similes: ['BACKLINK_PROFILE', 'LINK_PROFILE', 'REFERRING_DOMAINS', 'DOMAIN_AUTHORITY', 'SEO_BACKLINKS'],
  description:
    "A domain's backlink profile: referring domains and pages, the dofollow split that actually " +
    'carries authority, authority rank and spam score. The one SEO signal an agent cannot compute ' +
    'from a page fetch — it needs a crawled link graph. ~$0.10 USDC over x402.',
  routingHint:
    "Use when asked about a domain's backlink profile, link authority, referring domains, or spam " +
    "score — including a competitor's domain, not just the agent's own. Not for on-page content or " +
    'Base token safety.',
  parameters: [
    {
      name: 'target',
      description: 'A domain, or any URL on it',
      required: true,
      schema: { type: 'string' },
      examples: ['example.com'],
    },
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    TARGET_RE.test(message.content?.text ?? ''),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const fromParams = (options as { parameters?: { target?: unknown } } | undefined)?.parameters?.target;
    const target =
      (typeof fromParams === 'string' && fromParams.trim() ? fromParams.trim() : undefined) ??
      (message.content?.text ?? '').match(TARGET_RE)?.[0];
    if (!target) {
      const text = 'No domain or URL found to look up.';
      await callback?.({ text });
      return { success: false, text };
    }
    const payerPrivateKey = runtime.getSetting('TRUE402_PAYER_PRIVATE_KEY');
    if (!payerPrivateKey) {
      const text = 'TRUE402_PAYER_PRIVATE_KEY is not configured (a Base wallet holding a little USDC).';
      await callback?.({ text });
      return { success: false, text, error: new Error('missing TRUE402_PAYER_PRIVATE_KEY') };
    }
    const baseUrl = runtime.getSetting('TRUE402_BASE_URL');
    const rawCap = runtime.getSetting('TRUE402_MAX_PAYMENT_USDC');
    const maxAmountUsd = parseMaxPaymentUsdc(rawCap == null ? undefined : String(rawCap));
    try {
      const r = await payBacklinks(target, {
        payerPrivateKey: String(payerPrivateKey),
        baseUrl: baseUrl ? String(baseUrl) : undefined,
        maxAmountUsd,
      });
      const text = formatBacklinks(target, r);
      await callback?.({ text });
      return { success: true, text, data: { ...r } };
    } catch (e) {
      const text = `Backlinks lookup failed: ${e instanceof Error ? e.message : String(e)}`;
      await callback?.({ text });
      return { success: false, text, error: e instanceof Error ? e : new Error(String(e)) };
    }
  },
  examples: [[
    { name: '{{user}}', content: { text: "What's the backlink profile for example.com?" } },
    { name: '{{agent}}', content: { text: 'Let me pull its crawled link graph.', actions: ['GET_BACKLINKS'] } },
  ]],
};

function formatKeywordVolume(r: KeywordVolumeResult): string {
  if (r.returned === 0) return `No search-volume data for the ${r.requested} keyword(s) requested.`;
  // A partial batch is the common case, not the exception: the upstream can have data for some
  // requested keywords and not others inside the SAME `observed:true`, `returned>0` 200 — and that
  // 200 has already settled payment. Never interpolate a missing field unconditionally (that used to
  // print literal "undefined" into an already-paid-for answer); fall back to "no data" per row.
  const rows = r.keywords.map((k) => {
    if (k.searchVolume === undefined) return `${k.keyword}: no data`;
    const cpc = k.cpc !== undefined ? `, CPC $${k.cpc}` : '';
    const competition = k.competition !== undefined ? ` (${k.competition})` : '';
    return `${k.keyword}: ${k.searchVolume}/mo${cpc}${competition}`;
  });
  return `${r.returned} of ${r.requested} keyword(s):\n` + rows.map((row) => `• ${row}`).join('\n');
}

/**
 * GET_KEYWORD_VOLUME — search volume, CPC and competition for a BATCH of keywords in one call.
 * Priced per call, not per keyword: up to 200 keywords cost the same as one, so an agent that loops
 * one keyword per call pays up to 200x for identical data.
 */
export const getKeywordVolumeAction: ActionV2 = {
  name: 'GET_KEYWORD_VOLUME',
  similes: ['KEYWORD_VOLUME', 'SEARCH_VOLUME', 'KEYWORD_CPC', 'SEO_KEYWORD_VOLUME'],
  description:
    'Search volume, CPC, competition and 12-month trend for keywords. Priced PER CALL, not per ' +
    'keyword: send up to 200 keywords in ONE call for the same price as one keyword — looping one ' +
    'keyword per call buys identical data for up to 200x the money, so batch the whole list. ' +
    '~$0.15 USDC over x402.',
  routingHint:
    'Use when asked for search volume, CPC, or competition for one or more keywords. Always pass ' +
    'every keyword needed in a single call — never loop this action per keyword, since it is priced ' +
    'per call, not per keyword.',
  parameters: [
    {
      name: 'keywords',
      description: 'Up to 200 keywords to look up in ONE call — priced per call, not per keyword',
      required: true,
      schema: { type: 'array', items: { type: 'string' } },
      examples: ['["running shoes", "trail running shoes"]'],
    },
    { name: 'location', description: 'Location code (default 2840 = US)', required: false, schema: { type: 'number' } },
    { name: 'language', description: 'Language code (default "en")', required: false, schema: { type: 'string' } },
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    KEYWORD_VOLUME_LEADIN.test(message.content?.text ?? ''),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = (options as { parameters?: { keywords?: unknown; location?: unknown; language?: unknown } } | undefined)?.parameters;
    const fromParams = Array.isArray(params?.keywords) && params.keywords.every((k) => typeof k === 'string') && params.keywords.length > 0
      ? (params.keywords as string[])
      : undefined;
    const fromText = extractFallbackKeywords((message.content?.text ?? '').replace(KEYWORD_VOLUME_LEADIN, ''));
    const keywords = fromParams ?? fromText;
    if (!keywords) {
      // Finding 3: never guess. A sentence-shaped remainder is refused here, before the paid call —
      // this stall costs real money and a wrong guess still settles on the server's 2xx "no data".
      const text = 'Could not confidently determine the keyword(s) to look up from the message text — ' +
        'pass them explicitly (the `keywords` parameter), in quotes, or comma-separated.';
      await callback?.({ text });
      return { success: false, text };
    }
    const payerPrivateKey = runtime.getSetting('TRUE402_PAYER_PRIVATE_KEY');
    if (!payerPrivateKey) {
      const text = 'TRUE402_PAYER_PRIVATE_KEY is not configured (a Base wallet holding a little USDC).';
      await callback?.({ text });
      return { success: false, text, error: new Error('missing TRUE402_PAYER_PRIVATE_KEY') };
    }
    const baseUrl = runtime.getSetting('TRUE402_BASE_URL');
    const rawCap = runtime.getSetting('TRUE402_MAX_PAYMENT_USDC');
    const maxAmountUsd = parseMaxPaymentUsdc(rawCap == null ? undefined : String(rawCap));
    const location = typeof params?.location === 'number' ? params.location : undefined;
    const language = typeof params?.language === 'string' ? params.language : undefined;
    try {
      const r = await payKeywordVolume(
        keywords,
        { payerPrivateKey: String(payerPrivateKey), baseUrl: baseUrl ? String(baseUrl) : undefined, maxAmountUsd },
        location,
        language,
      );
      const text = formatKeywordVolume(r);
      await callback?.({ text });
      return { success: true, text, data: { requestedKeywords: keywords, ...r } };
    } catch (e) {
      const text = `Keyword-volume lookup failed: ${e instanceof Error ? e.message : String(e)}`;
      await callback?.({ text });
      return { success: false, text, error: e instanceof Error ? e : new Error(String(e)) };
    }
  },
  examples: [[
    { name: '{{user}}', content: { text: 'search volume for running shoes, trail running shoes' } },
    { name: '{{agent}}', content: { text: 'Pulling volume for both keywords in one call.', actions: ['GET_KEYWORD_VOLUME'] } },
  ]],
};

function formatRankedKeywords(target: string, r: RankedKeywordsResult): string {
  // Same no-data-2xx shape as backlinks (Finding 2) — check FIRST, and surface the server's note
  // rather than let `r.keywords` (absent on this branch) throw after the buyer has already paid.
  if (r.observed === false) return r.note;
  if (r.returned === 0) return `${target}: no ranked keywords observed.`;
  // Every field on a row can be individually absent even though the row itself is present (see the
  // comment on `RankedKeywordsResult.keywords` in x402.ts) — never interpolate one unconditionally.
  const rows = r.keywords.slice(0, 10).map((k) => {
    const keyword = k.keyword ?? '(unknown keyword)';
    const position = k.position !== undefined ? `#${k.position}` : 'unranked';
    const volume = k.searchVolume !== undefined ? `${k.searchVolume}/mo` : 'no volume data';
    const url = k.url ? ` (${k.url})` : '';
    return `${keyword} — ${position}, ${volume}${url}`;
  });
  return `${target}: ranks for ${r.totalRanked} keyword(s), showing ${r.returned}:\n` + rows.map((row) => `• ${row}`).join('\n');
}

/**
 * GET_RANKED_KEYWORDS — which keywords a domain already ranks for in organic search, with position
 * and the exact ranking URL. Works on any domain, so it doubles as competitor research.
 */
export const getRankedKeywordsAction: ActionV2 = {
  name: 'GET_RANKED_KEYWORDS',
  similes: ['RANKED_KEYWORDS', 'ORGANIC_KEYWORDS', 'DOMAIN_RANKINGS', 'SEO_RANKINGS'],
  description:
    'Which keywords a domain already ranks for in organic search, with position and the exact URL ' +
    'that ranks. Works on any domain, so it is competitor research as much as self-audit. ' +
    '~$0.05 USDC over x402.',
  routingHint:
    'Use when asked which keywords a domain ranks for in organic search, or for competitor keyword ' +
    "research. Works on any domain, not just the agent's own — for NEW keyword ideas instead of " +
    'existing rankings, use GET_KEYWORD_IDEAS.',
  parameters: [
    {
      name: 'target',
      description: 'A domain to pull ranked organic keywords for',
      required: true,
      schema: { type: 'string' },
      examples: ['example.com'],
    },
    { name: 'limit', description: 'Max keywords to return (1-200, default 50)', required: false, schema: { type: 'number' } },
    { name: 'location', description: 'Location code (default 2840 = US)', required: false, schema: { type: 'number' } },
    { name: 'language', description: 'Language code (default "en")', required: false, schema: { type: 'string' } },
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    TARGET_RE.test(message.content?.text ?? ''),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = (options as { parameters?: { target?: unknown; limit?: unknown; location?: unknown; language?: unknown } } | undefined)
      ?.parameters;
    const fromParams = typeof params?.target === 'string' && params.target.trim() ? params.target.trim() : undefined;
    const target = fromParams ?? (message.content?.text ?? '').match(TARGET_RE)?.[0];
    if (!target) {
      const text = 'No domain found to look up.';
      await callback?.({ text });
      return { success: false, text };
    }
    const payerPrivateKey = runtime.getSetting('TRUE402_PAYER_PRIVATE_KEY');
    if (!payerPrivateKey) {
      const text = 'TRUE402_PAYER_PRIVATE_KEY is not configured (a Base wallet holding a little USDC).';
      await callback?.({ text });
      return { success: false, text, error: new Error('missing TRUE402_PAYER_PRIVATE_KEY') };
    }
    const baseUrl = runtime.getSetting('TRUE402_BASE_URL');
    const rawCap = runtime.getSetting('TRUE402_MAX_PAYMENT_USDC');
    const maxAmountUsd = parseMaxPaymentUsdc(rawCap == null ? undefined : String(rawCap));
    const limit = typeof params?.limit === 'number' ? params.limit : undefined;
    const location = typeof params?.location === 'number' ? params.location : undefined;
    const language = typeof params?.language === 'string' ? params.language : undefined;
    try {
      const r = await payRankedKeywords(
        target,
        { payerPrivateKey: String(payerPrivateKey), baseUrl: baseUrl ? String(baseUrl) : undefined, maxAmountUsd },
        limit,
        location,
        language,
      );
      const text = formatRankedKeywords(target, r);
      await callback?.({ text });
      return { success: true, text, data: { ...r } };
    } catch (e) {
      const text = `Ranked-keywords lookup failed: ${e instanceof Error ? e.message : String(e)}`;
      await callback?.({ text });
      return { success: false, text, error: e instanceof Error ? e : new Error(String(e)) };
    }
  },
  examples: [[
    { name: '{{user}}', content: { text: 'What keywords does example.com already rank for?' } },
    { name: '{{agent}}', content: { text: 'Checking its organic rankings.', actions: ['GET_RANKED_KEYWORDS'] } },
  ]],
};

function formatKeywordIdeas(seed: string, r: KeywordIdeasResult): string {
  // Same no-data-2xx shape as backlinks (Finding 2) — check FIRST, and surface the server's note
  // rather than let `r.ideas` (absent on this branch) throw after the buyer has already paid.
  if (r.observed === false) return r.note;
  if (r.returned === 0) return `No keyword ideas found for "${seed}".`;
  // Every field on a row can be individually absent even though the row itself is present (see the
  // comment on `KeywordIdeasResult.ideas` in x402.ts) — never interpolate one unconditionally.
  const rows = r.ideas.slice(0, 10).map((i) => {
    const keyword = i.keyword ?? '(unknown keyword)';
    const volume = i.searchVolume !== undefined ? `${i.searchVolume}/mo` : 'no volume data';
    const intent = i.intent ? `, ${i.intent}` : '';
    return `${keyword} — ${volume}${intent}`;
  });
  return `${r.returned} of ${r.totalAvailable} idea(s) for "${seed}":\n` + rows.map((row) => `• ${row}`).join('\n');
}

/**
 * GET_KEYWORD_IDEAS — related and long-tail keyword ideas for a seed term, each with measured search
 * volume and intent, rather than ones a language model invented.
 */
export const getKeywordIdeasAction: ActionV2 = {
  name: 'GET_KEYWORD_IDEAS',
  similes: ['KEYWORD_IDEAS', 'RELATED_KEYWORDS', 'KEYWORD_SUGGESTIONS', 'LONG_TAIL_KEYWORDS'],
  description:
    'Related and long-tail keyword ideas for a seed term, each with search volume and search intent ' +
    '— measured candidates rather than ones a language model invented. ~$0.05 USDC over x402.',
  routingHint:
    'Use when asked for related, long-tail, or expansion keyword ideas from a single seed term. ' +
    'Returns measured search data, not invented suggestions — for keywords a domain already ranks ' +
    'for, use GET_RANKED_KEYWORDS instead.',
  parameters: [
    {
      name: 'seed',
      description: 'A seed term (max 80 chars) to generate related/long-tail keyword ideas from',
      required: true,
      schema: { type: 'string', maxLength: 80 },
      examples: ['electric bike'],
    },
    { name: 'limit', description: 'Max ideas to return (1-200, default 50)', required: false, schema: { type: 'number' } },
    { name: 'location', description: 'Location code (default 2840 = US)', required: false, schema: { type: 'number' } },
    { name: 'language', description: 'Language code (default "en")', required: false, schema: { type: 'string' } },
  ],
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> =>
    KEYWORD_IDEAS_LEADIN.test(message.content?.text ?? ''),
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = (options as { parameters?: { seed?: unknown; limit?: unknown; location?: unknown; language?: unknown } } | undefined)
      ?.parameters;
    const fromParams = typeof params?.seed === 'string' && params.seed.trim() ? params.seed.trim().slice(0, 80) : undefined;
    const fromText = extractFallbackSeed((message.content?.text ?? '').replace(KEYWORD_IDEAS_LEADIN, ''));
    const seed = fromParams ?? fromText;
    if (!seed) {
      // Finding 3: never guess. A sentence-shaped remainder is refused here, before the paid call —
      // this stall costs real money and a wrong guess still settles on the server's 2xx "no data".
      const text = 'Could not confidently determine a seed term from the message text — ' +
        'pass it explicitly (the `seed` parameter) or in quotes.';
      await callback?.({ text });
      return { success: false, text };
    }
    const payerPrivateKey = runtime.getSetting('TRUE402_PAYER_PRIVATE_KEY');
    if (!payerPrivateKey) {
      const text = 'TRUE402_PAYER_PRIVATE_KEY is not configured (a Base wallet holding a little USDC).';
      await callback?.({ text });
      return { success: false, text, error: new Error('missing TRUE402_PAYER_PRIVATE_KEY') };
    }
    const baseUrl = runtime.getSetting('TRUE402_BASE_URL');
    const rawCap = runtime.getSetting('TRUE402_MAX_PAYMENT_USDC');
    const maxAmountUsd = parseMaxPaymentUsdc(rawCap == null ? undefined : String(rawCap));
    const limit = typeof params?.limit === 'number' ? params.limit : undefined;
    const location = typeof params?.location === 'number' ? params.location : undefined;
    const language = typeof params?.language === 'string' ? params.language : undefined;
    try {
      const r = await payKeywordIdeas(
        seed,
        { payerPrivateKey: String(payerPrivateKey), baseUrl: baseUrl ? String(baseUrl) : undefined, maxAmountUsd },
        limit,
        location,
        language,
      );
      const text = formatKeywordIdeas(seed, r);
      await callback?.({ text });
      return { success: true, text, data: { ...r } };
    } catch (e) {
      const text = `Keyword-ideas lookup failed: ${e instanceof Error ? e.message : String(e)}`;
      await callback?.({ text });
      return { success: false, text, error: e instanceof Error ? e : new Error(String(e)) };
    }
  },
  examples: [[
    { name: '{{user}}', content: { text: 'keyword ideas for electric bike' } },
    { name: '{{agent}}', content: { text: 'Pulling related and long-tail ideas for that term.', actions: ['GET_KEYWORD_IDEAS'] } },
  ]],
};

export const true402Plugin: Plugin = {
  name: 'true402',
  description:
    'Pay-per-call data for Base agents via true402 — x402 (USDC on Base), no account, no API key. ' +
    'On-chain pre-trade safety: a buy/sell simulation proves a token is actually sellable before your ' +
    'agent buys it, and a liquidity-history lookup shows what has already been done to it, which a ' +
    'live simulation cannot see since a re-seeded pool looks healthy today. Plus search/SEO data: ' +
    "backlink profiles, keyword search volume, a domain's organic rankings, and keyword ideas — " +
    'measured, not language-model-invented.',
  actions: [
    checkTokenSafetyAction,
    checkLiquidityHistoryAction,
    getBacklinksAction,
    getKeywordVolumeAction,
    getRankedKeywordsAction,
    getKeywordIdeasAction,
  ],
};

export default true402Plugin;
