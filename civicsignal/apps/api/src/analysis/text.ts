import { tokenize } from '../ingestion/query';

export { tokenize };

/** Lowercase, accent-free, punctuation-free form used for entity and alias identity. */
export function normalizeName(s: string): string {
  return tokenize(s).join(' ');
}

export const STOPWORDS = new Set([
  // Indonesian
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'ini', 'itu', 'tidak', 'akan', 'pada', 'adalah', 'dalam', 'oleh', 'juga',
  'karena', 'sudah', 'bisa', 'ada', 'para', 'terhadap', 'kepada', 'serta', 'atau', 'belum', 'lebih', 'bagi', 'saat', 'kini', 'hingga',
  'namun', 'tetapi', 'soal', 'usai', 'jadi', 'kata', 'menjadi', 'telah', 'masih', 'harus', 'sejak', 'antara', 'setelah', 'bahwa', 'akibat',
  'se', 'pun', 'lagi', 'agar', 'yakni', 'ia', 'mereka', 'kami', 'kita', 'tak', 'bakal', 'sebut', 'jelang', 'atas', 'via',
  // English
  'the', 'and', 'of', 'to', 'in', 'is', 'for', 'on', 'with', 'that', 'by', 'as', 'at', 'from', 'has', 'have', 'will', 'are', 'was', 'were',
  'be', 'it', 'an', 'a', 'this', 'its', 'their', 'but', 'not', 'than', 'been', 'which', 'who', 'after', 'over', 'into', 'about', 'says', 'said',
]);

/** Tokens that carry meaning for similarity (stopwords and 1–2 character tokens removed). */
export const significantTokens = (text: string): string[] => tokenize(text).filter((t) => t.length > 2 && !STOPWORDS.has(t));

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Splits text into sentences without breaking common Indonesian/English abbreviations. */
export function sentences(text: string): string[] {
  return text.replace(/\s+/g, ' ').trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((s) => s.trim()).filter(Boolean);
}
