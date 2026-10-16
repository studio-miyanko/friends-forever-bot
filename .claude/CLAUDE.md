# friends-forever-bot

## Rules

- `/ffbot` arrives over HTTP interactions. @mention questions need the Gateway, which a Worker can't hold, so the `Gateway` Durable Object keeps one connection (intents GUILDS, GUILD_MESSAGES and GUILD_SCHEDULED_EVENTS, no Message Content intent, because mentions carry their text; a stored session with other intents logs in fresh). The open connection keeps the object on old code after a deploy, so the cron passes `env.VERSION.id` to `ensure()` and an older object calls `ctx.abort()` (user-visible within 15 minutes) and its alarm reconnects every minute if needed (user, 2026-10-16). Only roles in `ASKER_ROLES` get answers. New scheduled events go to `EVENTS_CHANNEL` as their link (user, 2026-10-16). The app "Friends Forever Bot" (App ID `1560632632063041536`) is private: Public Bot off, Install Link None, guild install only, installed in the Friends Forever server. The global command `/ffbot` comes from `src/command.js`, which the Worker and `npm run register` share.
- Every question runs in the `Ask` Durable Object's alarm. A Worker may only run 30 s after replying, and free models often need longer. The reply is saved before it is sent, so a retried alarm resends it and never asks the model twice. A throw in `deliver` lets Cloudflare retry in a fresh invocation.
- The bot is only an MCP client. wowhead-mcp (at `/forever/mcp`) and wow-armory-mcp run as their own private Workers, reached through the service bindings `WOWHEAD` and `ARMORY`. Never import their code or copy their parsers here. Fix sources in those repos and deploy them. `npm run ask` starts the same servers from GitHub over stdio.
- The armory link and portrait come only from the `Armory:` and `Portrait:` lines of the `character` tool, never from the model.
- The bot answers World of Warcraft questions only, and WoW Forever by default (user, 2026-10-16). The instructions in `src/agent.js` say so, and the MCP servers' own instructions are appended to them.
- Models: Gemini 3.5 Flash Lite, then 3.1 Flash Lite, then 3.5 Flash, on the free tier of the AI Studio project "wow forever discord bot". On 2026-10-16 both Lite models answered 503 "high demand" to most calls while 3.5 Flash kept answering. The 2.5 models are closed to new users, and the newer Flash models were busy too. A round where every model fails gets one retry after 5 s. Then `modelChain` falls back to OpenRouter's preset `@preset/free` with `provider.require_parameters`, and the rest of that question stays there, because Gemini 3 rejects tool calls in the history it didn't sign. Tool calls go to OpenRouter without Gemini's extra fields. The user pays for no service, so no paid models, no billing on that project and no paid Cloudflare features.
- Gemini is called through its OpenAI-compatible endpoint. Tool calls go back to the model unchanged, because Gemini 3 needs the thought signature inside them.
- Secrets: the Worker secrets are `GEMINI_API_KEY` (keychain `friends-forever-bot-gemini`) and `OPENROUTER_API_KEY` (keychain `friends-forever-bot-openrouter`, credit limit 0) and the webhook URLs `WOWHEAD_WEBHOOK_URL` and `BLUE_WEBHOOK_URL` (keychain `friends-forever-bot-wowhead-webhook` and `friends-forever-bot-blue-webhook`). The bot token is in the keychain as `friends-forever-bot-discord-token` and, since the mention questions (user, 2026-10-16), the Worker secret `DISCORD_TOKEN`. The bot keeps Administrator, which the server session uses for changes, so treat the token as the server's master key. `DISCORD_PUBLIC_KEY` in `wrangler.jsonc` is public by design. Never write a key into a file.
- Replies are plain messages, not embeds, because embed text is smaller (user, 2026-10-16). The question is a `-#` line and the summary a `###` heading.
- Roster (user, 2026-10-16): `src/roster.js` reads `GET /guilds/{id}/roles/member-counts` (undocumented, works with the bot token, no Server Members intent) and edits the card in #launch, found by its title, only when the text changes.
- News: the cron trigger runs one `NewsFeed` Durable Object per feed in `src/news.js`. Only Forever-tagged or -titled Wowhead items and EU blue forum topics pass (user, 2026-10-16). A feed's first run posts its 3 newest items, later runs post new ones oldest first, at most 10 per run, within the free plan's 50 subrequests. Each object stores the keys it posted, and a blue topic's key includes its title, so an updated topic posts again.
- Replies go out with `allowed_mentions: { parse: [] }`, so a model can never ping `@everyone`. Every Discord call names the bot in its User-Agent, which Discord requires.
- The bot role needs no permissions. Interaction replies only use the bot's own `MENTION_EVERYONE`, `SEND_TTS_MESSAGES` and `USE_EXTERNAL_EMOJIS`, and embeds work without `EMBED_LINKS` (Discord changelog 2022-06-29). So `/ffbot` answers in any channel where members may run it, like the members-only #search.
- Free plan limits: the alarms ran with outcome `ok` on 2026-10-16. If `exceededCpu` or "Too many subrequests" shows up in Workers Logs, the 10 ms CPU or the 50 subrequest limit is the cause.

## Checks

- `npm test` runs offline: the signature check, routing, the alarm's delivery rules, the agent loop with model fallback and the reply embed.
- `npm run ask -- "question"` asks one live question. It downloads both MCP servers from GitHub on first use.
- After a deploy, `npx wrangler tail friends-forever-bot` shows each question's models and any failure.

## Deploy

1. Run `npm test`.
2. Run `npx wrangler deploy`. Workers Builds is not connected.
