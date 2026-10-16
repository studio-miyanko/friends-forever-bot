# Friends Forever Bot

Discord bot for the Friends Forever server. Type `/ffbot` with a World of Warcraft question, and it looks the answer up on Wowhead and Blizzard's armory. Every reply gives a one-sentence summary, then the details and its sources. A character answer links the official armory page and shows the character's portrait.

```text
/ffbot question: where does Thunderfury drop?
```

It answers World of Warcraft questions only, and means WoW Forever unless you name another version. It runs on Cloudflare Workers' free plan and Gemini's free tier.

## How it works

1. Discord sends each `/ffbot` to the Worker, which checks Discord's signature and shows "thinking…".
2. A Durable Object alarm takes the question, because one with several lookups can need longer than the 30 seconds a Worker may run after replying.
3. The bot connects to two MCP servers: [wowhead-mcp](https://github.com/studio-miyanko/wowhead-mcp), locked to WoW Forever, and [wow-armory-mcp](https://github.com/studio-miyanko/wow-armory-mcp). They run as their own private Workers, which the bot reaches through service bindings. The bot only speaks MCP to them and holds none of their code.
4. Gemini picks the lookups and writes the answer: 3.5 Flash Lite first, then 3.1 Flash Lite, then 3.5 Flash when the others are busy.
5. The answer replaces "thinking…".

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

Try a question without Discord. It starts both MCP servers from GitHub, like any other user would:

```sh
GEMINI_API_KEY="$(security find-generic-password -s friends-forever-bot-gemini -w)" npm run ask -- "Where does Thunderfury drop?"
```

## Limits

| Limit | Value |
|---|---|
| Gemini free tier | A daily quota per model, shown in AI Studio. A question takes 2 to 8 requests |
| Cloudflare Workers Free | 100,000 requests a day for the whole account |
| Answer time | Usually 10 to 60 seconds, longer when Gemini is busy |
| Question length | 300 characters |
| Characters | Retail and Classic only, until Blizzard's API has WoW Forever characters |

## Privacy

Questions go to Google's Gemini API on its free tier. Google may use them to improve its products and people may review them, so don't type personal information. The bot keeps nothing: each question is deleted once its answer is sent.

## Develop

```sh
npm test
```

The tests need no network.

## License

MIT. Wowhead's data belongs to Wowhead and the armory's to Blizzard, and their terms apply: personal, non-commercial use only. World of Warcraft is a trademark of Blizzard Entertainment. This project is not affiliated with Blizzard, Wowhead or Google.
