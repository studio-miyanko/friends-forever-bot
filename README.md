# Friends Forever Bot

Discord bot for the Friends Forever server. Type `/ffbot` with a World of Warcraft question, and it looks the answer up on Wowhead and Blizzard's armory. Every reply is a plain message: a one-sentence summary as a heading, then the details and its sources. A character answer links the official armory page from the summary.

Members and admins can also ask by mentioning the bot in any chat, like `@Friends Forever Bot where does Thunderfury drop?`, and it answers right there.

It also posts WoW Forever news on its own: Wowhead's Forever articles to #wowhead and Blizzard's EU blue posts to #blue-posts.

```text
/ffbot question: where does Thunderfury drop?
```

It answers World of Warcraft questions only, and means WoW Forever unless you name another version. It runs on Cloudflare Workers' free plan and Gemini's free tier.

## How it works

1. Discord sends each `/ffbot` to the Worker, which checks Discord's signature and shows "thinking…".
2. A Durable Object alarm takes the question, because one with several lookups can need longer than the 30 seconds a Worker may run after replying.
3. The bot connects to two MCP servers: [wowhead-mcp](https://github.com/studio-miyanko/wowhead-mcp), locked to WoW Forever, and [wow-armory-mcp](https://github.com/studio-miyanko/wow-armory-mcp). They run as their own private Workers, which the bot reaches through service bindings. The bot only speaks MCP to them and holds none of their code.
4. Gemini picks the lookups and writes the answer: 3.5 Flash Lite first, then 3.1 Flash Lite, then 3.5 Flash when the others are busy. When all three fail, the rest of the question goes to the free models of an OpenRouter preset named `free`, if the Worker has the secret `OPENROUTER_API_KEY`.
5. The answer replaces "thinking…".

## Mentions

Discord passes messages to a bot only over a live Gateway connection, which a Worker can't hold. So a `Gateway` Durable Object keeps it, and its alarm checks every minute and reconnects after a deploy or an outage. The cron trigger starts that alarm.

1. The connection asks for server messages and scheduled events only. A message that mentions the bot carries its text without Discord's privileged Message Content intent.
2. A mention from someone with a role in `ASKER_ROLES`, Admin and Member here, gets a "Looking that up…" reply, which the answer replaces. Everyone else gets a one-line note.
3. The question runs in the same `Ask` alarm as `/ffbot`. This path needs the bot token in the Worker as `DISCORD_TOKEN`.
4. Every new scheduled event is posted to the channel in `EVENTS_CHANNEL` as its link, which Discord shows as a card with an Interested button.

## News

A Cron Trigger runs every 15 minutes, on Cloudflare and free, with nothing to keep running elsewhere.

| Channel | Source | Kept |
|---|---|---|
| #wowhead | [Wowhead's Forever news feed](https://www.wowhead.com/news/rss/forever) | Items tagged or titled Forever |
| #blue-posts | [Wowhead's Forever blue tracker](https://www.wowhead.com/forever/blue-tracker?rss) | EU forum posts, since the US copies and Blizzard's news articles repeat them |

1. Each feed has its own Durable Object, which remembers the items it posted, so nothing appears twice.
2. The first run posts the 3 newest items, and every run after that posts what is new, oldest first, at most 10 at a time.
3. Posts go through a channel webhook as embeds with the source and the original date. An updated blue topic gets a new title and posts again.

## Set up

Requires Node 22.15 or later, a Cloudflare account and a [Google AI Studio](https://aistudio.google.com) API key, all free. Deploy both MCP servers to the same Cloudflare account first, as Workers named `wowhead-mcp` and `wow-armory-mcp`. Their READMEs explain how.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Under Installation, set Install Link to None and keep only Guild Install. Under Bot, turn Public Bot off, then copy the token from Reset Token into the keychain. The command asks for it:

   ```sh
   security add-generic-password -s friends-forever-bot-discord-token -a "$USER" -w
   ```

2. Copy the Public Key from General Information into `vars` in `wrangler.jsonc`.
3. Deploy the Worker and give it the Gemini key from the keychain:

   ```sh
   npm install
   npx wrangler deploy
   security find-generic-password -s friends-forever-bot-gemini -w | npx wrangler secret put GEMINI_API_KEY
   ```

4. In General Information, set Interactions Endpoint URL to the Worker URL that `wrangler deploy` printed, and save.
5. Register the command:

   ```sh
   DISCORD_TOKEN="$(security find-generic-password -s friends-forever-bot-discord-token -w)" npm run register
   ```

6. Add the app to your server with `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=applications.commands`.
7. Optional: limit `/ffbot` to one channel in Server Settings, Integrations.
8. For the news, create a webhook in each news channel under Edit Channel, Integrations, save both URLs in the keychain and give them to the Worker:

   ```sh
   security find-generic-password -s friends-forever-bot-wowhead-webhook -w | npx wrangler secret put WOWHEAD_WEBHOOK_URL
   security find-generic-password -s friends-forever-bot-blue-webhook -w | npx wrangler secret put BLUE_WEBHOOK_URL
   ```

Try a question without Discord. It starts both MCP servers from GitHub, like any other user would:

```sh
GEMINI_API_KEY="$(security find-generic-password -s friends-forever-bot-gemini -w)" npm run ask -- "Where does Thunderfury drop?"
```

## Limits

| Limit | Value |
|---|---|
| Gemini free tier | A daily quota per model, shown in AI Studio. A question takes 2 to 8 requests |
| Durable Objects on the free plan | 13,000 GB-s a day. The Gateway connection stays open around the clock and uses about 10,800 of them |
| OpenRouter free models | 50 requests a day for an account that never bought credits. Give the key a credit limit of 0, so it can't spend |
| Cloudflare Workers Free | 100,000 requests a day for the whole account |
| Answer time | Usually 10 to 60 seconds, longer when Gemini is busy |
| Question length | 300 characters |
| Characters | Retail and Classic only, until Blizzard's API has WoW Forever characters |

## Privacy

Questions go to Google's Gemini API on its free tier, and to OpenRouter's free models when Gemini is busy, whose providers may log them too. Google may use them to improve its products and people may review them, so don't type personal information. The bot keeps nothing: each question is deleted once its answer is sent.

## Develop

```sh
npm test
```

The tests need no network.

## License

MIT. Wowhead's data belongs to Wowhead and the armory's to Blizzard, and their terms apply: personal, non-commercial use only. World of Warcraft is a trademark of Blizzard Entertainment. This project is not affiliated with Blizzard, Wowhead or Google.
