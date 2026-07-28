import { describe, expect, it } from 'vitest';
import type { ModelGateway } from '../src/gateway';

describe('ModelGateway interface', () => {
  it('can be implemented with all required methods', () => {
    const gateway: ModelGateway = {
      async streamText(_slot, _messages) {
        return new ReadableStream({ start(controller) { controller.enqueue('Hello'); controller.close(); } });
      },
      async generateText(_slot, _messages, _options?) {
        return { text: 'Hello', toolCalls: [] };
      },
      async testCapabilities(_providerId, _modelId?) {
        return { streaming: true, toolCalling: true, structuredOutput: true };
      },
    };
    expect(gateway).toBeDefined();
  });

  it('generateText returns text without toolCalls when omitted', async () => {
    const gateway: ModelGateway = {
      async streamText(_slot, _messages) {
        return new ReadableStream();
      },
      async generateText(_slot, _messages, _options?) {
        return { text: 'Plain response' };
      },
      async testCapabilities(_providerId, _modelId?) {
        return { streaming: false, toolCalling: false, structuredOutput: false };
      },
    };
    const result = await gateway.generateText('reasoning', [{ role: 'user', content: 'Hi' }]);
    expect(result.text).toBe('Plain response');
    expect(result.toolCalls).toBeUndefined();
  });

  it('streamText returns a readable stream', async () => {
    const gateway: ModelGateway = {
      async streamText(_slot, _messages) {
        const encoder = new TextEncoder();
        return new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('Hello'));
            controller.close();
          },
        });
      },
      async generateText() {
        return { text: '' };
      },
      async testCapabilities() {
        return { streaming: false, toolCalling: false, structuredOutput: false };
      },
    };
    const stream = await gateway.streamText('reasoning', [{ role: 'user', content: 'Hi' }]);
    expect(stream).toBeInstanceOf(ReadableStream);
  });
});
