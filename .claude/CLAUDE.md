# friends-forever-bot

## Rules

- Discord interactions over HTTP only, no gateway connection, because a Worker can't hold one open. The app "Friends Forever Bot" (App ID `1560632632063041536`) is private: Public Bot off, Install Link None, guild install only, installed in the Friends Forever server. The global command `/ffbot` comes from `src/command.js`, which the Worker and `npm run register` share.
- Every question runs in the `Ask` Durable Object's alarm. A Worker may only run 30 s after replying, and free models often need longer. The reply is saved before it is sent, so a retried alarm resends it and never asks the model twice. A throw in `deliver` lets Cloudflare retry in a fresh invocation.
- The bot is only an MCP client. wowhead-mcp (at `/forever/mcp`) and wow-armory-mcp run as their own private Workers, reached through the service bindings `WOWHEAD` and `ARMORY`. Never import their code or copy their parsers here. Fix sources in those repos and deploy them. `npm run ask` starts the same servers from GitHub over stdio.
- The armory link and portrait come only from the `Armory:` and `Portrait:` lines of the `character` tool, never from the model.
- The bot answers World of Warcraft questions only, and WoW Forever by default (user, 2026-10-16). The instructions in `src/agent.js` say so, and the MCP servers' own instructions are appended to them.
- Models: Gemini 3.5 Flash Lite, then 3.1 Flash Lite, then 3.5 Flash, on the free tier of the AI Studio project "wow forever discord bot". On 2026-10-16 both Lite models answered 503 "high demand" to most calls while 3.5 Flash kept answering. The 2.5 models are closed to new users, and the newer Flash models were busy too. A round where every model fails gets one retry after 5 s. The user pays for no service, so no paid models, no billing on that project and no paid Cloudflare features.
- Gemini is called through its OpenAI-compatible endpoint. Tool calls go back to the model unchanged, because Gemini 3 needs the thought signature inside them.
- Secrets: `GEMINI_API_KEY` is the only Worker secret, also in the keychain as `friends-forever-bot-gemini`. The bot token is in the keychain as `friends-forever-bot-discord-token`, is only used by `npm run register` and is never stored in the Worker. `DISCORD_PUBLIC_KEY` in `wrangler.jsonc` is public by design. Never write a key into a file.
- Replies go out with `allowed_mentions: { parse: [] }`, so a model can never ping `@everyone`. Every Discord call names the bot in its User-Agent, which Discord requires.
- Free plan limits: the alarms ran with outcome `ok` on 2026-10-16. If `exceededCpu` or "Too many subrequests" shows up in Workers Logs, the 10 ms CPU or the 50 subrequest limit is the cause.

## Checks

- `npm test` runs offline: the signature check, routing, the alarm's delivery rules, the agent loop with model fallback and the reply embed.
- `npm run ask -- "question"` asks one live question. It downloads both MCP servers from GitHub on first use.
- After a deploy, `npx wrangler tail friends-forever-bot` shows each question's models and any failure.

## Deploy

1. Run `npm test`.
2. Run `npx wrangler deploy`. Workers Builds is not connected.
