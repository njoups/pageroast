import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FeedParseError, parseFeed, parseFeedDate, plainText } from '../../../src/ingestion/feed-parser';

const fx = (f: string) => readFileSync(join(__dirname, '../../fixtures/feeds', f), 'utf8');

describe('feed parser', () => {
  it('parses RSS 2.0 items, metadata, authors, categories and relative links', () => {
    const f = parseFeed(fx('rss2.xml'), 'https://news.example/rss');
    expect(f).toMatchObject({ format: 'rss2', title: 'Kabar Contoh & Daerah', language: 'id-id' });
    expect(f.items).toHaveLength(3);
    const [a, b, c] = f.items;
    expect(a).toMatchObject({
      title: 'Banjir rendam 3 kecamatan di Kota Contoh',            // markup stripped from CDATA
      link: 'https://news.example/2026/10/banjir-kota-contoh?utm_source=rss&id=7',
      guid: 'news-example-1001', author: 'Rina Contoh', categories: ['Bencana', 'Daerah'],
      summary: 'Hujan deras sejak Minggu malam membuat tiga kecamatan terendam.',
    });
    expect(a!.publishedAt!.toISOString()).toBe('2026-10-19T01:15:00.000Z');
    expect(a!.content).toContain('FULL ARTICLE BODY');
    expect(b!.link).toBe('https://news.example/2026/10/bantuan-logistik');   // resolved against channel link
    expect(b!.publishedAt!.toISOString()).toBe('2026-10-19T02:00:00.000Z');    // Indonesian day/month + WIB
    expect(c!.publishedAt).toBeNull();                                          // missing date stays null
  });

  it('reports invalid items instead of failing the whole feed', () => {
    const f = parseFeed(fx('rss2.xml'));
    expect(f.rejected.map((r) => r.reason)).toEqual(['missing_title', 'missing_or_invalid_link', 'missing_or_invalid_link']);
  });

  it('parses Atom with alternate links, html summaries and updated-only dates', () => {
    const f = parseFeed(fx('atom.xml'));
    expect(f).toMatchObject({ format: 'atom', title: 'Example Atom Wire', link: 'https://wire.example/', language: 'en' });
    expect(f.items[0]).toMatchObject({ link: 'https://wire.example/a/procurement-rules', author: 'Wire Desk', categories: ['Policy'], summary: 'New rules take effect in January.' });
    expect(f.items[0]!.publishedAt!.toISOString()).toBe('2026-10-18T22:00:00.000Z');
    expect(f.items[1]!.publishedAt!.toISOString()).toBe('2026-10-18T20:30:00.000Z');
  });

  it('parses RSS 1.0 (RDF)', () => {
    const f = parseFeed(fx('rss1.xml'));
    expect(f.format).toBe('rss1');
    expect(f.items[0]).toMatchObject({ title: 'RDF item one', link: 'https://old.example/1' });
  });

  it.each([
    ['malformed.xml', /Malformed XML|neither RSS nor Atom/],
    ['entity-bomb.xml', /entities are rejected/],
    ['paywall.html', /HTML page, not a feed/],
  ])('rejects %s', (file, msg) => {
    expect(() => parseFeed(fx(file))).toThrow(FeedParseError);
    expect(() => parseFeed(fx(file))).toThrow(msg);
  });

  it('rejects empty and non-feed XML', () => {
    expect(() => parseFeed('')).toThrow(/Empty/);
    expect(() => parseFeed('<?xml version="1.0"?><html><body/></html>')).toThrow(/neither RSS nor Atom/);
  });

  it('caps very large feeds and records the overflow', () => {
    const items = Array.from({ length: 510 }, (_v, i) => `<item><title>t${i}</title><link>https://x.example/${i}</link></item>`).join('');
    const f = parseFeed(`<rss version="2.0"><channel><title>Big</title>${items}</channel></rss>`);
    expect(f.items).toHaveLength(500);
    expect(f.rejected.at(-1)!.reason).toBe('item_limit_exceeded:10');
  });

  describe('dates', () => {
    const now = Date.UTC(2026, 9, 19, 12);
    it.each([
      ['Mon, 19 Oct 2026 08:15:00 +0700', '2026-10-19T01:15:00.000Z'],
      ['2026-10-19T08:15:00Z', '2026-10-19T08:15:00.000Z'],
      ['Selasa, 13 Oktober 2026 10:00 WIB', '2026-10-13T03:00:00.000Z'],
      ['13 Agu 2026 10:00 WITA', '2026-08-13T02:00:00.000Z'],
    ])('%s', (raw, iso) => expect(parseFeedDate(raw, now)?.toISOString()).toBe(iso));
    it('treats garbage, far-future and pre-web dates as unknown', () => {
      expect(parseFeedDate('kemarin sore', now)).toBeNull();
      expect(parseFeedDate('2027-06-01T00:00:00Z', now)).toBeNull();
      expect(parseFeedDate('1970-01-01T00:00:00Z', now)).toBeNull();
      expect(parseFeedDate(null, now)).toBeNull();
    });
  });

  it('plainText strips scripts, tags and control characters and decodes entities', () => {
    expect(plainText('<script>alert(1)</script><p>A &amp; B&#33; &#x263A;\u0007</p>')).toBe('A & B! ☺');
    expect(plainText('x'.repeat(20), 10)).toBe('xxxxxxxxx…');
  });
});
