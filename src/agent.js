import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from 'wow-forever-search/src/server.js';

const ROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MODEL = 'openrouter/free';
const ATTEMPTS = 3;

// OpenRouter accepts at most 3 models per request: the router plus 2 fallbacks.
const FALLBACKS_PER_TRY = 2;
const MODELS_TTL_MS = 60 * 60 * 1000;
const MAX_STEPS = 6;
const DEADLINE_MS = 10 * 60 * 1000;
const NO_ANSWER = "Sorry, I couldn't find an answer to that in WoW Forever.";

const INSTRUCTIONS = `You answer World of Warcraft: Forever questions for a group of friends in a Discord server.

- Look every fact up with the tools: search for names, get_page for details, get_news for news, beta builds and patch notes. Never answer from memory.
- Cover WoW Forever only. For other games or WoW versions, say that you only know WoW Forever.
- Keep it short for Discord: at most 1200 characters, plain sentences or a short list, no tables or headings.
- End with the Wowhead links you used, at most 3, each on its own line.
- If the tools don't have the answer, say so plainly.`;

// One MCP session per isolate, so the server's page cache also serves later questions.
let session;

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: 'wowf-bot', version: '1.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();

  // OpenRouter takes OpenAI-style function tools, and MCP already describes each tool in JSON Schema.
  const functions = tools.map(({ name, description, inputSchema: { $schema, ...parameters } }) => ({
    type: 'function',
    function: { name, description, parameters },
  }));
  return { client, functions };
}

function getSession() {
  session ??= connect().catch((err) => {
    session = undefined;
    throw err;
  });
  return session;
}

async function runTool(client, call) {
  try {
    const args = JSON.parse(call.function.arguments || '{}');
    const result = await client.callTool({ name: call.function.name, arguments: args });
    return result.content.map((part) => part.text ?? '').join('\n');
  } catch (err) {
    return `Tool error: ${err.message}`;
  }
}

// Free models come and go, so the fallbacks are read from OpenRouter's live list instead of hard-coded.
export function pickFallbacks(models) {
  return models
    .filter((model) => model.id !== MODEL && model.pricing?.prompt === '0' && model.pricing?.completion === '0')
    .filter((model) => model.supported_parameters?.includes('tools'))
    .slice(0, ATTEMPTS * FALLBACKS_PER_TRY)
    .map((model) => model.id);
}

let fallbacks = { time: 0, ids: [] };

async function getFallbacks() {
  if (Date.now() - fallbacks.time < MODELS_TTL_MS) return fallbacks.ids;
  try {
    const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(10_000) });
    fallbacks = { time: Date.now(), ids: pickFallbacks((await response.json()).data) };
  } catch (err) {
    console.log('OpenRouter model list failed', err.message);
  }
  return fallbacks.ids;
}

// OpenRouter tries the models in order when one is down or rate-limited, and each retry brings 2 new fallbacks.
export async function callRouter(messages, tools, apiKey, final) {
  const ids = await getFallbacks();
  let failure;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const extra = ids.slice((attempt - 1) * FALLBACKS_PER_TRY, attempt * FALLBACKS_PER_TRY);
    const body = JSON.stringify({
      models: [MODEL, ...extra],
      messages,
      tools,
      tool_choice: final ? 'none' : 'auto',
      max_tokens: 1500,
      reasoning: { effort: 'low' },
    });
    try {
      const response = await fetch(ROUTER_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'http-referer': 'https://github.com/studio-miyanko/wowf-bot',
          'x-title': 'wowf-bot',
        },
        body,
        signal: AbortSignal.timeout(45_000),
      });
      if (response.ok) {
        const data = await response.json();
        const message = data.choices?.[0]?.message;
        console.log('answered by', data.model);
        if (message?.content?.trim() || message?.tool_calls?.length) return message;
        failure = `OpenRouter sent an empty reply from ${data.model}`;
      } else {
        failure = `OpenRouter answered ${response.status}: ${(await response.text()).slice(0, 300)}`;

        // A wrong key or a used-up daily quota doesn't improve on retry.
        if ([401, 402, 403].includes(response.status) || failure.includes('per-day')) break;
      }
    } catch (err) {
      failure = `OpenRouter failed: ${err.message}`;
    }
    console.log(failure);
    await new Promise((done) => setTimeout(done, 1000 * attempt));
  }
  throw new Error(failure);
}

export async function answer(question, apiKey, chat = callRouter) {
  const { client, functions } = await getSession();
  const started = Date.now();

  // Free models follow the language rule more reliably in the message than in the instructions.
  const messages = [
    { role: 'system', content: INSTRUCTIONS },
    { role: 'user', content: `${question}\n\n(Reply in the language of the question above.)` },
  ];
  for (let step = 1; step <= MAX_STEPS; step++) {
    const final = step === MAX_STEPS || Date.now() - started > DEADLINE_MS;
    const reply = await chat(messages, functions, apiKey, final);
    if (!reply.tool_calls?.length || final) return reply.content?.trim() || NO_ANSWER;
    messages.push({ role: 'assistant', content: reply.content ?? '', tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: await runTool(client, call) });
    }
  }
  return NO_ANSWER;
}
