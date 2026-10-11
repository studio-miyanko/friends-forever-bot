# wow-forever-bot

## Rules

- Discord interactions over HTTP only, no gateway connection, because a Worker can't hold one open.
- Every question runs in the `Ask` Durable Object's alarm. A Worker may only run 30 s after replying, and free models often need longer.
- The tools come from wowhead-mcp's `createServer({ edition: 'forever' })` over `InMemoryTransport`. Never copy its parsers here. Fix sources there and bump the dependency.
- The models stay Gemini 3.5 Flash Lite, then Gemini 3.1 Flash Lite, on the free tier of the AI Studio project "wow forever discord bot" (2026-10-10). Each has its own quota: 15 requests a minute, 500 a day. The user pays for no service, so no paid models, no billing on that project and no paid Cloudflare features.
- Gemini is called through its OpenAI-compatible endpoint. Tool calls go back to the model unchanged, because Gemini 3 needs the thought signature inside them.
- Secrets: `GEMINI_API_KEY` is a Worker secret, also in the keychain as `wow-forever-bot-gemini`. The bot token is only used by `npm run register` and never stored in the Worker. Never write a key into a file.
- Replies go out with `allowed_mentions: { parse: [] }`, so a model can never ping `@everyone`.
- Free plan CPU: tool calls measured 1 to 36 ms on 2026-10-10 and passed, though the limit is 10 ms. If error 1102 (exceeded CPU) shows up in the logs, that limit is the cause.

## Checks

- `npm test` checks the signature check, the agent loop and the reply length. It needs no network.
- `npm run ask -- "question"` asks one live question with `GEMINI_API_KEY` set.

## Deploy

1. Run `npm test`.
2. Run `npx wrangler deploy`. Workers Builds is not connected.
