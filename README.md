# wow-forever-bot

Discord bot that answers WoW Forever questions. Type `/wowf` with a question, and it looks the answer up on Wowhead through the [wowhead-mcp](https://github.com/studio-miyanko/wowhead-mcp) server, locked to WoW Forever, written up by Gemini on its free tier.

```text
/wowf question: where does Thunderfury drop?
```

It runs on Cloudflare Workers' free plan and needs no server of its own.

## How it works

1. Discord sends each `/wowf` to the Worker, which checks Discord's signature and replies "thinking…".
2. A Durable Object alarm takes the question, because a question with several tool calls can need longer than the 30 seconds a Worker may run after replying.
3. The agent runs the wowhead-mcp tools in the Worker over an in-memory MCP transport and asks Gemini 3.5 Flash Lite. If it is down or out of quota, Gemini 3.1 Flash Lite takes over.
4. The answer replaces "thinking…", with the Wowhead links it used.

## Set up

Requires Node 22, a Cloudflare account and a [Google AI Studio](https://aistudio.google.com) API key, all on free plans.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Under Installation set Install Link to None, then under Bot turn Public Bot off.
2. Copy the Application ID and Public Key from General Information into `vars` in `wrangler.jsonc`.
3. Install and deploy:

   ```sh
   npm install
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler deploy
   ```

4. In General Information, set Interactions Endpoint URL to the Worker URL that `wrangler deploy` printed, and save.
5. Register the command with the token from Bot, Reset Token. Only this step uses it:

   ```sh
   DISCORD_APP_ID=... DISCORD_TOKEN=... npm run register
   ```

6. Add it to your server with `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=applications.commands`.

Try a question without Discord:

```sh
GEMINI_API_KEY=... npm run ask -- "Where does Thunderfury drop?"
```

## Limits

| Limit | Value |
|---|---|
| Gemini free tier | 15 requests a minute and 500 a day for each of the two models, per AI Studio project. A question takes 2 to 4 |
| Cloudflare Workers Free | 100,000 requests a day |
| Question length | 300 characters |
| Answer length | 2,000 characters, Discord's limit |

## Develop

```sh
npm test
```

## License

MIT. Wowhead's data belongs to Wowhead, and its terms apply: personal, non-commercial use only. World of Warcraft is a trademark of Blizzard Entertainment. This project is not affiliated with Blizzard or Wowhead.
