export type ModelCapability = 'streaming' | 'toolCalling' | 'structuredOutput' | 'vision' | 'embeddings';

export type ModelSlot = 'reasoning' | 'fast' | 'embedding';

export type ProviderType = 'openai' | 'openai-compatible' | 'anthropic' | 'google';

export type ModelMessageRole = 'system' | 'user' | 'assistant';

export interface ModelMessage {
  role: ModelMessageRole;
  content: string;
}

export interface ProviderConfig {
  providerType: ProviderType;
  baseUrl?: string;
  apiKey?: string;
}

export interface CapabilityTestResults {
  streaming: boolean;
  toolCalling: boolean;
  structuredOutput: boolean;
}

export interface GenerateOptions {
  tools?: Record<string, { description: string; parameters: Record<string, unknown> }>;
  /** Per-call reasoning override for lightweight routing/planning calls. */
  thinking?: boolean;
  thinkingLevel?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  /** Bounds coordination JSON and summaries without changing the mounted model. */
  maxOutputTokens?: number;
}

export interface GenerateResult {
  text: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

export type LanguageModelProviderFactory = (config: ProviderConfig) => (modelId: string) => unknown;
