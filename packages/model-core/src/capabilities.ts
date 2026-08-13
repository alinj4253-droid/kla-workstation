import type { ModelCapability } from './types.js';

export interface AgentCapabilityRequirements {
  definitionId: string;
  requiredCapabilities: ModelCapability[];
}

export const BUILTIN_AGENT_REQUIREMENTS: AgentCapabilityRequirements[] = [
  {
    definitionId: 'builtin.orchestrator',
    requiredCapabilities: ['streaming', 'toolCalling', 'structuredOutput'],
  },
  {
    definitionId: 'builtin.knowledge-manager',
    requiredCapabilities: ['streaming', 'structuredOutput'],
  },
  {
    definitionId: 'builtin.researcher',
    requiredCapabilities: ['streaming', 'structuredOutput'],
  },
  {
    definitionId: 'builtin.material-writer',
    requiredCapabilities: ['streaming', 'toolCalling', 'structuredOutput'],
  },
  {
    definitionId: 'builtin.acceptance-reviewer',
    requiredCapabilities: ['streaming', 'toolCalling', 'structuredOutput'],
  },
];

export function validateModelForAgent(
  definitionId: string,
  verifiedCapabilities: ModelCapability[],
): { allowed: boolean; reason?: string } {
  const req = BUILTIN_AGENT_REQUIREMENTS.find((r) => r.definitionId === definitionId);
  if (!req) {
    return { allowed: true };
  }

  const missing = req.requiredCapabilities.filter((cap) => !verifiedCapabilities.includes(cap));
  if (missing.length > 0) {
    return {
      allowed: false,
      reason: `模型缺少必要能力: ${missing.join(', ')}。智能体 ${definitionId} 需要: ${req.requiredCapabilities.join(', ')}`,
    };
  }

  return { allowed: true };
}
