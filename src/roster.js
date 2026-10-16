import { botRequest } from './discord.js';

// The onboarding picks, with the icons the onboarding answers show.
const ROLES = [['Tank', '🛡️'], ['Healer', '💚'], ['DPS', '💥']];
const CLASSES = [['Druid', '🐾'], ['Hunter', '🏹'], ['Mage', '🔮'], ['Paladin', '🔨'], ['Priest', '✨'], ['Rogue', '🗡️'], ['Shaman', '⚡'], ['Warlock', '💀'], ['Warrior', '⚔️']];
const TITLE = '# 🧮 Who plays what';
const COMPONENTS_V2 = 1 << 15;
const GOLD = 0xf0b232;

const text = (content) => ({ type: 10, content });
const line = (spacing = 2) => ({ type: 14, divider: true, spacing });

function texts(components) {
  return (components ?? []).flatMap((part) => (part.type === 10 ? [part.content] : texts(part.components)));
}

// The card from each pick's number of members, with what nobody plays yet at the end.
export function rosterCard(counts) {
  const tally = (picks) => picks.map(([name, icon]) => `${icon} ${name}: ${counts[name] ?? 0}`).join('\n');
  const open = (picks) => picks.filter(([name]) => !counts[name]).map(([name, icon]) => `${icon} ${name}`).join(', ');
  const missing = [['Roles', open(ROLES)], ['Classes', open(CLASSES)]].filter(([, list]) => list).map(([label, list]) => `- ${label}: ${list}`);
  return [{
    type: 17,
    accent_color: GOLD,
    components: [
      text(`${TITLE}\n-# Everyone's picks from Channels & Roles. Updates every 15 minutes.`),
      line(),
      text(`## Roles\n${tally(ROLES)}`),
      text(`## Classes\n${tally(CLASSES)}`),
      line(),
      text(`## Still open\n${missing.length ? missing.join('\n') : 'Every role and class is covered.'}`),
      text('-# Pick or change yours under Channels & Roles at the top of the channel list.'),
    ],
  }];
}

// Keeps the roster card in the launch channel up to date, posting it the first time.
// Discord's per-role member counts answer a bot without the privileged Server Members intent,
// which listing the members would need. The endpoint is undocumented, so a failure only skips this run.
export async function updateRoster(env) {
  const token = env.DISCORD_TOKEN;
  const [roles, counts, messages] = await Promise.all([
    botRequest(token, 'GET', `/guilds/${env.GUILD_ID}/roles`),
    botRequest(token, 'GET', `/guilds/${env.GUILD_ID}/roles/member-counts`),
    botRequest(token, 'GET', `/channels/${env.LAUNCH_CHANNEL}/messages?limit=20`),
  ]);
  const card = rosterCard(Object.fromEntries(roles.map((role) => [role.name, counts[role.id] ?? 0])));
  const mine = messages.find((message) => texts(message.components).some((part) => part.startsWith(TITLE)));
  const body = { components: card, allowed_mentions: { parse: [] } };
  if (!mine) return botRequest(token, 'POST', `/channels/${env.LAUNCH_CHANNEL}/messages`, { ...body, flags: COMPONENTS_V2 });

  // An unchanged card isn't edited, so it doesn't show as edited every 15 minutes.
  if (texts(mine.components).join('\n') === texts(card).join('\n')) return undefined;
  return botRequest(token, 'PATCH', `/channels/${env.LAUNCH_CHANNEL}/messages/${mine.id}`, body);
}
