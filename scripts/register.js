// Registers the /wowbot command once. Only this step needs the bot token, the Worker never does.
const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_TOKEN;
if (!appId || !token) {
  console.error('Usage: DISCORD_APP_ID=... DISCORD_TOKEN=... npm run register');
  process.exit(1);
}

const command = {
  name: 'wowbot',
  description: 'Ask about WoW Forever',
  options: [{ type: 3, name: 'question', description: 'Your question', required: true, max_length: 300 }],

  // Servers only, no direct messages or user installs.
  integration_types: [0],
  contexts: [0],
};

const response = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: 'PUT',
  headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify([command]),
});
console.log(response.ok ? 'Registered /wowbot' : `Discord answered ${response.status}: ${await response.text()}`);
process.exit(response.ok ? 0 : 1);
