# CivicSignal evaluation set (v1)

**Synthetic, hand-labelled by the developer.** Not collected from publishers; any resemblance to real reports is
coincidental. People are unnamed or fictional. Labels are a single annotator's judgement (no inter-annotator agreement).
The set was written before the rule-based lexicons, but by the same person, so baseline scores are optimistic.
See docs/AI_EVALUATION.md for results and limitations.

Fields: `text`, `language` (id | en | ms | jv | und), `sentiment` (positive | negative | neutral | mixed, toward the
`target` when given, else the article overall; absent for non-supported languages), `topic` (taxonomy key or `unknown`), `notes`.

## Held-out set (`holdout-set.json`)

24 further synthetic items, written after the baseline lexicons were frozen and scored once. The lexicons were
**not** adjusted afterwards, and they must not be tuned on this set; otherwise it stops being held out. The author
still knew the lexicons when writing it, so even these numbers are not an unbiased estimate of real-world accuracy.
