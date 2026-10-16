import pkg from '../package.json' with { type: 'json' };

const API = 'https://discord.com/api/v10';
const SUPPRESS_EMBEDS = 1 << 2;
const CONTENT_MAX = 2000;
const TITLE_MAX = 256;
const DESCRIPTION_MAX = 4096;
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

// The answer's first sentence becomes the title and the rest the description, so every reply reads summary first.
// A character answer links its armory page from the title and shows the portrait beside it.
export function replyMessage(question, { text, character }) {
  const [first, ...rest] = text.trim().split(/\n\s*\n/);
  const summary = plainText(first.replace(/\s+/g, ' '));
  const isSummary = Boolean(summary) && summary.length <= TITLE_MAX && !/^[-*•]|^\d+\./.test(summary);
  const description = (isSummary ? rest.join('\n\n') : text).trim();
  return {
    embeds: [{
      author: { name: clip(question, TITLE_MAX) },
      title: isSummary ? summary : undefined,
      url: isSummary ? character?.armory : undefined,
      description: description ? clip(description, DESCRIPTION_MAX) : undefined,
      thumbnail: character?.portrait ? { url: character.portrait } : undefined,
    }],
    allowed_mentions: { parse: [] },
  };
}

// The same reply without the embed, for when Discord refuses the embed. Links stay quiet, so no previews pile up.
function plainMessage({ embeds: [embed] }) {
  const text = [`> ${embed.author.name}`, embed.title, embed.description, embed.url].filter(Boolean).join('\n\n');
  return { content: clip(text, CONTENT_MAX), flags: SUPPRESS_EMBEDS, allowed_mentions: { parse: [] } };
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
    if (response.status === 400 && message.embeds) {
      console.log('embed refused', body.slice(0, 300));
      message = plainMessage(message);
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
