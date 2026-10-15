// 中文枚举值容错：模型在自然语言场景常把枚举参数写成中文（如「年报」「职责」）。
// 精确匹配优先、包含匹配兜底；都未命中时原样返回，交由 z.enum 报错（错误会附可选值）。
export const cnAlias = (aliases: Record<string, string>) => (v: unknown) => {
  if (typeof v === 'string') {
    const key = v.trim().toLowerCase();
    if (key in aliases) return aliases[key];
    for (const [alias, target] of Object.entries(aliases)) if (key.includes(alias)) return target;
  }
  return v;
};
