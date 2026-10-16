# Changelog

## 1.5.0 (2026-10-16)

- A roster card in #launch counts everyone's class and role picks and lists what nobody plays yet. The cron updates it every 15 minutes and only edits it when a count changes.

## 1.4.1 (2026-10-16)

- The Gateway connection restarts itself on new code within 15 minutes of a deploy. Its open connection had kept the old code running, so a new Durable Object class replaced the first one once.

## 1.4.0 (2026-10-16)

- Every new scheduled event is posted to #events as its link, which Discord shows as a card with an Interested button. A connection from before this logs in fresh, since a resumed session keeps its old intents.

## 1.3.0 (2026-10-16)

- Members and admins can ask by mentioning the bot in any chat. A `Gateway` Durable Object holds the connection Discord needs for that, and the answer replaces a "Looking that up…" reply.
- The bot token is now a Worker secret, `DISCORD_TOKEN`, for that connection and those replies.
- Every WoW question counts, including WoW Forever's launch times, news and community, since "news" in the old list of things it refuses made it turn down a launch question. It converts time zones itself.

## 1.2.0 (2026-10-16)

- When all three Gemini models are busy or out of quota, the rest of the question goes to the free models of the OpenRouter preset `free`, if the secret `OPENROUTER_API_KEY` is set.
- OpenRouter gets up to 3 tries, because a busy free model answers "rate-limited upstream" or nothing at all, and each try lets `openrouter/free` pick another model.
- The last step repeats the question, so a small model answers in its language.

## 1.1.0 (2026-10-16)

- Posts WoW Forever news by itself every 15 minutes: Wowhead's Forever articles to #wowhead and EU blue posts from Wowhead's blue tracker to #blue-posts, each item once.
- Replies are plain messages instead of embeds, so they read at full size. The question sits small on top and the summary is a heading. A character answer no longer shows the portrait.

## 1.0.0 (2026-10-16)

- First release as Friends Forever Bot, with the command `/ffbot`, for the Friends Forever Discord server.
- Answers World of Warcraft questions only, and WoW Forever by default, through the wowhead-mcp and wow-armory-mcp servers, which it reaches over MCP as private Workers.
- Every reply is an embed with a one-sentence summary, the details and the sources. A character answer links the official armory page and shows the portrait.
- Falls back from Gemini 3.5 Flash Lite to 3.1 Flash Lite and 3.5 Flash, with one more round when all are busy.
- A reply is saved before it is sent, so a failed delivery is retried without asking the model again.
