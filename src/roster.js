import { botRequest } from './discord.js';

// The onboarding picks, with the icons the onboarding answers show.
const ROLES = [['Tank', '🛡️'], ['Healer', '💚'], ['DPS', '💥']];
const CLASSES = [['Druid', '🐾'], ['Hunter', '🏹'], ['Mage', '🔮'], ['Paladin', '🔨'], ['Priest', '✨'], ['Rogue', '🗡️'], ['Shaman', '⚡'], ['Warlock', '💀'], ['Warrior', '⚔️']];
const TITLE = '## 🧮 Who plays what';
const TEXT = 10;
const SEPARATOR = 14;
const CONTAINER = 17;

const text = (content) => ({ type: TEXT, content });
const line = () => ({ type: SEPARATOR, divider: true, spacing: 2 });

function texts(components) {
  return (components ?? []).flatMap((part) => (part.type === TEXT ? [part.content] : texts(part.components)));
}

// Discord gives every part of a message an id, which a rebuilt part list must not repeat.
function withoutIds(parts) {
  return parts.map(({ id, ...part }) => (part.components ? { ...part, components: withoutIds(part.components) } : part));
}

// The roster section of the launch post, from each pick's number of members, with what nobody plays yet at the end.
export function rosterParts(counts) {
  const tally = (picks) => picks.map(([name, icon]) => `${icon} ${name}: ${counts[name] ?? 0}`).join('\n');
  const open = (picks) => picks.filter(([name]) => !counts[name]).map(([name, icon]) => `${icon} ${name}`).join(', ');
  const missing = [['Roles', open(ROLES)], ['Classes', open(CLASSES)]].filter(([, list]) => list).map(([label, list]) => `- ${label}: ${list}`);
  return [
    line(),
    text(`${TITLE}\n-# Everyone's picks from Channels & Roles. Updates every 15 minutes.`),
    text(`### Roles\n${tally(ROLES)}`),
    text(`### Classes\n${tally(CLASSES)}`),
    text(`### Still open\n${missing.length ? missing.join('\n') : 'Every role and class is covered.'}`),
    text('-# Pick or change yours under Channels & Roles at the top of the channel list.'),
  ];
}

// Keeps the roster section of the launch post up to date and leaves the rest of the post as it is,
// so the launch text can change without a deploy. The first run adds the section at the end.
// Discord's per-role member counts answer a bot without the privileged Server Members intent,
// which listing the members would need. The endpoint is undocumented, so a failure only skips this run.
export async function updateRoster(env) {
  const token = env.DISCORD_TOKEN;
  const [roles, counts, messages] = await Promise.all([
    botRequest(token, 'GET', `/guilds/${env.GUILD_ID}/roles`),
    botRequest(token, 'GET', `/guilds/${env.GUILD_ID}/roles/member-counts`),
    botRequest(token, 'GET', `/channels/${env.LAUNCH_CHANNEL}/messages?limit=20`),
  ]);
  const posts = messages.filter((message) => message.components?.some((part) => part.type === CONTAINER));
  const post = posts.find((message) => texts(message.components).some((part) => part.startsWith(TITLE))) ?? posts.at(-1);
  if (!post) return undefined;

  const container = post.components.find((part) => part.type === CONTAINER);
  const parts = container.components;
  const at = parts.findIndex((part) => part.type === TEXT && part.content.startsWith(TITLE));
  const start = at < 0 ? parts.length : at - (parts[at - 1]?.type === SEPARATOR ? 1 : 0);
  const fresh = rosterParts(Object.fromEntries(roles.map((role) => [role.name, counts[role.id] ?? 0])));

  // An unchanged roster isn't edited, so the post doesn't show as edited every 15 minutes.
  if (texts(parts.slice(start)).join('\n') === texts(fresh).join('\n')) return undefined;
  const components = withoutIds(post.components.map((part) => (part === container ? { ...part, components: [...parts.slice(0, start), ...fresh] } : part)));
  return botRequest(token, 'PATCH', `/channels/${env.LAUNCH_CHANNEL}/messages/${post.id}`, { components, allowed_mentions: { parse: [] } });
}

