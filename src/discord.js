const API = 'https://discord.com/api/v10';
const MAX_CHARS = 2000;
const SUPPRESS_EMBEDS = 1 << 2;

function hexBytes(hex) {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
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

export function clip(text) {
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS - 1)}…`;
}

// Edits the "thinking…" placeholder. The interaction token alone allows it, for 15 minutes.
export async function editReply(appId, token, content) {
  const response = await fetch(`${API}/webhooks/${appId}/${token}/messages/@original`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: clip(content), flags: SUPPRESS_EMBEDS, allowed_mentions: { parse: [] } }),
  });
  if (!response.ok) throw new Error(`Discord answered ${response.status}: ${await response.text()}`);
}
