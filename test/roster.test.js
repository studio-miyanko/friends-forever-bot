import assert from 'node:assert/strict';
import test from 'node:test';

import { rosterCard, updateRoster } from '../src/roster.js';

function texts(components) {
  return components.flatMap((part) => (part.type === 10 ? [part.content] : texts(part.components ?? [])));
}

test('counts every pick and lists what nobody plays yet', () => {
  const card = texts(rosterCard({ Tank: 1, DPS: 3, Mage: 2, Priest: 1, Admin: 4 })).join('\n');
  assert.match(card, /🛡️ Tank: 1\n💚 Healer: 0\n💥 DPS: 3/);
  assert.match(card, /🔮 Mage: 2/);
  assert.match(card, /- Roles: 💚 Healer\n- Classes: 🐾 Druid, 🏹 Hunter, 🔨 Paladin, 🗡️ Rogue, ⚡ Shaman, 💀 Warlock, ⚔️ Warrior/);

  const full = Object.fromEntries(['Tank', 'Healer', 'DPS', 'Druid', 'Hunter', 'Mage', 'Paladin', 'Priest', 'Rogue', 'Shaman', 'Warlock', 'Warrior'].map((name) => [name, 1]));
  assert.match(texts(rosterCard(full)).join('\n'), /Every role and class is covered\./);
});

test('posts the card once, then edits it only when a count changes', async (t) => {
  let tanks = 1;
  const card = [];
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url).replace('https://discord.com/api/v10', '');
    calls.push(`${init.method} ${path}`);
    if (path.endsWith('/roles')) return Response.json([{ id: 'r1', name: 'Tank' }]);
    if (path.endsWith('/member-counts')) return Response.json({ r1: tanks });
    if (path.includes('/messages?')) return Response.json(card.length ? [{ id: 'm1', components: card[0] }] : []);
    card[0] = JSON.parse(init.body).components;
    return Response.json({ id: 'm1' });
  });
  const env = { DISCORD_TOKEN: 'tok', GUILD_ID: 'g1', LAUNCH_CHANNEL: 'c1' };

  await updateRoster(env);
  await updateRoster(env);
  tanks = 2;
  await updateRoster(env);
  assert.deepEqual(calls.filter((call) => !call.startsWith('GET')), ['POST /channels/c1/messages', 'PATCH /channels/c1/messages/m1']);
});
