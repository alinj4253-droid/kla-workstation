import { describe, expect, it } from 'vitest';
import type { ModelCapability, ModelSlot, ProviderConfig, AgentCapabilityRequirements, GenerateOptions, GenerateResult, ModelMessage } from '../src/types';

describe('ModelCapability type', () => {
  it('accepts valid capabilities as strings', () => {
    const cap: ModelCapability = 'streaming';
    expect(cap).toBe('streaming');
  });

  it('accepts all capability values', () => {
    const values: ModelCapability[] = ['streaming', 'toolCalling', 'structuredOutput'];
    expect(values).toHaveLength(3);
  });
});

describe('ModelSlot type', () => {
  it('accepts reasoning slot', () => {
    const slot: ModelSlot = 'reasoning';
    expect(slot).toBe('reasoning');
  });

  it('accepts fast slot', () => {
    const slot: ModelSlot = 'fast';
    expect(slot).toBe('fast');
  });
});

describe('ProviderConfig type', () => {
  it('accepts valid provider config with optional fields', () => {
    const config: ProviderConfig = {
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4o',
      apiKey: 'sk-xxx',
    };
    expect(config.providerType).toBe('openai');
    expect(config.modelId).toBe('gpt-4o');
  });
});

describe('AgentCapabilityRequirements type', () => {
  it('accepts requirements with required capabilities', () => {
    const req: AgentCapabilityRequirements = {
      requiredCapabilities: ['streaming', 'toolCalling'],
      recommendedCapabilities: ['structuredOutput'],
    };
    expect(req.requiredCapabilities).toHaveLength(2);
    expect(req.recommendedCapabilities).toHaveLength(1);
  });

  it('allows empty recommended capabilities', () => {
    const req: AgentCapabilityRequirements = {
      requiredCapabilities: ['streaming'],
    };
    expect(req.requiredCapabilities).toEqual(['streaming']);
  });
});

describe('GenerateOptions type', () => {
  it('accepts tools option', () => {
    const opts: GenerateOptions = {
      tools: {
        get_weather: {
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    };
    expect(opts.tools?.get_weather.description).toBe('Get weather');
  });

  it('accepts temperature and maxTokens', () => {
    const opts: GenerateOptions = { temperature: 0.7, maxTokens: 4096 };
    expect(opts.temperature).toBe(0.7);
    expect(opts.maxTokens).toBe(4096);
  });
});

describe('GenerateResult type', () => {
  it('accepts result with text only', () => {
    const result: GenerateResult = { text: 'Hello' };
    expect(result.text).toBe('Hello');
    expect(result.toolCalls).toBeUndefined();
  });

  it('accepts result with text and tool calls', () => {
    const result: GenerateResult = {
      text: 'Calling tool',
      toolCalls: [{ name: 'get_weather', args: { city: 'Beijing' }, id: 'call-1' }],
    };
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe('get_weather');
  });
});

describe('ModelMessage type', () => {
  it('accepts system message', () => {
    const msg: ModelMessage = { role: 'system', content: 'You are a helpful assistant.' };
    expect(msg.role).toBe('system');
  });

  it('accepts user message', () => {
    const msg: ModelMessage = { role: 'user', content: 'Hello' };
    expect(msg.role).toBe('user');
  });

  it('accepts assistant message', () => {
    const msg: ModelMessage = { role: 'assistant', content: 'Hi there!' };
    expect(msg.role).toBe('assistant');
  });
});
