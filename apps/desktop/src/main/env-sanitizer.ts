/**
 * 环境变量消毒器
 *
 * 过滤 CLI 认证相关的环境变量，防止应用在 spawn 子进程时
 * 将密钥明文传递给 Codex、Claude Code 等外部 CLI。
 *
 * 覆盖 AC-AGENT-03 运行时要求：认证信息不被应用复制。
 */

/** 已知 CLI 认证环境变量模式列表 */
const CLI_AUTH_ENV_PATTERNS = [
  /^(OPENAI|ANTHROPIC|CODEX|CLAUDE|GEMINI|AI21|COHERE|MISTRAL|DEEPSEEK|TOGETHER|PERPLEXITY|GROQ|FIREWORKS|REPLICATE|HUGGINGFACE)_(API_KEY|API_TOKEN|TOKEN|SECRET|AUTH|KEY)/i,
  /^AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)/,
  /^AZURE_(OPENAI_API_KEY|API_KEY|COGNITIVE_SERVICES_KEY)/,
  /^GOOGLE_(API_KEY|APPLICATION_CREDENTIALS)/,
  /^GITHUB_(TOKEN|PAT)/,
  /^GITLAB_(TOKEN|ACCESS_TOKEN)/,
  /^DIGITALOCEAN_(TOKEN|ACCESS_TOKEN)/,
  /^LINODE_(TOKEN|CLI_TOKEN)/,
  /^VULTR_(API_KEY|API_TOKEN)/,
  /^HEROKU_(API_KEY|API_TOKEN)/,
  /^NETLIFY_(AUTH_TOKEN|ACCESS_TOKEN)/,
  /^VERCEL_(TOKEN|API_TOKEN)/,
  /^CF_(API_KEY|API_TOKEN|EMAIL)/,
  /^DO_API_(TOKEN|KEY)/,
  /^PKR_VAR_/,
  /^TF_VAR_/,
];

/**
 * 从环境变量对象中移除 CLI 认证密钥，返回新的副本。
 * 原始对象不被修改。
 */
export function sanitizeEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    // 跳过 undefined 值
    if (value === undefined) continue;
    // 检查是否匹配已知的 CLI 认证模式
    const matched = CLI_AUTH_ENV_PATTERNS.some((pattern) => pattern.test(key));
    if (matched) {
      // 跳过认证变量 —— 外部 CLI 应自行管理自己的认证
      continue;
    }
    result[key] = value;
  }
  return result;
}

/**
 * 检查给定的环境变量名是否包含 CLI 认证信息。
 * 用于日志消毒和诊断包过滤。
 */
export function isCliAuthEnvVar(name: string): boolean {
  return CLI_AUTH_ENV_PATTERNS.some((pattern) => pattern.test(name));
}