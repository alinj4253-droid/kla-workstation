import type { ModelSlot, ModelMessage, GenerateOptions, GenerateResult, CapabilityTestResults, ProviderConfig } from './types.js';

export interface ModelGateway {
  streamText(slot: ModelSlot, messages: ModelMessage[]): Promise<ReadableStream<string>>;

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
