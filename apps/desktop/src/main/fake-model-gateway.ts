import { ModelGateway, type ModelSlot } from './model-gateway';

const FAKE_DEFAULT = '收到你的消息。我是统筹智能体，正在分析你的需求。如果需要查阅知识库，我会协调知识管理员协助。';

const FAKE_RESPONSES: Record<string, string> = {
  '你好': '你好！我是鲲擎智能体，有什么可以帮你的吗？',
};

function getFakeResponse(input: string): string {
  for (const [key, value] of Object.entries(FAKE_RESPONSES)) {
    if (input.includes(key)) return value;
  }
  return FAKE_DEFAULT;
}

/**
 * FakeModelGateway — 用于测试的虚拟 ModelGateway
 *
 * 不发起真实 HTTP 请求，返回确定性响应。
 * 继承自 ModelGateway 以复用槽位解析逻辑，仅覆盖流式/生成方法。
 */
export class FakeModelGateway extends ModelGateway {
  async streamText(slot: ModelSlot, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<ReadableStream<string>> {
    const profile = (this as any).getSlotProfile(slot) as { providerType: string; modelId: string } | null;
    if (!profile) throw new Error(`没有为槽位 "${slot}" 配置可用的模型`);

    const userMessage = messages.find((m) => m.role === 'user')?.content ?? '';
    const text = getFakeResponse(userMessage);
    let index = 0;

    return new ReadableStream<string>({
      pull(controller) {
        if (index < text.length) {
          const chunk = text.slice(index, index + 5);
          index += 5;
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
    });
  }

  async generateText(
    slot: ModelSlot,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    _options?: { tools?: Record<string, { description: string; parameters: Record<string, unknown> }> },
  ): Promise<{ text: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }> {
    const profile = (this as any).getSlotProfile(slot) as { providerType: string; modelId: string } | null;
    if (!profile) throw new Error(`没有为槽位 "${slot}" 配置可用的模型`);

    const userMessage = messages.find((m) => m.role === 'user')?.content ?? '';
    return { text: getFakeResponse(userMessage) };
  }

  async generateObject<T>(_slot: ModelSlot, _messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<T> {
    return { result: 'fake' } as unknown as T;
  }

  async testCapabilities(_providerId: string): Promise<{ streaming: boolean; toolCalling: boolean; structuredOutput: boolean }> {
    return { streaming: true, toolCalling: true, structuredOutput: true };
  }
}