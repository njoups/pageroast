/**
 * Monitoring query language. Parsed into an AST and evaluated in memory against tokenised text; never turned into SQL
 * or code. Grammar (operators are uppercase; lowercase "and"/"or"/"not" are ordinary words):
 *
 *   expr    := or
 *   or      := and ( "OR" and )*
 *   and     := unary ( ["AND"] unary )*        -- juxtaposition means AND
 *   unary   := "NOT" unary | "-" unary | primary
 *   primary := "(" expr ")" | PHRASE | TERM     -- PHRASE is "double quoted"; TERM may end with * (prefix match)
 */
export type QueryNode =
  | { type: 'term'; value: string; prefix: boolean }
  | { type: 'phrase'; tokens: string[] }
  | { type: 'not'; child: QueryNode }
  | { type: 'and' | 'or'; children: QueryNode[] };

export class QuerySyntaxError extends Error {
  constructor(message: string, readonly position: number) { super(message); this.name = 'QuerySyntaxError'; }
}

export const QUERY_LIMITS = { maxLength: 2000, maxTerms: 100, maxDepth: 12, minPrefixLength: 3 };

/** Lowercase, Unicode-normalise, drop diacritics, split into letter/number tokens. */
export function tokenize(text: string): string[] {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

type Tok = { kind: 'lp' | 'rp' | 'and' | 'or' | 'not' | 'phrase' | 'term'; value: string; pos: number };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { out.push({ kind: 'lp', value: c, pos: i++ }); continue; }
    if (c === ')') { out.push({ kind: 'rp', value: c, pos: i++ }); continue; }
    if (c === '"' || c === '“' || c === '”') {
      const start = i++;
      let s = '';
      while (i < src.length && !['"', '“', '”'].includes(src[i]!)) s += src[i++];
      if (i >= src.length) throw new QuerySyntaxError('Unclosed quotation mark', start);
      i++;
      out.push({ kind: 'phrase', value: s, pos: start });
      continue;
    }
    if (c === '-' && (i + 1 < src.length && /[\p{L}\p{N}"(]/u.test(src[i + 1]!))) { out.push({ kind: 'not', value: '-', pos: i++ }); continue; }
    const start = i;
    let s = '';
    while (i < src.length && !/[\s()"“”]/.test(src[i]!)) s += src[i++];
    if (s === 'AND' || s === 'OR' || s === 'NOT') out.push({ kind: s.toLowerCase() as Tok['kind'], value: s, pos: start });
    else out.push({ kind: 'term', value: s, pos: start });
  }
  return out;
}

export function parseQuery(src: string): QueryNode {
  if (src.length > QUERY_LIMITS.maxLength) throw new QuerySyntaxError(`Expression is longer than ${QUERY_LIMITS.maxLength} characters`, QUERY_LIMITS.maxLength);
  const toks = lex(src);
  if (toks.length === 0) throw new QuerySyntaxError('Expression is empty', 0);
  let p = 0; let terms = 0;
  const peek = () => toks[p];
  const fail = (msg: string): never => { throw new QuerySyntaxError(msg, peek()?.pos ?? src.length); };

  const expr = (depth: number): QueryNode => {
    if (depth > QUERY_LIMITS.maxDepth) fail(`Expression is nested more than ${QUERY_LIMITS.maxDepth} levels`);
    const parts = [and(depth)];
    while (peek()?.kind === 'or') { p++; parts.push(and(depth)); }
    return parts.length === 1 ? parts[0]! : { type: 'or', children: parts };
  };
  const and = (depth: number): QueryNode => {
    const parts = [unary(depth)];
    for (;;) {
      const t = peek();
      if (!t || t.kind === 'or' || t.kind === 'rp') break;
      if (t.kind === 'and') { p++; if (!peek() || ['or', 'rp', 'and'].includes(peek()!.kind)) fail('AND must be followed by a term'); }
      parts.push(unary(depth));
    }
    return parts.length === 1 ? parts[0]! : { type: 'and', children: parts };
  };
  const unary = (depth: number): QueryNode => {
    const t = peek();
    if (t?.kind === 'not') { p++; return { type: 'not', child: unary(depth + 1) }; }
    return primary(depth);
  };
  const primary = (depth: number): QueryNode => {
    const t = peek();
    if (!t) return fail('Expression ends unexpectedly');
    if (t.kind === 'lp') {
      p++;
      if (peek()?.kind === 'rp') fail('Empty parentheses');
      const inner = expr(depth + 1);
      if (peek()?.kind !== 'rp') fail('Missing closing parenthesis');
      p++;
      return inner;
    }
    if (t.kind === 'rp') return fail('Unexpected closing parenthesis');
    if (t.kind === 'and' || t.kind === 'or') return fail(`${t.value} needs a term on both sides`);
    p++;
    if (++terms > QUERY_LIMITS.maxTerms) fail(`Expression has more than ${QUERY_LIMITS.maxTerms} terms`);
    if (t.kind === 'phrase') {
      const tokens = tokenize(t.value);
      if (tokens.length === 0) fail('Quoted phrase has no words');
      return tokens.length === 1 ? { type: 'term', value: tokens[0]!, prefix: false } : { type: 'phrase', tokens };
    }
    const prefix = t.value.endsWith('*');
    const tokens = tokenize(prefix ? t.value.slice(0, -1) : t.value);
    if (tokens.length === 0) fail(`"${t.value}" contains no letters or digits`);
    if (prefix && (tokens.length !== 1 || tokens[0]!.length < QUERY_LIMITS.minPrefixLength)) {
      fail(`Wildcard terms need at least ${QUERY_LIMITS.minPrefixLength} characters before *`);
    }
    if (tokens.length > 1) return { type: 'phrase', tokens }; // e.g. hyphenated words: "e-ktp" → phrase e ktp
    return { type: 'term', value: tokens[0]!, prefix };
  };

  const ast = expr(0);
  if (p < toks.length) fail(peek()!.kind === 'rp' ? 'Unexpected closing parenthesis' : 'Unexpected token');
  return ast;
}

/** Pre-tokenised document for fast repeated evaluation. */
export class MatchDocument {
  readonly tokens: string[];
  private readonly set: Set<string>;
  constructor(text: string) { this.tokens = tokenize(text); this.set = new Set(this.tokens); }

  hasTerm(t: string, prefix: boolean): boolean {
    if (!prefix) return this.set.has(t);
    for (const tok of this.set) if (tok.startsWith(t)) return true;
    return false;
  }
  hasPhrase(phrase: string[]): boolean {
    if (phrase.length === 0) return false;
    outer: for (let i = 0; i + phrase.length <= this.tokens.length; i++) {
      for (let j = 0; j < phrase.length; j++) if (this.tokens[i + j] !== phrase[j]) continue outer;
      return true;
    }
    return false;
  }
}

/** Evaluates the AST; `hits` collects the positive terms that matched (for display/explainability). */
export function evaluate(node: QueryNode, doc: MatchDocument, hits?: Set<string>): boolean {
  switch (node.type) {
    case 'term': { const ok = doc.hasTerm(node.value, node.prefix); if (ok) hits?.add(node.prefix ? `${node.value}*` : node.value); return ok; }
    case 'phrase': { const ok = doc.hasPhrase(node.tokens); if (ok) hits?.add(`"${node.tokens.join(' ')}"`); return ok; }
    case 'not': return !evaluate(node.child, doc); // terms under NOT are never reported as hits
    case 'and': { const local = new Set<string>(); const ok = node.children.every((c) => evaluate(c, doc, local)); if (ok) local.forEach((h) => hits?.add(h)); return ok; }
    case 'or': { let any = false; for (const c of node.children) if (evaluate(c, doc, hits)) any = true; return any; }
  }
}

export interface MonitoringQueryDef {
  keywords: string[];
  aliases: string[];
  exclusions: string[];
  booleanExpression: string | null;
  languages: string[];
}

/** A keyword/alias/exclusion entry is a literal word or phrase; operators inside it are not interpreted. */
function literalNode(entry: string): QueryNode | null {
  const tokens = tokenize(entry);
  if (tokens.length === 0) return null;
  return tokens.length === 1 ? { type: 'term', value: tokens[0]!, prefix: false } : { type: 'phrase', tokens };
}

export interface CompiledQuery { match(doc: MatchDocument, language: string | null): { matched: boolean; terms: string[] } }

/**
 * Semantics: (any keyword or alias matches, if any are configured) AND (the Boolean expression holds, if configured)
 * AND (no exclusion matches) AND (language is allowed, if languages are configured; unknown language is allowed so
 * records are not silently dropped).
 */
export function compileQuery(def: MonitoringQueryDef): CompiledQuery {
  const anyOf = [...def.keywords, ...def.aliases].map(literalNode).filter((n): n is QueryNode => !!n);
  const none = def.exclusions.map(literalNode).filter((n): n is QueryNode => !!n);
  const expr = def.booleanExpression?.trim() ? parseQuery(def.booleanExpression) : null;
  if (anyOf.length === 0 && !expr) throw new QuerySyntaxError('A query needs at least one keyword, alias or expression', 0);
  const langs = new Set(def.languages.map((l) => l.toLowerCase()));
  return {
    match(doc, language) {
      if (langs.size && language && !langs.has(language.toLowerCase().slice(0, 2)) && !langs.has(language.toLowerCase())) return { matched: false, terms: [] };
      const hits = new Set<string>();
      if (anyOf.length && !anyOf.map((n) => evaluate(n, doc, hits)).some(Boolean)) return { matched: false, terms: [] };
      if (expr && !evaluate(expr, doc, hits)) return { matched: false, terms: [] };
      if (none.some((n) => evaluate(n, doc))) return { matched: false, terms: [] };
      return { matched: true, terms: [...hits].slice(0, 20) };
    },
  };
}
