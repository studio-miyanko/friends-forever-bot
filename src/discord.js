import pkg from '../package.json' with { type: 'json' };

const API = 'https://discord.com/api/v10';
const SUPPRESS_EMBEDS = 1 << 2;
const CONTENT_MAX = 2000;
const TITLE_MAX = 256;
const RATE_LIMIT_WAITS = 2;

// Discord asks every app to name itself, and may block requests without it.
export const USER_AGENT = `DiscordBot (https://github.com/studio-miyanko/${pkg.name}, ${pkg.version})`;

function hexBytes(hex) {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Discord signs every interaction, and an endpoint that accepts unsigned ones gets disabled.
export async function isFromDiscord(request, body, publicKey) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp || !publicKey) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hexBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hexBytes(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

export function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Masked links show as raw markup in a title, so a title keeps only their text.
function plainText(markdown) {
  return markdown.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

// A plain message reads at full size, while an embed's text is smaller. The question sits small on top and the answer's
// first sentence becomes a heading, so every reply reads summary first. A character answer links its armory page from it.
// Links stay quiet, so no previews pile up. A reply to a mention leaves the question out, since Discord shows it above.
export function replyMessage(question, { text, character }, { quote = true } = {}) {
  const [first, ...rest] = text.trim().split(/\n\s*\n/);
  const summary = plainText(first.replace(/\s+/g, ' '));
  const isSummary = Boolean(summary) && summary.length <= TITLE_MAX && !/^[-*•]|^\d+\./.test(summary);
  const heading = isSummary ? `### ${character?.armory ? `[${summary}](${character.armory})` : summary}` : undefined;
  const body = (isSummary ? rest.join('\n\n') : text).trim();
  const content = [quote ? `-# ${clip(question, TITLE_MAX)}` : undefined, heading, body].filter(Boolean).join('\n');
  return { content: clip(content, CONTENT_MAX), flags: SUPPRESS_EMBEDS, allowed_mentions: { parse: [] } };
}

// Discord names the wait in a header and in its JSON body, while a block page in front of it may send neither.
function retryAfter(response, body) {
  let seconds = Number(response.headers.get('retry-after'));
  try {
    seconds ||= Number(JSON.parse(body).retry_after);
  } catch {
    // Not JSON, so the default wait applies.
  }
  return Math.min(seconds || 1, 5) * 1000;
}

// Edits the "thinking…" placeholder, which the interaction token alone may do, for 15 minutes.
// Throws when Discord may answer later, so the caller can retry.
export async function deliver(appId, token, message) {
  for (let waits = 0; ; ) {
    const response = await fetch(`${API}/webhooks/${appId}/${token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(message),
    });
    if (response.ok) return;
    const body = await response.text();
    if (response.status === 429 && waits++ < RATE_LIMIT_WAITS) {
      await sleep(retryAfter(response, body));
      continue;
    }

    // The token expired or the placeholder is gone, so no retry can succeed.
    if ([401, 404].includes(response.status)) {
      console.log('reply dropped', response.status, body.slice(0, 300));
      return;
    }
    throw new Error(`Discord answered ${response.status}: ${body.slice(0, 300)}`);
  }
}

// Calls the API as the bot, which only the mention questions need, since their replies are channel messages.
export async function botRequest(token, method, path, body) {
  for (let waits = 0; ; ) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bot ${token}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (response.ok) return text ? JSON.parse(text) : undefined;
    if (response.status === 429 && waits++ < RATE_LIMIT_WAITS) {
      await sleep(retryAfter(response, text));
      continue;
    }
    throw Object.assign(new Error(`Discord answered ${response.status}: ${text.slice(0, 300)}`), { status: response.status });
  }
}

// Swaps a mention's "Looking that up…" placeholder for the answer. A deleted placeholder means nobody waits for it.
export async function editReply(token, { channelId, messageId }, message) {
  try {
    await botRequest(token, 'PATCH', `/channels/${channelId}/messages/${messageId}`, message);
  } catch (err) {
    if (err.status !== 404) throw err;
    console.log('reply dropped', err.message);
  }
}

// Posts to a channel webhook, which needs no bot permissions. Throws when Discord refuses, so the caller can stop.
export async function postWebhook(url, message) {
  for (let waits = 0; ; ) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify(message),
    });
    if (response.ok) return;
    const body = await response.text();
    if (response.status === 429 && waits++ < RATE_LIMIT_WAITS) {
      await sleep(retryAfter(response, body));
      continue;
    }
    throw new Error(`Discord answered ${response.status}: ${body.slice(0, 300)}`);
  }
}
