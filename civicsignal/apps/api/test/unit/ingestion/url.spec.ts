import { isBlockedAddress } from '../../../src/ingestion/ip-policy';
import { assertFetchableUrl, canonicalizeUrl, publisherDomain, redactUrl } from '../../../src/ingestion/url';

describe('canonical URLs', () => {
  it.each([
    ['HTTPS://News.Example:443/a/b/?utm_source=x&b=2&a=1#frag', 'https://news.example/a/b?a=1&b=2'],
    ['https://news.example/a?fbclid=1&gclid=2', 'https://news.example/a'],
    ['http://news.example:80/', 'http://news.example/'],
    ['https://news.example/a//', 'https://news.example/a'],
    ['https://news.example./a', 'https://news.example/a'],
    ['https://www.news.example/a', 'https://www.news.example/a'],   // hosts are not rewritten
  ])('%s → %s', (raw, out) => expect(canonicalizeUrl(raw)).toBe(out));

  it('treats tracking-only differences as the same article', () => {
    expect(canonicalizeUrl('https://n.example/x?utm_medium=rss')).toBe(canonicalizeUrl('https://n.example/x#comments'));
  });
  it('publisher domain drops www', () => expect(publisherDomain('https://www.news.example/a')).toBe('news.example'));
  it('redacts query strings (which may carry keys) for logs', () => expect(redactUrl('https://api.example/v1?apiKey=SECRET')).toBe('https://api.example/v1?…'));
});

describe('SSRF: address policy', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd00:ec2::254', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a9fe:a9fe', '2002:c0a8:0101::1', 'not-an-ip'])(
    'blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '183.182.92.213', '2606:4700:4700::1111'])('allows public %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('SSRF: static URL checks', () => {
  it.each([
    ['file:///etc/passwd', /Only http and https/], ['gopher://x.example/', /Only http and https/],
    ['https://user:pw@news.example/feed', /credentials/], ['http://127.0.0.1/feed', /not allowed/],
    ['http://169.254.169.254/latest/meta-data', /not allowed/], ['http://[::1]/', /not allowed/],
    ['http://localhost/feed', /host is not allowed/], ['http://metadata.google.internal/', /host is not allowed/],
    ['http://intranet/', /host is not allowed/], ['https://news.example:8443/feed', /ports 80 and 443/], ['not a url', /valid absolute URL/],
  ])('rejects %s', (url, msg) => expect(() => assertFetchableUrl(url)).toThrow(msg));
  it('accepts public http(s) URLs', () => expect(assertFetchableUrl('https://www.antaranews.com/rss/terkini.xml').hostname).toBe('www.antaranews.com'));
});
