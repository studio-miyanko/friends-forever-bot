import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// cloudflare:workers only exists inside workerd, so the feed gets a stand-in base class here.
const STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
registerHooks({ resolve: (specifier, context, next) => (specifier === 'cloudflare:workers' ? { url: STUB, shortCircuit: true } : next(specifier, context)) });
const { FEEDS, NewsFeed, newsEmbed, parseFeed, pickNew } = await import('../src/news.js');

function item({ title, link, guid = link, date, category, description = 'Summary.' }) {
  return `<item><title>${title}</title><link>${link}</link><description>${description}</description>`
    + (category ? `<category>${category}</category>` : '')
    + `<pubDate>${date}</pubDate><guid isPermaLink="false">${guid}</guid>`
    + '<content:encoded><![CDATA[<p>Full text <category>Retail</category></p>]]></content:encoded></item>';
}

const wowheadXml = '<rss><channel><title>Wowhead News</title>'
  + item({ title: 'Hunter Pets Nerfed in WoW: Forever', link: 'https://www.wowhead.com/news=3', date: 'Thu, 15 Oct 2026 21:23:00 -0500', category: 'Forever',
    description: 'Some pet abilities &amp; more were nerfed.&lt;br&gt;&lt;br&gt;&lt;a href="x"&gt;Continue reading »&lt;/a&gt;' })
  + item({ title: 'Student Art Contest 2026', link: 'https://www.wowhead.com/news=2', date: 'Fri, 09 Oct 2026 12:02:00 -0500', category: 'WoW' })
  + item({ title: 'Character Caps in WoW: Forever', link: 'https://www.wowhead.com/news=1', date: 'Wed, 14 Oct 2026 09:00:00 -0500', category: 'WoW' })
  + '</channel></rss>';

const blueXml = '<rss><channel>'
  + item({ title: 'Stress Test October 19', link: 'https://www.wowhead.com/forever/blue-tracker/topic/us/2', date: 'Thu, 15 Oct 2026 16:24:00 -0500' })
  + item({ title: 'Stress Test 19 October', link: 'https://www.wowhead.com/forever/blue-tracker/topic/eu/2', date: 'Thu, 15 Oct 2026 16:25:00 -0500',
    description: 'Please join us on October 19.&lt;br&gt;&lt;br&gt;By&lt;a href="https://www.wowhead.com/forever/blue-tracker/author/Kaivax"&gt;Kaivax&lt;/a&gt;' })
  + item({ title: 'Join the Stress Test — Blizzard News', link: 'https://www.wowhead.com/forever/blue-tracker/news/eu/9', date: 'Thu, 15 Oct 2026 16:00:00 -0500' })
  + '</channel></rss>';

test('reads RSS items and skips the full article text', () => {
  const [pets] = parseFeed(wowheadXml);
  assert.equal(pets.title, 'Hunter Pets Nerfed in WoW: Forever');
  assert.equal(pets.guid, 'https://www.wowhead.com/news=3');
  assert.deepEqual(pets.categories, ['Forever']);
  assert.equal(pets.summary, 'Some pet abilities & more were nerfed.');
  assert.equal(pets.date.toISOString(), '2026-10-16T02:23:00.000Z');
});

test('keeps only Forever news and EU blue forum posts', () => {
  assert.deepEqual(parseFeed(wowheadXml).filter(FEEDS.wowhead.wanted).map((i) => i.link), ['https://www.wowhead.com/news=3', 'https://www.wowhead.com/news=1']);
  const blue = parseFeed(blueXml).filter(FEEDS.blue.wanted);
  assert.deepEqual(blue.map((i) => i.title), ['Stress Test 19 October']);

  const embed = newsEmbed(FEEDS.blue, blue[0]);
  assert.equal(embed.footer.text, 'Blue post by Kaivax');
  assert.equal(embed.color, 0x148eff);
  assert.equal(embed.description, 'Please join us on October 19.');
});

test('the first run posts the newest three, later runs only what is new, oldest first', () => {
  const items = [1, 2, 3, 4, 5].map((n) => ({ title: `Forever ${n}`, link: `l${n}`, guid: `g${n}`, categories: ['Forever'], date: new Date(2026, 9, n) }));
  const first = pickNew(FEEDS.wowhead, items, undefined);
  assert.deepEqual(first.post.map((i) => i.guid), ['g3', 'g4', 'g5']);
  assert.deepEqual(first.seen, ['g1', 'g2']);

  const next = pickNew(FEEDS.wowhead, [...items, { ...items[0], guid: 'g6', date: new Date(2026, 9, 6) }], ['g1', 'g2', 'g3', 'g4', 'g5']);
  assert.deepEqual(next.post.map((i) => i.guid), ['g6']);
});

test('an updated blue topic posts again under its new title', () => {
  const topic = { link: 'https://www.wowhead.com/forever/blue-tracker/topic/eu/1', guid: 'eu/1', date: new Date(2026, 9, 15) };
  const seen = [FEEDS.blue.key({ ...topic, title: 'Development Notes – Updated 14 October' })];
  assert.equal(pickNew(FEEDS.blue, [{ ...topic, title: 'Development Notes – Updated 15 October' }], seen).post.length, 1);
});

function storage() {
  const data = new Map();
  return { data, get: async (key) => data.get(key), put: async (key, value) => data.set(key, value) };
}

test('a run posts through the webhook and stops at a refused post without marking it seen', async (t) => {
  const posted = [];
  let refuse = false;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url).includes('wowhead.com')) return new Response(wowheadXml);
    if (refuse) return new Response('{"message":"Unknown Webhook"}', { status: 404 });
    posted.push(JSON.parse(init.body).embeds[0].title);
    return new Response(null, { status: 204 });
  });
  const feed = new NewsFeed({ storage: storage() }, { WOWHEAD_WEBHOOK_URL: 'https://discord.test/hook' });
  await feed.run('wowhead');
  assert.deepEqual(posted, ['Character Caps in WoW: Forever', 'Hunter Pets Nerfed in WoW: Forever']);

  await feed.run('wowhead');
  assert.equal(posted.length, 2);

  await feed.ctx.storage.put('seen', []);
  refuse = true;
  await assert.rejects(feed.run('wowhead'), /Discord answered 404/);
  assert.deepEqual(await feed.ctx.storage.get('seen'), []);
});
