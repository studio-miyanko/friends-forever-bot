import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer as createArmory } from 'wow-armory-mcp/src/server.js';
import { createServer as createWowhead } from 'wowhead-mcp/src/server.js';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// Each model has its own free daily quota, so the second takes over when the first is used up or down.
export const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const MAX_STEPS = 6;
const DEADLINE_MS = 10 * 60 * 1000;
const NO_ANSWER = "Sorry, I couldn't find an answer to that in WoW Forever.";
const ANSWER_NOW = 'Stop looking things up. Answer the question now from what the tools returned.';

const INSTRUCTIONS = `You answer World of Warcraft: Forever questions for a group of friends in a Discord server.

- Look every fact up with the tools: search for names, get_page for details, get_news for news, beta builds and patch notes. Never answer from memory.
- For a character's level, spec, gear or stats, use character with the region (eu or us), realm and name. Use realm first if the realm name is unclear.
- Answer as soon as the tools give enough, usually after 2 or 3 lookups.
- Cover WoW Forever only. For other games or WoW versions, say that you only know WoW Forever. The one exception is characters: Blizzard's API has no WoW Forever characters yet, so character finds Retail and Classic characters, and you say which version.
- Keep it short for Discord: at most 1200 characters, plain sentences or a short list, no tables or headings.
- End with the Wowhead links you used, at most 3, each on its own line. Character answers need no links.
- If the tools don't have the answer, say so plainly.`;

// One MCP session per isolate, so the server's page cache also serves later questions.
let session;

async function connectTo(server) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'wow-forever-bot', version: '1.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  return tools.map((tool) => ({ client, tool }));
}

// The armory reads its Blizzard client from the Worker secrets, which nodejs_compat puts into process.env.
async function connect() {
  const entries = (await Promise.all([connectTo(createWowhead({ edition: 'forever' })), connectTo(createArmory())])).flat();
  const clients = new Map(entries.map(({ client, tool }) => [tool.name, client]));

  // Gemini's OpenAI endpoint takes OpenAI-style function tools, and MCP already describes each tool in JSON Schema.
  const functions = entries.map(({ tool: { name, description, inputSchema: { $schema, ...parameters } } }) => ({
    type: 'function',
    function: { name, description, parameters },
  }));
  return { clients, functions };
}

function getSession() {
  session ??= connect().catch((err) => {
    session = undefined;
    throw err;
  });
  return session;
}

async function runTool(clients, call) {
  try {
    const args = JSON.parse(call.function.arguments || '{}');
    const client = clients.get(call.function.name);
    if (!client) throw new Error(`No tool named ${call.function.name}`);
    const result = await client.callTool({ name: call.function.name, arguments: args });
    return result.content.map((part) => part.text ?? '').join('\n');
  } catch (err) {
    return `Tool error: ${err.message}`;
  }
}

// Gemini speaks the OpenAI format, so the MCP tools and the loop below stay as they are.
export async function callGemini(messages, tools, apiKey, final) {
  let failure;
  for (const model of MODELS) {
    try {
      const response = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          tools,
          tool_choice: final ? 'none' : 'auto',
          max_tokens: 1500,
          reasoning_effort: 'low',
        }),
        signal: AbortSignal.timeout(45_000),
      });
      if (response.ok) {
        const message = (await response.json()).choices?.[0]?.message;
        console.log('answered by', model);
        if (message?.content?.trim() || message?.tool_calls?.length) return message;
        failure = `${model} sent an empty reply`;
      } else {
        const text = await response.text();
        failure = text.includes('PerDay') ? `${model} used up its daily quota` : `${model} answered ${response.status}: ${text.slice(0, 300)}`;

        // A wrong key fails on every model.
        if ([401, 403].includes(response.status)) break;
      }
    } catch (err) {
      failure = `${model} failed: ${err.message}`;
    }
    console.log(failure);
  }
  throw new Error(failure);
}

export async function answer(question, apiKey, chat = callGemini) {
  const { clients, functions } = await getSession();
  const started = Date.now();

  // Small models follow the language rule more reliably in the message than in the instructions.
  const messages = [
    { role: 'system', content: INSTRUCTIONS },
    { role: 'user', content: `${question}\n\n(Reply in the language of the question above.)` },
  ];
  for (let step = 1; step <= MAX_STEPS; step++) {
    const final = step === MAX_STEPS || Date.now() - started > DEADLINE_MS;

    // Gemini ignores tool_choice none and keeps looking things up, only a plain request makes it answer.
    if (final) messages.push({ role: 'user', content: ANSWER_NOW });
    const reply = await chat(messages, functions, apiKey, final);
    if (!reply.tool_calls?.length || final) return reply.content?.trim() || NO_ANSWER;
    messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: await runTool(clients, call) });
    }
  }
  return NO_ANSWER;
}
