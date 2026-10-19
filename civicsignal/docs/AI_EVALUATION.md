# AI evaluation

How well the analysis performs, on what data, and the limits of those numbers. Reproduce with `npm run eval:ai -w apps/api`.
It writes `docs/eval/ai-eval-<method>-<set>.json`. Run `npm run eval:ai -w apps/api -- --llm` to also evaluate the
configured AI model; this needs `ANTHROPIC_API_KEY` and spends tokens.

**Only the rule-based baseline has been evaluated.** No API key was available, so there are no AI-model results. Do not assume
the model is better or worse until it has been measured on these sets.

## Datasets
| Set | File | Items | Use |
|---|---|---|---|
| Development | `apps/api/test/fixtures/eval/eval-set.json` | 63 (26 id, 25 en, 4 ms, 2 jv, 6 other or undetermined incl. zh, ar, ko, fr) | Written before the baseline lexicons, then **used while building them**. In-sample. |
| Held-out | `apps/api/test/fixtures/eval/holdout-set.json` | 24 (12 id, 10 en, 1 ms, 1 fr) | Written after the lexicons were frozen; scored once; **must not be used for tuning**. |
| Live headlines (language only) | dev database, 153 real headlines from ANTARA and CNN Indonesia | 153 | Split by record id into two halves: one was used to check the detector change, the other was scored once. |

All labelled items are synthetic, written and labelled by one person (the developer), who also wrote the lexicons. There is
no inter-annotator agreement. People in the items are unnamed or fictional.

## Results: rule-based baseline (`civicsignal-baseline`, 2026-10-19)

| Task | Development set (in-sample) | **Held-out set** |
|---|---|---|
| Language identification, accuracy | 100.0 % (63/63) | 100.0 % (24/24) |
| Article sentiment, accuracy / macro-F1 | 86.3 % / 79.0 % | **40.9 % / 28.2 %** |
| Primary topic, accuracy / macro-F1 | 96.1 % / 92.9 % | **77.3 % / 77.7 %** |

Held-out sentiment, per class (precision / recall / F1, %): positive 33.3 / 20.0 / 25.0 (n=5) · negative 40.0 / 25.0 / 30.8 (n=8) ·
neutral 42.9 / 85.7 / 57.1 (n=7) · mixed 0 / 0 / 0 (n=2).

Held-out topic, weakest classes: public_safety 0 % recall (n=2), economy and corporate_reputation 50 % recall, technology 50 %.
The full per-class tables are in the JSON files.

**Live headlines, language detection** (all three sources are Indonesian-language publishers, so the label is Indonesian for every item):
| Detector | Half used to check the change (80) | Half scored once (73) |
|---|---|---|
| lexical-profile/1 | 61 id, 19 undetermined | 55 id, 18 undetermined |
| lexical-profile/2 (headline vocabulary) | 78 id, 2 undetermined | **70 id, 3 undetermined** |

No headline was labelled as a wrong language in either version. Errors are "undetermined", so the record is skipped
rather than analysed under a wrong assumption.

## How to read these numbers
- **The baseline's sentiment is weak.** On text it was not tuned on, it is right about 4 times in 10 and mostly defaults to
  "neutral". The product treats it accordingly: every baseline tone below 0.6 confidence is marked *uncertain* (in practice,
  all of them on live data). The Analytics page shows a warning whenever baseline results are included. Tone figures from the
  baseline must not be reported as findings.
- **Topic classification generalises better** (~77 % held-out), but still misses categories whose wording differs from its cue lists.
- **Development-set scores are optimistic by construction** (the same author wrote the items and the rules, and tuned on them).
  The held-out numbers are the better estimate, and they are biased too, because the author knew the rules.
- **The sets are tiny.** With 22 sentiment items, one item moves accuracy by ~4.5 points. Treat differences under ~10 points as noise.
- **Not measured:** entity extraction precision/recall, summary faithfulness, story-clustering quality, and performance on full
  article bodies (live sources supply headlines only).

## Changes made because of evaluation (disclosed)
1. Malay vs Indonesian: the first detector labelled some Malay as Indonesian. A Malay rule (distinctive spellings, vetoed by
   Indonesian-only spellings) was added **using the development set** (60 → 62 of 63).
2. During integration testing, a longer Malay text was still labelled Indonesian. Rule: two or more distinct strong Malay
   spellings decide Malay. This came from a test case, not from either evaluation set.
3. Live headlines: 14 % of real Indonesian headlines were "undetermined", because headlines lack function words. A general
   Indonesian news-headline vocabulary was added (lexical-profile/2). It was checked on one half of the live headlines and
   reported on the other. To keep the Malay rule unchanged, it counts only after the Malay decision. Records analysed with
   the earlier detector show as *stale* and were re-analysed.

## What a production evaluation needs
A larger set (≥ 300 items per language) of real, licensed coverage, labelled independently by at least two annotators with
agreement measured; per-target (entity) sentiment labels; entity and summary-faithfulness checks; and an evaluation of the
configured AI model on the same sets before it is enabled for customers.
