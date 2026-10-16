// Registers /ffbot once. Only this step needs the bot token, the Worker never does:
// DISCORD_TOKEN="$(security find-generic-password -s friends-forever-bot-discord-token -w)" npm run register
import { COMMAND } from '../src/command.js';
import { USER_AGENT } from '../src/discord.js';

const API = 'https://discord.com/api/v10';
const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Usage: DISCORD_TOKEN="$(security find-generic-password -s friends-forever-bot-discord-token -w)" npm run register');
  process.exit(1);
}
const headers = { authorization: `Bot ${token}`, 'content-type': 'application/json', 'user-agent': USER_AGENT };

// The token names its own app, so the app id needs no setting of its own.
const app = await (await fetch(`${API}/applications/@me`, { headers })).json();
if (!app.id) {
  console.error(`Discord refused the token: ${JSON.stringify(app).slice(0, 300)}`);
  process.exit(1);
}
const response = await fetch(`${API}/applications/${app.id}/commands`, { method: 'PUT', headers, body: JSON.stringify([COMMAND]) });
console.log(response.ok ? `Registered /${COMMAND.name} for ${app.name}` : `Discord answered ${response.status}: ${await response.text()}`);
process.exit(response.ok ? 0 : 1);
