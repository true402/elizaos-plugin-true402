# elizaos-plugin-true402

[![npm version](https://img.shields.io/npm/v/elizaos-plugin-true402)](https://www.npmjs.com/package/elizaos-plugin-true402) &nbsp; **Stable · production-ready** — semver-stable public API (v1.0).

Pay-per-call **on-chain safety and search/SEO data** for ElizaOS agents, via **true402** over
[x402](https://x402.org). Before your agent buys a Base ERC-20, it asks true402 whether the token can
actually be *sold* — an on-chain buy/sell simulation (state-override), plus liquidity and ownership —
and gets back an `avoid | caution | ok` verdict. The same plugin also gives it backlink profiles and
keyword research, for agents that write, audit, or evaluate content.

Pay-per-call over **x402** (from ~$0.005 USDC on Base). No account, no API key, no KYC — the agent's
wallet is the auth. That's the edge over static-heuristic checkers: a honeypot can lie to a scanner,
not to a simulation.

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
- `TRUE402_MAX_PAYMENT_USDC` — max USDC auto-paid per call (default `0.25`, above the server's own
  $0.20 per-request ceiling so a legitimately-priced stall is never blocked). Fail-closed:
  an invalid value disables auto-pay entirely rather than becoming unlimited.
- `TRUE402_BASE_URL` — override the true402 API base (default `https://true402.dev/api`).

## What it adds

Six actions:

| Action | Similes | What it does | Price |
|---|---|---|---|
| `CHECK_TOKEN_SAFETY` | `RUG_CHECK`, `HONEYPOT_CHECK`, `CAN_I_SELL_THIS` | On-chain buy/sell simulation + liquidity + ownership → `avoid\|caution\|ok` verdict | ~$0.01 |
| `CHECK_LIQUIDITY_HISTORY` | `WAS_IT_RUGGED`, `RUG_HISTORY` | Every liquidity removal true402 has observed on a token, incl. co-drained tokens | ~$0.005 |
| `GET_BACKLINKS` | `BACKLINK_PROFILE`, `DOMAIN_AUTHORITY` | A domain's backlink profile — referring domains/pages, dofollow split, rank, spam score | ~$0.10 |
| `GET_KEYWORD_VOLUME` | `SEARCH_VOLUME`, `KEYWORD_CPC` | Search volume/CPC/competition for up to 200 keywords in **one** call — priced per call, not per keyword | ~$0.15 |
| `GET_RANKED_KEYWORDS` | `ORGANIC_KEYWORDS`, `DOMAIN_RANKINGS` | Keywords a domain already ranks for, with position and the ranking URL | ~$0.05 |
| `GET_KEYWORD_IDEAS` | `RELATED_KEYWORDS`, `LONG_TAIL_KEYWORDS` | Related/long-tail keyword ideas for a seed term, with volume and search intent | ~$0.05 |

`CHECK_TOKEN_SAFETY` fires whenever a message contains a Base token address, runs `token-report` over
x402, and replies with the verdict + reasons, e.g.:

### `CHECK_LIQUIDITY_HISTORY` — what already happened · ~$0.005

A safety check sees the present. This sees the past: every liquidity removal true402 has
observed on the token, with amounts and transaction hashes, plus the other tokens drained in
the **same transaction** — one actor, several pools.

It matters because a live simulation is blind to it: a pool drained last month simulates
perfectly today if someone re-seeded it. The reply carries the block range the index actually
covers, so "none observed" is never relayed to a user as "safe".

```
🛑 AVOID — 0x0d17c72e71e0431160fb633893e20b2ae1a395aa
structural safety 0/100
• no tradeable WETH/USDC liquidity — effectively untradeable
(true402: on-chain honeypot simulation + liquidity + ownership)
```

Wire it into a trading flow by gating buys on `verdict.rating` (`data.verdict` is returned on the
`ActionResult`).

### Search/SEO data — `GET_BACKLINKS`, `GET_KEYWORD_VOLUME`, `GET_RANKED_KEYWORDS`, `GET_KEYWORD_IDEAS`

Four more actions, for agents that write, audit, or evaluate content rather than trade tokens. None of
these have a free trial — they cost real money upstream and are paid from the first call.

- **`GET_BACKLINKS`** — a domain's crawled backlink profile: referring domains and pages, the dofollow
  split that actually carries authority, authority rank, and spam score. The one SEO signal an agent
  can't compute from a page fetch, since it needs a crawled link graph. ~$0.10.
- **`GET_KEYWORD_VOLUME`** — search volume, CPC, competition and 12-month trend for **up to 200
  keywords in one call**. It's priced per call, not per keyword — batch every keyword you need into a
  single request; looping one keyword per call buys the identical data for up to 200x the money. ~$0.15.
- **`GET_RANKED_KEYWORDS`** — which keywords a domain already ranks for in organic search, with
  position and the exact ranking URL. Works on any domain, so it doubles as competitor research. ~$0.05.
- **`GET_KEYWORD_IDEAS`** — related and long-tail keyword ideas for a seed term, each with measured
  search volume and intent, rather than ones a language model invented. ~$0.05.

## Build / publish (from this dir)

```bash
npm i
npm run build          # tsup → dist/ (esm + d.ts)
npm publish            # then list it in the ElizaOS plugin registry
```

Powered by [true402.dev](https://true402.dev) · the same check is available standalone (`examples/rug-guard`)
and as an MCP server (`true402/mcp-server`).

**Checking tokens by hand?** Send any Base token address to [@True402bot](https://t.me/True402bot) on Telegram — same on-chain checks, free, no wallet.

## Guides

- [Add a rug check to an ElizaOS agent](https://true402.dev/guides/add-rug-check-elizaos-agent)
- [Base honeypot checker (free, in the browser)](https://true402.dev/check)
- [The x402 protocol, explained](https://true402.dev/guides/what-is-x402)

## Also available for

MCP (Claude Code / Desktop, Cursor, **Hermes**) · **Hermes Agent** · **OpenClaw** · **ElizaOS** ·
**LangChain** · **CrewAI** · **Vercel AI SDK** · **Coinbase AgentKit** · **Virtuals GAME** · CLI —
same on-chain checks, one install command each:
**[true402.dev/integrations](https://true402.dev/integrations)**

## Paying, exactly

The rules below are the service's, not this package's — they bite whatever client you use, and they
are the ones that surprise people writing their own payer.

- **Pay the EXACT amount quoted in the 402.** Underpaying is rejected. **Overpaying is refused with
  403 and never credited** — settlement submits the signed value and there is no refund path, so a
  surplus would simply be swept. Equality is also what binds an authorization to the resource it was
  quoted for.
- **One authorization buys exactly one response.** A replay is refused, not double-charged.
- **You are charged on success only.** Settlement is submitted only when the endpoint returns 2xx; if
  it errors or times out, your signed authorization is never submitted, so there is nothing to refund.
- Some endpoints serve a few free calls per day per client IP, with no wallet. The per-operation
  description in the [OpenAPI spec](https://true402.dev/api/openapi.json) says which.

Full rules: **[true402.dev/terms](https://true402.dev/terms)** · what is logged and kept:
**[true402.dev/privacy](https://true402.dev/privacy)**

## License

MIT
