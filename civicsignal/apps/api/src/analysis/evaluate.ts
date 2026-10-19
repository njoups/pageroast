/** Classification metrics for the evaluation script and regression tests. */
export interface ClassMetrics { label: string; precision: number; recall: number; f1: number; support: number }

export function macroF1(gold: string[], predicted: string[], labels: string[]): { macroF1: number; accuracy: number; perClass: ClassMetrics[]; confusion: Record<string, Record<string, number>> } {
  const confusion: Record<string, Record<string, number>> = {};
  for (const g of labels) confusion[g] = Object.fromEntries([...labels, 'unknown'].map((l) => [l, 0]));
  gold.forEach((g, i) => { const p = predicted[i]!; if (confusion[g]) confusion[g]![p] = (confusion[g]![p] ?? 0) + 1; });
  const perClass = labels.map((l) => {
    const tp = gold.filter((g, i) => g === l && predicted[i] === l).length;
    const fp = gold.filter((g, i) => g !== l && predicted[i] === l).length;
    const fn = gold.filter((g, i) => g === l && predicted[i] !== l).length;
    const precision = tp + fp ? tp / (tp + fp) : 0; const recall = tp + fn ? tp / (tp + fn) : 0;
    return { label: l, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0, support: tp + fn };
  });
  const accuracy = gold.filter((g, i) => g === predicted[i]).length / Math.max(1, gold.length);
  // Macro average over classes present in the gold labels (a class with no examples has undefined recall).
  const present = perClass.filter((c) => c.support > 0);
  return { macroF1: present.reduce((n, c) => n + c.f1, 0) / Math.max(1, present.length), accuracy, perClass, confusion };
}
