import type { Action, Plugin, IAgentRuntime, Memory, State, HandlerCallback, ActionResult } from '@elizaos/core';
import { payTokenReport, parseMaxPaymentUsdc, type Verdict } from './x402';

const ADDR = /0x[a-fA-F0-9]{40}/;
const ADDR_EXACT = /^0x[a-fA-F0-9]{40}$/;

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

export const true402Plugin: Plugin = {
  name: 'true402',
  description:
    'Pre-trade rug/honeypot safety for Base tokens via true402 — pay-per-call over x402 (USDC on Base), ' +
    'no account, no API key. The on-chain buy/sell simulation proves a token is actually sellable before ' +
    'your agent buys it.',
  actions: [checkTokenSafetyAction],
};

export default true402Plugin;
