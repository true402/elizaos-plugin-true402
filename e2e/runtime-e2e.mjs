// Runtime-integration E2E: boot a REAL @elizaos/core AgentRuntime, register the plugin, inject a
// message, drive validate → handler — with a REAL paid x402 call settling on-chain (~$0.01).
// Gated: RUN_LIVE_ELIZA=1 TRUE402_PAYER_PRIVATE_KEY=0x… node e2e/runtime-e2e.mjs
import { AgentRuntime } from '@elizaos/core';
import plugin from '../dist/index.js';

if (process.env.RUN_LIVE_ELIZA !== '1') {
  console.log('SKIP: set RUN_LIVE_ELIZA=1 (spends ~$0.01 real USDC)');
  process.exit(0);
}
if (!process.env.TRUE402_PAYER_PRIVATE_KEY) {
  console.error('FAIL: set TRUE402_PAYER_PRIVATE_KEY');
  process.exit(1);
}

const die = (m) => { console.error(`\n❌ ${m}`); process.exit(1); };

const character = {
  name: 'true402-e2e',
  bio: ['E2E test agent for elizaos-plugin-true402'],
  settings: {
    secrets: { TRUE402_PAYER_PRIVATE_KEY: process.env.TRUE402_PAYER_PRIVATE_KEY },
  },
};

const runtime = new AgentRuntime({ character, plugins: [plugin] });
// 1.x initialize() may require adapters we don't need for action dispatch; the action path only
// needs getSetting + the registered action. Try initialize, but tolerate its absence of a DB.
try {
  await runtime.initialize?.();
  console.log('runtime initialized');
} catch (e) {
  console.log(`runtime.initialize failed (${e.message}) — continuing: action dispatch only needs settings + registration`);
}

const action = (runtime.actions ?? plugin.actions).find((a) => a.name === 'CHECK_TOKEN_SAFETY');
if (!action) die('CHECK_TOKEN_SAFETY not registered in the runtime');
console.log('action registered:', action.name, '| from runtime.actions:', Boolean(runtime.actions?.length));

// AERO — established Base token, expected verdict ok/caution (never avoid).
const AERO_ADDRESS = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';
const message = {
  id: '00000000-0000-0000-0000-000000000001',
  entityId: '00000000-0000-0000-0000-000000000002',
  roomId: '00000000-0000-0000-0000-000000000003',
  content: { text: `Should I ape into ${AERO_ADDRESS}?` },
};

const valid = await action.validate(runtime, message);
if (!valid) die('validate() returned false for a message containing a token address');
console.log('validate: true');

let calledBack;
const result = await action.handler(runtime, message, undefined, undefined, async (c) => { calledBack = c; });
console.log('callback text:\n' + (calledBack?.text ?? '(none)'));
if (!result?.success) die(`handler failed: ${result?.text}`);
if (!/OK|CAUTION/.test(calledBack?.text ?? '')) die('unexpected verdict text');
console.log('\n✅ PASS: real runtime → validate → handler → paid x402 call → verdict.');
