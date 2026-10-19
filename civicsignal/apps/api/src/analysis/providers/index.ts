import type { AppConfig } from '../../config';
import { AnthropicProvider } from './anthropic.provider';
import { BaselineProvider } from './baseline.provider';
import type { AnalysisProvider } from './provider';
import { TestProvider } from './test.provider';

export const ANALYSIS_PROVIDER = Symbol('ANALYSIS_PROVIDER');
export const FALLBACK_PROVIDER = Symbol('FALLBACK_PROVIDER');

export function createProvider(config: AppConfig): AnalysisProvider {
  switch (config.ai.provider) {
    case 'test': return new TestProvider();
    case 'anthropic':
      if (!config.ai.anthropicApiKey) return new BaselineProvider();   // dev convenience; production config refuses this
      return new AnthropicProvider({
        apiKey: config.ai.anthropicApiKey, model: config.ai.model, effort: config.ai.effort, timeoutMs: config.ai.timeoutMs,
        baseURL: config.ai.anthropicBaseUrl, refusalFallback: config.ai.refusalFallback,
      });
    default: return new BaselineProvider();
  }
}

export { BaselineProvider, TestProvider, AnthropicProvider };
export type { AnalysisProvider };
