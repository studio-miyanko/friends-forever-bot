import assert from 'node:assert/strict';
import test from 'node:test';

import { rosterParts, updateRoster } from '../src/roster.js';

function texts(components) {
  return components.flatMap((part) => (part.type === 10 ? [part.content] : texts(part.components ?? [])));
}

test('counts every pick and lists what nobody plays yet', () => {
  const roster = texts(rosterParts({ Tank: 1, DPS: 3, Mage: 2, Priest: 1, Admin: 4 })).join('\n');
  assert.match(roster, /🛡️ Tank: 1\n💚 Healer: 0\n💥 DPS: 3/);
  assert.match(roster, /🔮 Mage: 2/);
  assert.match(roster, /- Roles: 💚 Healer\n- Classes: 🐾 Druid, 🏹 Hunter, 🔨 Paladin, 🗡️ Rogue, ⚡ Shaman, 💀 Warlock, ⚔️ Warrior/);

  const full = Object.fromEntries(['Tank', 'Healer', 'DPS', 'Druid', 'Hunter', 'Mage', 'Paladin', 'Priest', 'Rogue', 'Shaman', 'Warlock', 'Warrior'].map((name) => [name, 1]));
  assert.match(texts(rosterParts(full)).join('\n'), /Every role and class is covered\./);
});

test('adds the roster to the launch post once, keeps the launch text and edits only when a count changes', async (t) => {
  let tanks = 1;
  const launch = [
    { id: 1, type: 10, content: '# 🚀 Launch' },
    { id: 2, type: 1, components: [{ id: 3, type: 2, style: 5, label: 'Party', url: 'https://discord.com/events/g1/e1' }] },
  ];
  const post = { id: 'p1', components: [{ id: 4, type: 17, accent_color: 1, components: launch }] };
  const edits = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const path = String(url).replace('https://discord.com/api/v10', '');
    if (path.endsWith('/roles')) return Response.json([{ id: 'r1', name: 'Tank' }]);
    if (path.endsWith('/member-counts')) return Response.json({ r1: tanks });
    if (path.includes('/messages?')) return Response.json([post]);
    edits.push(path);
    post.components = JSON.parse(init.body).components;
    return Response.json({ id: 'p1' });
  });
  const env = { DISCORD_TOKEN: 'tok', GUILD_ID: 'g1', LAUNCH_CHANNEL: 'c1' };

  await updateRoster(env);
  await updateRoster(env);
  tanks = 2;
  await updateRoster(env);
  assert.deepEqual(edits, ['/channels/c1/messages/p1', '/channels/c1/messages/p1']);

  const [container] = post.components;
  assert.equal(container.accent_color, 1);
  assert.deepEqual(container.components.slice(0, 2), [
    { type: 10, content: '# 🚀 Launch' },
    { type: 1, components: [{ type: 2, style: 5, label: 'Party', url: 'https://discord.com/events/g1/e1' }] },
  ]);
  assert.match(texts(post.components).join('\n'), /🛡️ Tank: 2/);
  assert.equal(texts(post.components).filter((part) => part.startsWith('## 🧮')).length, 1);
});
