import { DurableObject } from 'cloudflare:workers';

import { USER_AGENT, clip, postWebhook } from './discord.js';

const BLUE = 0x148eff;
const TITLE_MAX = 256;
const SUMMARY_MAX = 300;

// A feed's first run posts only its newest items, so a new channel starts with a short check instead of a flood.
const FIRST_RUN = 3;

// Each post is a subrequest, and the free plan allows 50 per run, so a backlog drains over several runs.
const PER_RUN = 10;

// The feeds list about 50 items, so this remembers every item that can still show up.
const SEEN_MAX = 300;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(text) {
  return text
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, code) => {
      if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? match;
      return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
    });
}

function tag(xml, name) {
  const open = xml.indexOf(`<${name}`);
  if (open < 0) return '';
  const start = xml.indexOf('>', open) + 1;
  const end = xml.indexOf(`</${name}>`, start);
  return end < 0 ? '' : xml.slice(start, end).trim();
}

function tags(xml, name) {
  return xml.split(`<${name}`).slice(1).map((part) => decode(tag(`<${name}${part}`, name)));
}

// The first paragraph of the description, as plain text cut at a word.
function summary(html) {
  const text = decode(html.split(/<br\s*\/?>/i)[0].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX).replace(/\s+\S*$/, '')}…`;
}

// Reads an RSS feed's items. Wowhead's full article text sits in content:encoded, which is skipped to save CPU time.
export function parseFeed(xml) {
  return xml.split('<item>').slice(1).map((raw) => {
    const ends = [raw.indexOf('</item>'), raw.indexOf('<content:encoded')].filter((at) => at >= 0);
    const item = raw.slice(0, Math.min(...ends, raw.length));
    const description = decode(tag(item, 'description'));
    return {
      title: decode(tag(item, 'title')),
      link: decode(tag(item, 'link')),
      guid: decode(tag(item, 'guid')),
      date: new Date(tag(item, 'pubDate')),
      categories: tags(item, 'category'),
      summary: summary(description),
      author: description.match(/By\s*<a[^>]*>([^<]+)<\/a>/)?.[1]?.trim(),
    };
  });
}

export const FEEDS = {
  wowhead: {
    url: 'https://www.wowhead.com/news/rss/forever',
    webhook: 'WOWHEAD_WEBHOOK_URL',

    // The Forever feed also carries general WoW posts, so only items tagged or titled Forever pass.
    wanted: (item) => item.categories.includes('Forever') || /forever/i.test(item.title),
    key: (item) => item.guid,
    footer: () => 'Wowhead',
  },
  blue: {
    url: 'https://www.wowhead.com/forever/blue-tracker?rss',
    webhook: 'BLUE_WEBHOOK_URL',
    color: BLUE,

    // The tracker lists most posts twice, from the US and the EU forums, and Blizzard's news articles repeat them,
    // so only EU forum posts pass.
    wanted: (item) => item.link.includes('/blue-tracker/topic/eu/'),

    // An updated topic keeps its link and gets a new title, like "Development Notes – Updated 15 October", so it posts again.
    key: (item) => `${item.guid} ${item.title}`,
    footer: (item) => (item.author ? `Blue post by ${item.author}` : 'Blue post'),
  },
};

export function newsEmbed(feed, item) {
  return {
    title: clip(item.title, TITLE_MAX),
    url: item.link,
    description: item.summary || undefined,
    color: feed.color,
    footer: { text: feed.footer(item) },
    timestamp: Number.isNaN(item.date.getTime()) ? undefined : item.date.toISOString(),
  };
}

// Picks what to post, oldest first. Without a memory yet, the newest few go out and everything older counts as seen.
export function pickNew(feed, items, seen) {
  const wanted = items.filter(feed.wanted).sort((a, b) => a.date - b.date);
  if (!seen) return { post: wanted.slice(-FIRST_RUN), seen: wanted.slice(0, -FIRST_RUN).map(feed.key) };
  const known = new Set(seen);
  return { post: wanted.filter((item) => !known.has(feed.key(item))).slice(0, PER_RUN), seen };
}

// One object per feed keeps the keys of what it posted, so every item reaches its channel once.
export class NewsFeed extends DurableObject {
  async run(name) {
    const feed = FEEDS[name];
    const webhook = this.env[feed.webhook];
    if (!webhook) return console.log(`news ${name}: no webhook set`);

    const response = await fetch(feed.url, { headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) return console.log(`news ${name}: feed answered ${response.status}`);

    const picked = pickNew(feed, parseFeed(await response.text()), await this.ctx.storage.get('seen'));
    const seen = [...picked.seen];

    // Saving after each post means a failed run resumes where it stopped, without posting anything twice.
    for (const item of picked.post) {
      await postWebhook(webhook, { embeds: [newsEmbed(feed, item)], allowed_mentions: { parse: [] } });
      seen.push(feed.key(item));
      await this.ctx.storage.put('seen', seen.slice(-SEEN_MAX));
    }
    if (!picked.post.length) await this.ctx.storage.put('seen', seen.slice(-SEEN_MAX));
    if (picked.post.length) console.log(`news ${name}: posted ${picked.post.length}`);
  }
}
