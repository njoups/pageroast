import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { fmtDate, fmtNum, type Block, type ReportModel } from './templates';

/**
 * PDF rendering with pdfkit and the vendored Liberation Sans fonts (SIL OFL; full Latin coverage for Indonesian and
 * English). Layout: cover page, section hierarchy, KPI tiles, tables, vector charts, numbered source list, methodology,
 * limitations and attribution; header and "page x of y" footer with the generation timestamp on every content page.
 * All text comes from the report model and is drawn as text (never interpreted as markup or links except source URLs).
 */
const FONTS = join(__dirname, '..', '..', 'assets', 'fonts');
const A4 = { w: 595.28, h: 841.89 };
const M = 56;
const INK = '#1f2328'; const MUTED = '#59636e'; const RULE = '#d1d9e0'; const SERIES = '#2a78d6'; const ZEBRA = '#f6f8fa';
const KIND_LABEL = {
  id: { metric: 'Metrik terhitung', source_fact: 'Fakta sumber', ai_interpretation: 'Interpretasi AI', analyst_recommendation: 'Rekomendasi analis', note: 'Catatan' },
  en: { metric: 'Calculated metric', source_fact: 'Source fact', ai_interpretation: 'AI interpretation', analyst_recommendation: 'Analyst recommendation', note: 'Note' },
} as const;
const KIND_COLOR = { metric: '#2a78d6', source_fact: '#1a7f37', ai_interpretation: '#8250df', analyst_recommendation: '#9a6700', note: MUTED } as const;

/** Removes control characters (except newline) so untrusted text cannot disrupt layout. */
// eslint-disable-next-line no-control-regex
const clean = (s: unknown, max = 2000) => String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, ' ').slice(0, max);
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : null);

export function renderPdf(model: ReportModel): Promise<Buffer> {
  const lang = model.language;
  const doc = new PDFDocument({ size: 'A4', margins: { top: M + 14, bottom: M + 10, left: M, right: M }, bufferPages: true, autoFirstPage: false,
    info: { Title: clean(model.title, 200), Subject: clean(model.subtitle, 200), Author: clean(model.organization, 200), Creator: 'CivicSignal Intelligence', Producer: 'CivicSignal Intelligence' }, lang: lang === 'id' ? 'id-ID' : 'en-GB' });
  doc.registerFont('R', join(FONTS, 'LiberationSans-Regular.ttf'));
  doc.registerFont('B', join(FONTS, 'LiberationSans-Bold.ttf'));
  doc.registerFont('I', join(FONTS, 'LiberationSans-Italic.ttf'));
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const brand = /^#[0-9a-fA-F]{6}$/.test(model.brandColor) ? model.brandColor : SERIES;
  const W = A4.w - 2 * M;
  const bottom = () => A4.h - M - 10;
  const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };

  // ── Cover ──
  doc.addPage({ margins: { top: M, bottom: M, left: M, right: M } });
  doc.rect(0, 0, A4.w, 150).fill(brand);
  doc.fillColor('#ffffff').font('B').fontSize(11).text(clean(model.organization, 120), M, 56, { width: W });
  doc.font('R').fontSize(10).text(clean(model.subtitle, 120), M, 76, { width: W });
  doc.fillColor(INK).font('B').fontSize(26).text(clean(model.title, 160), M, 200, { width: W });
  doc.moveDown(0.6).font('R').fontSize(13).fillColor(MUTED).text(clean(model.project, 160), { width: W });
  doc.moveDown(2);
  const row = (k: string, v: string) => { doc.font('B').fontSize(10).fillColor(MUTED).text(k, { continued: false }); doc.font('R').fontSize(12).fillColor(INK).text(v); doc.moveDown(0.6); };
  row(lang === 'id' ? 'Periode' : 'Period', `${model.period.label} (${model.period.timezone})`);
  row(lang === 'id' ? 'Dibuat' : 'Generated', `${fmtDate(model.generatedAt, model.period.timezone, lang, true)} (${model.period.timezone})`);
  row(lang === 'id' ? 'Templat' : 'Template', model.templateVersion);
  doc.page.margins.bottom = 0;     // the note sits in the bottom margin; never let it open a new page
  doc.font('I').fontSize(9).fillColor(MUTED).text(lang === 'id'
    ? 'Rahasia — untuk penggunaan internal organisasi. Angka dihitung dari data media yang dikumpulkan; lihat Metodologi dan Keterbatasan.'
    : 'Confidential — for internal use by the organisation. Figures are computed from collected media data; see Methodology and Limitations.', M, A4.h - M - 40, { width: W });

  // ── Content ──
  doc.addPage();
  const h1 = (t: string) => { ensure(60); doc.moveDown(0.4).font('B').fontSize(16).fillColor(INK).text(clean(t, 200), M, doc.y, { width: W }); const y = doc.y + 3; doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1).strokeColor(brand).stroke(); doc.y = y + 8; };
  const h2 = (t: string) => { ensure(40); doc.moveDown(0.3).font('B').fontSize(11.5).fillColor(INK).text(clean(t, 200), M, doc.y, { width: W }); doc.moveDown(0.3); };
  const para = (t: string, o: { font?: string; size?: number; color?: string } = {}) => { doc.font(o.font ?? 'R').fontSize(o.size ?? 10).fillColor(o.color ?? INK); ensure(doc.heightOfString(t, { width: W }) + 6); doc.text(clean(t), M, doc.y, { width: W, lineGap: 1.5 }); doc.moveDown(0.5); };

  const block = (b: Block) => {
    if (b.type === 'paragraph') {
      const label = KIND_LABEL[lang][b.kind];
      const refs = b.refs?.length ? ` [${b.refs.join(', ')}]` : '';
      const text = clean(b.text) + refs + (b.attribution ? ` — ${clean(b.attribution, 200)}` : '');
      doc.font('B').fontSize(7.5); const lh = doc.heightOfString(label.toUpperCase());
      doc.font(b.kind === 'ai_interpretation' ? 'I' : 'R').fontSize(10);
      ensure(lh + doc.heightOfString(text, { width: W - 10 }) + 10);
      const y0 = doc.y;
      doc.font('B').fontSize(7.5).fillColor(KIND_COLOR[b.kind]).text(label.toUpperCase(), M + 8, y0, { width: W - 8, characterSpacing: 0.4 });
      doc.font(b.kind === 'ai_interpretation' ? 'I' : 'R').fontSize(10).fillColor(INK).text(text, M + 8, doc.y + 1, { width: W - 8, lineGap: 1.5 });
      doc.rect(M, y0, 2.5, doc.y - y0).fill(KIND_COLOR[b.kind]);
      doc.moveDown(0.6);
    } else if (b.type === 'kpis') {
      const per = 3; const gap = 8; const bw = (W - gap * (per - 1)) / per; const bh = 54;
      for (let i = 0; i < b.items.length; i += per) {
        ensure(bh + gap); const y = doc.y;
        b.items.slice(i, i + per).forEach((it, j) => {
          const x = M + j * (bw + gap);
          doc.roundedRect(x, y, bw, bh, 4).lineWidth(0.8).strokeColor(RULE).stroke();
          doc.font('R').fontSize(8).fillColor(MUTED).text(clean(it.label, 80), x + 8, y + 7, { width: bw - 16, lineBreak: false, ellipsis: true });
          doc.font('B').fontSize(15).fillColor(INK).text(clean(it.value, 40), x + 8, y + 19, { width: bw - 16, lineBreak: false });
          if (it.detail) doc.font('R').fontSize(7).fillColor(MUTED).text(clean(it.detail, 80), x + 8, y + 39, { width: bw - 16, lineBreak: false, ellipsis: true });
        });
        doc.y = y + bh + gap;
      }
      doc.x = M; doc.moveDown(0.3);
    } else if (b.type === 'table') {
      h2(b.title);
      const cols = b.columns.length;
      const first = cols > 2 ? W * 0.42 : W * 0.6;
      const widths = b.columns.map((_, i) => (i === 0 ? first : (W - first) / (cols - 1)));
      const drawRow = (cells: Array<string | number>, header: boolean, zebra: boolean) => {
        doc.font(header ? 'B' : 'R').fontSize(8.5);
        const hs = cells.map((c, i) => doc.heightOfString(clean(c, 300), { width: widths[i]! - 8 }));
        const h = Math.max(...hs) + 8;
        if (doc.y + h > bottom()) { doc.addPage(); if (!header) drawRow(b.columns, true, false); }
        const y = doc.y;
        if (header) doc.rect(M, y, W, h).fill('#eef2f6'); else if (zebra) doc.rect(M, y, W, h).fill(ZEBRA);
        let x = M;
        cells.forEach((c, i) => {
          const right = b.numeric?.includes(i);
          doc.font(header ? 'B' : 'R').fontSize(8.5).fillColor(INK).text(clean(c, 300), x + 4, y + 4, { width: widths[i]! - 8, align: right ? 'right' : 'left' });
          x += widths[i]!;
        });
        doc.y = y + h; doc.x = M;
      };
      if (!b.rows.length) { para(lang === 'id' ? 'Tidak ada data pada periode ini.' : 'No data in this period.', { color: MUTED }); return; }
      drawRow(b.columns, true, false);
      b.rows.forEach((r, i) => drawRow(r, false, i % 2 === 1));
      doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.moveDown(0.4);
      if (b.note) para(b.note, { size: 8, color: MUTED });
    } else if (b.type === 'bar') {
      h2(b.title);
      const max = Math.max(1, ...b.points.map((p) => p.value)); const labelW = W * 0.32; const barW = W - labelW - 60; const rh = 16;
      ensure(b.points.length * rh + 10);
      for (const p of b.points) {
        ensure(rh); const y = doc.y;
        doc.font('R').fontSize(8.5).fillColor(INK).text(clean(p.label, 80), M, y + 3, { width: labelW - 6, lineBreak: false, ellipsis: true });
        const w = Math.max(p.value > 0 ? 1 : 0, (p.value / max) * barW);
        doc.rect(M + labelW, y + 3, w, rh - 6).fill(SERIES);
        doc.font('R').fontSize(8.5).fillColor(INK).text(`${fmtNum(p.value, lang, 1)}${b.unit}`, M + labelW + w + 4, y + 3, { width: 56, lineBreak: false });
        doc.y = y + rh;
      }
      doc.x = M; doc.moveDown(0.5);
    } else if (b.type === 'columns') {
      h2(b.title);
      const ch = 120; ensure(ch + 30);
      const y0 = doc.y; const max = Math.max(1, ...b.points.map((p) => p.value)); const nPts = Math.max(1, b.points.length);
      const slot = W / nPts; const cw = Math.max(1, Math.min(24, slot - 2));
      doc.moveTo(M, y0 + ch).lineTo(M + W, y0 + ch).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.font('R').fontSize(7).fillColor(MUTED).text(`${fmtNum(max, lang)}`, M, y0 - 2, { width: 60 });
      const every = Math.ceil(nPts / 12);
      b.points.forEach((p, i) => {
        const h = (p.value / max) * (ch - 12); const x = M + i * slot + (slot - cw) / 2;
        if (h > 0) doc.rect(x, y0 + ch - h, cw, h).fill(SERIES);
        if (i % every === 0) doc.font('R').fontSize(6.5).fillColor(MUTED).text(clean(p.label, 12), M + i * slot - 6, y0 + ch + 3, { width: slot + 12, align: 'center', lineBreak: false });
      });
      doc.y = y0 + ch + 16; doc.x = M;
      const total = b.points.reduce((a, p) => a + p.value, 0);
      para(`${b.metric}: ${fmtNum(total, lang)} (${b.points.length} ${lang === 'id' ? 'periode' : 'buckets'}; ${lang === 'id' ? 'maks.' : 'max'} ${fmtNum(max, lang)})`, { size: 8, color: MUTED });
    } else if (b.type === 'sources') {
      for (const s of b.items) {
        const line1 = `${s.ref}  ${clean(s.publisher, 120)}${s.publishedAt ? ` · ${fmtDate(s.publishedAt, model.period.timezone, lang)}` : ''}`;
        const title = clean(s.title, 400); const url = safeUrl(s.url);
        doc.font('R').fontSize(9); ensure(doc.heightOfString(title, { width: W - 20 }) + 30);
        doc.font('B').fontSize(8).fillColor(MUTED).text(line1, M, doc.y, { width: W });
        doc.font('R').fontSize(9.5).fillColor(INK).text(`“${title}”`, M + 12, doc.y, { width: W - 12 });
        if (url) doc.font('R').fontSize(7.5).fillColor(SERIES).text(clean(url, 300), M + 12, doc.y, { width: W - 12, link: url, underline: false });
        doc.moveDown(0.4);
      }
    }
  };

  for (const s of model.sections) { h1(s.title); for (const b of s.blocks) block(b); }
  h1(lang === 'id' ? 'Metodologi' : 'Methodology');
  for (const m of model.methodology) para(`• ${m}`, { size: 9 });
  h1(lang === 'id' ? 'Keterbatasan' : 'Limitations');
  for (const m of model.limitations) para(`• ${m}`, { size: 9 });
  if (model.ai.requested) para(lang === 'id'
    ? `Komentar AI: metode ${model.ai.method}; ${model.ai.kept} klaim lolos validasi, ${model.ai.dropped.length} dihapus.`
    : `AI commentary: method ${model.ai.method}; ${model.ai.kept} claim(s) passed validation, ${model.ai.dropped.length} removed.`, { size: 9, color: MUTED });
  h1(lang === 'id' ? 'Atribusi sumber' : 'Source attribution');
  para(lang === 'id' ? 'Judul dan tautan milik penerbit masing-masing. Laporan ini tidak memuat teks lengkap artikel.' : 'Headlines and links belong to their publishers. This report does not reproduce full article text.', { size: 9 });
  for (const a of model.attribution) para(`• ${a}`, { size: 8.5, color: MUTED });

  // ── Header/footer on content pages ──
  const range = doc.bufferedPageRange();
  const stamp = `${fmtDate(model.generatedAt, model.period.timezone, lang, true)} ${model.period.timezone}`;
  for (let i = 1; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const oldBottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;
    doc.font('R').fontSize(7.5).fillColor(MUTED);
    doc.text(`${clean(model.organization, 80)} · ${clean(model.title, 100)} · ${model.period.label}`, M, 28, { width: W, lineBreak: false, ellipsis: true });
    doc.moveTo(M, 42).lineTo(M + W, 42).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.text(`${lang === 'id' ? 'Dibuat' : 'Generated'} ${stamp}`, M, A4.h - 36, { width: W / 2, lineBreak: false });
    doc.text(`${lang === 'id' ? 'Halaman' : 'Page'} ${i + 1} ${lang === 'id' ? 'dari' : 'of'} ${range.count}`, M + W / 2, A4.h - 36, { width: W / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = oldBottom;
  }
  doc.end();
  return done;
}
