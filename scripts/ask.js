// Asks one question without Discord, with both MCP servers started from GitHub like any other user would:
// GEMINI_API_KEY="$(security find-generic-password -s friends-forever-bot-gemini -w)" npm run ask -- "Where does Thunderfury drop?"
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { answer, connectTools } from '../src/agent.js';

const question = process.argv.slice(2).join(' ').trim();
if (!question || !process.env.GEMINI_API_KEY) {
  console.error('Usage: GEMINI_API_KEY="$(security find-generic-password -s friends-forever-bot-gemini -w)" npm run ask -- "your question"');
  process.exit(1);
}

// The armory reads its Blizzard client from the environment or, on macOS, the keychain.
const tools = await connectTools([
  new StdioClientTransport({ command: 'npx', args: ['-y', 'github:studio-miyanko/wowhead-mcp#semver:^1'], env: { ...process.env, WOWHEAD_EDITION: 'forever' } }),
  new StdioClientTransport({ command: 'npx', args: ['-y', 'github:studio-miyanko/wow-armory-mcp#semver:^1'], env: process.env }),
]);
try {
  const { text, character } = await answer(question, { apiKey: process.env.GEMINI_API_KEY, fallbackKey: process.env.OPENROUTER_API_KEY, tools });
  console.log(text);
  if (character) console.log(`\nArmory: ${character.armory}\nPortrait: ${character.portrait ?? 'none'}`);
} finally {
  await tools.close();
}
process.exit(0);
