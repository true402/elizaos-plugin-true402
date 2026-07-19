# elizaos-plugin-true402

[![npm version](https://img.shields.io/npm/v/elizaos-plugin-true402)](https://www.npmjs.com/package/elizaos-plugin-true402) &nbsp; **Stable · production-ready** — semver-stable public API (v1.0).

A pre-trade **rug/honeypot guard** for ElizaOS agents. Before your agent buys a Base ERC-20, it asks
**true402** whether the token can actually be *sold* — an on-chain buy/sell simulation (state-override),
plus liquidity and ownership — and gets back an `avoid | caution | ok` verdict.

Pay-per-call over **x402** (~$0.01 USDC on Base). No account, no API key, no KYC — the agent's wallet is
the auth. That's the edge over static-heuristic checkers: a honeypot can lie to a scanner, not to a
simulation.

## Install

```bash
npm i elizaos-plugin-true402
```

Add it to your character/agent and set the secret (a Base wallet holding a little USDC — gas is sponsored
by the facilitator, so it only needs USDC):

```jsonc
{
  "plugins": ["elizaos-plugin-true402"],
  "settings": {
    "secrets": { "TRUE402_PAYER_PRIVATE_KEY": "0x…" }
  }
}
```

## Configuration

- `TRUE402_PAYER_PRIVATE_KEY` — Base wallet private key (holds a little USDC) used to pay per check.
- `TRUE402_MAX_PAYMENT_USDC` — max USDC auto-paid per call (default `0.10`). Fail-closed:
  an invalid value disables auto-pay entirely rather than becoming unlimited.
- `TRUE402_BASE_URL` — override the true402 API base (default `https://true402.dev/api`).

## What it adds

One action, `CHECK_TOKEN_SAFETY` (similes: `RUG_CHECK`, `HONEYPOT_CHECK`, `CAN_I_SELL_THIS`). It fires
whenever a message contains a Base token address, runs `token-report` over x402, and replies with the
verdict + reasons, e.g.:

```
🛑 AVOID — 0x0d17c72e71e0431160fb633893e20b2ae1a395aa
structural safety 0/100
• no tradeable WETH/USDC liquidity — effectively untradeable
(true402: on-chain honeypot simulation + liquidity + ownership)
```

Wire it into a trading flow by gating buys on `verdict.rating` (`data.verdict` is returned on the
`ActionResult`).

## Build / publish (from this dir)

```bash
npm i
npm run build          # tsup → dist/ (esm + d.ts)
npm publish            # then list it in the ElizaOS plugin registry
```

Powered by [true402.dev](https://true402.dev) · the same check is available standalone (`examples/rug-guard`)
and as an MCP server (`true402/mcp-server`).

## License

MIT
