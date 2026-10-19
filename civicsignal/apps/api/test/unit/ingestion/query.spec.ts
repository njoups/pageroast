import { compileQuery, evaluate, MatchDocument, parseQuery, QuerySyntaxError, QUERY_LIMITS } from '../../../src/ingestion/query';

const doc = new MatchDocument('Menteri Keuangan Sri Mulyani membahas korupsi dana Bansos di Jakarta; Bank Indonesia ikut hadir.');
const m = (q: string) => evaluate(parseQuery(q), doc);

describe('query language', () => {
  it.each([
    ['korupsi', true], ['KORUPSI', true], ['korup', false], ['korup*', true],                // whole words; prefix wildcard
    ['"Sri Mulyani"', true], ['"Mulyani Sri"', false], ['"bank indonesia"', true],          // phrases are ordered
    ['bansos AND jakarta', true], ['bansos jakarta', true], ['bansos AND surabaya', false],  // implicit AND
    ['surabaya OR jakarta', true], ['bansos NOT jakarta', false], ['bansos -surabaya', true],
    ['(surabaya OR jakarta) AND "dana bansos"', true], ['NOT (surabaya OR medan)', true],
    ['keuangan and surabaya', false],                                                       // lowercase "and" is a word
  ])('%s → %s', (q, expected) => expect(m(q)).toBe(expected));

  it('matches regardless of diacritics', () => {
    expect(evaluate(parseQuery('cafe'), new MatchDocument('Kafe dan café baru dibuka'))).toBe(true);
  });

  it.each([
    ['', /empty/], ['bansos AND', /AND must be followed/], ['OR bansos', /needs a term/], ['(bansos', /Missing closing/],
    ['bansos)', /Unexpected closing/], ['()', /Empty parentheses/], ['"unterminated', /Unclosed/], ['ko*', /at least 3/],
    ['"   "', /no words/], ['***', /no letters/],
  ])('rejects %j', (q, msg) => {
    expect(() => parseQuery(q)).toThrow(QuerySyntaxError);
    expect(() => parseQuery(q)).toThrow(msg);
  });

  it('reports the error position', () => {
    try { parseQuery('bansos AND (jakarta'); } catch (e) { expect((e as QuerySyntaxError).position).toBe(19); }
  });

  it('enforces size, term and depth limits', () => {
    expect(() => parseQuery('a'.repeat(QUERY_LIMITS.maxLength + 1))).toThrow(/longer than/);
    expect(() => parseQuery(Array.from({ length: 101 }, (_v, i) => `t${i}`).join(' OR '))).toThrow(/more than 100 terms/);
    expect(() => parseQuery('('.repeat(20) + 'x' + ')'.repeat(20))).toThrow(/nested/);
  });

  it('never evaluates input as code or SQL: hostile input is either matched as plain words or rejected as syntax', () => {
    for (const q of ["'; DROP TABLE mentions; --", 'constructor', '__proto__', '${process.exit(1)}', 'toString AND valueOf']) {
      try { expect(typeof evaluate(parseQuery(q), doc)).toBe('boolean'); }
      catch (e) { expect(e).toBeInstanceOf(QuerySyntaxError); }
    }
    expect(evaluate(parseQuery('"drop table" OR mentions'), new MatchDocument('drop table mentions'))).toBe(true);
  });
});

describe('compiled monitoring queries', () => {
  it('keywords OR aliases, AND expression, minus exclusions, with matched terms reported', () => {
    const q = compileQuery({ keywords: ['bansos'], aliases: ['bantuan sosial'], exclusions: ['hoaks'], booleanExpression: 'jakarta OR surabaya', languages: [] });
    expect(q.match(doc, 'id')).toEqual({ matched: true, terms: ['bansos', 'jakarta'] });
    expect(q.match(new MatchDocument('Bansos hoaks di Jakarta'), 'id').matched).toBe(false);
    expect(q.match(new MatchDocument('Bantuan sosial cair di Surabaya'), 'id').terms).toEqual(['"bantuan sosial"', 'surabaya']);
  });
  it('keyword entries are literal: operators inside them are not interpreted', () => {
    const q = compileQuery({ keywords: ['NOT korupsi'], aliases: [], exclusions: [], booleanExpression: null, languages: [] });
    expect(q.match(new MatchDocument('ini bukan korupsi'), null).matched).toBe(false);
    expect(q.match(new MatchDocument('not korupsi'), null).matched).toBe(true);
  });
  it('language filter allows unknown language', () => {
    const q = compileQuery({ keywords: ['bansos'], aliases: [], exclusions: [], booleanExpression: null, languages: ['id'] });
    expect(q.match(doc, 'en').matched).toBe(false);
    expect(q.match(doc, 'id').matched).toBe(true);
    expect(q.match(doc, null).matched).toBe(true);
  });
  it('requires at least one criterion', () => {
    expect(() => compileQuery({ keywords: [], aliases: [], exclusions: ['x'], booleanExpression: '  ', languages: [] })).toThrow(/at least one/);
  });
});
