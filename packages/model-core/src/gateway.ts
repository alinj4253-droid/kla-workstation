import type { ModelSlot, ModelMessage, GenerateOptions, GenerateResult, CapabilityTestResults, ProviderConfig } from './types.js';

/** 流式生成可选项：系统提示、输出上限与取消信号。 */
export interface ModelGatewayStreamOptions {
  system?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ModelGateway {
  streamText(slot: ModelSlot, messages: ModelMessage[], options?: ModelGatewayStreamOptions): Promise<ReadableStream<string>>;

  generateText(
    slot: ModelSlot,
    messages: ModelMessage[],
    options?: GenerateOptions,
  ): Promise<GenerateResult>;

  generateObject<T>(slot: ModelSlot, messages: ModelMessage[]): Promise<T>;

  testCapabilities(
    providerConfig: ProviderConfig,
    modelId: string,
    signal?: AbortSignal,
  ): Promise<CapabilityTestResults>;
}
