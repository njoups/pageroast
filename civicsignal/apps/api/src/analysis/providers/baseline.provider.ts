import { analyzeBaseline, BASELINE_MODEL, BASELINE_VERSION } from '../baseline';
import type { AnalysisProvider, ArticleInput } from './provider';
import { NO_USAGE } from './provider';

export class BaselineProvider implements AnalysisProvider {
  readonly name = 'baseline';
  readonly model = BASELINE_MODEL;
  readonly method = 'baseline' as const;

  async analyzeArticle(input: ArticleInput) {
    return { output: analyzeBaseline(input), usage: NO_USAGE, model: this.model, promptVersion: BASELINE_VERSION };
  }
  async summarize() { return null; }
}
