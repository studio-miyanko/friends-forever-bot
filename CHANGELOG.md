# Changelog

## 1.1.0 (2026-10-16)

- Posts WoW Forever news by itself every 15 minutes: Wowhead's Forever articles to #wowhead and EU blue posts from Wowhead's blue tracker to #blue-posts, each item once.
- Replies are plain messages instead of embeds, so they read at full size. The question sits small on top and the summary is a heading. A character answer no longer shows the portrait.

## 1.0.0 (2026-10-16)

- First release as Friends Forever Bot, with the command `/ffbot`, for the Friends Forever Discord server.
- Answers World of Warcraft questions only, and WoW Forever by default, through the wowhead-mcp and wow-armory-mcp servers, which it reaches over MCP as private Workers.
- Every reply is an embed with a one-sentence summary, the details and the sources. A character answer links the official armory page and shows the portrait.
- Falls back from Gemini 3.5 Flash Lite to 3.1 Flash Lite and 3.5 Flash, with one more round when all are busy.
- A reply is saved before it is sent, so a failed delivery is retried without asking the model again.
