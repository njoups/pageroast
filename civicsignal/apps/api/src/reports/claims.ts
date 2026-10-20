/**
 * Validation of AI commentary before it can appear in a report (docs/REPORT_TEMPLATES.md, "AI commentary").
 * Commentary is optional and never authoritative. A claim is kept only if:
 *  - it cites at least one record that the report itself cites (refs already mapped by sanitizeMultiSummary);
 *  - every number in it is one of the report's calculated metric values or appears in a cited record's text;
 *  - it contains no causal assertion, no claim about public opinion or programme effectiveness, and no forecast;
 *  - any quotation in it occurs verbatim in a cited record.
 */
export interface CommentaryClaim { text: string; kind: string; supportingMentionIds: string[] }
export interface ClaimCheck { kept: CommentaryClaim[]; dropped: Array<{ text: string; reason: string }> }

const CAUSAL = /\b(because|due to|caused?|causing|leads? to|led to|result(?:s|ed)? in|as a result|thanks to|karena|akibat|menyebabkan|disebabkan|sehingga|berdampak|mengakibatkan|dampak dari)\b/i;
const OPINION = /\b(public opinion|the public (?:believes?|thinks?|supports?|feels?|wants?)|people (?:believe|think|support|feel)|citizens? (?:believe|think|support|feel)|approval rating|opini publik|masyarakat (?:menilai|mendukung|percaya|merasa|menginginkan)|warga (?:menilai|mendukung|percaya|merasa)|kepuasan publik)\b/i;
const EFFECT = /\b(effective(?:ness)?|ineffective|successful(?:ly)?|succeeded|failed policy|efektif|efektivitas|berhasil|keberhasilan|gagal)\b/i;
const FORECAST = /\b(will (?:likely |probably )?(?:increase|decrease|rise|fall|continue|escalate)|is expected to|akan (?:meningkat|menurun|terus|berlanjut)|diperkirakan akan|diprediksi)\b/i;
const QUOTE = /[“"«]([^”"»]{4,300})[”"»]/g;

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Normalises numeric tokens: "1.234" / "1,234" → "1234"; "12,5" → "12.5"; trailing % ignored. */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d[\d.,]*/g)) {
    let t = m[0].replace(/[.,]$/, '');
    if (/^\d{1,3}([.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, '');          // thousands separators
    else t = t.replace(',', '.');
    const v = Number(t);
    if (Number.isFinite(v)) out.push(String(v));
  }
  return out;
}

export function allowedNumberSet(metrics: Record<string, number | null | undefined>, extraTexts: string[] = []): Set<string> {
  const s = new Set<string>();
  for (const v of Object.values(metrics)) if (typeof v === 'number' && Number.isFinite(v)) { s.add(String(v)); s.add(String(Math.round(v))); s.add(String(Math.round(v * 10) / 10)); }
  for (const t of extraTexts) for (const x of numbersIn(t)) s.add(x);
  return s;
}

export function validateCommentary(claims: CommentaryClaim[], o: { citedIds: Set<string>; metrics: Record<string, number | null | undefined>; recordTexts: Map<string, string> }): ClaimCheck {
  const kept: CommentaryClaim[] = []; const dropped: ClaimCheck['dropped'] = [];
  for (const c of claims) {
    const text = c.text.trim();
    const refs = c.supportingMentionIds.filter((id) => o.citedIds.has(id));
    const cited = refs.map((id) => o.recordTexts.get(id) ?? '');
    const allowed = allowedNumberSet(o.metrics, cited);
    let reason: string | null = null;
    if (!text) reason = 'empty';
    else if (!refs.length) reason = 'no_valid_reference';
    else if (CAUSAL.test(text)) reason = 'causal_claim';
    else if (OPINION.test(text)) reason = 'public_opinion_claim';
    else if (EFFECT.test(text)) reason = 'effectiveness_claim';
    else if (FORECAST.test(text)) reason = 'forecast';
    else if (numbersIn(text).some((x) => !allowed.has(x))) reason = 'unsupported_number';
    else {
      for (const q of text.matchAll(QUOTE)) if (!cited.some((t) => norm(t).includes(norm(q[1]!)))) { reason = 'unverified_quotation'; break; }
    }
    if (reason) dropped.push({ text: text.slice(0, 300), reason });
    else kept.push({ ...c, text, supportingMentionIds: refs });
  }
  return { kept, dropped };
}
