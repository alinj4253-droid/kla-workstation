import { uploadSliceNameKey, uploadNameCheckResultSchema } from '@kla-workstation/contracts/knowledge';

export async function planUploadNames(
  names: string[], reserved: string[], check: (names: string[]) => Promise<unknown>,
): Promise<string[]> {
  const occupied = new Set(reserved.map(uploadSliceNameKey));
  const numbers = names.map(() => 0);
  const candidate = (index: number) => {
    const name = names[index]!;
    if (!numbers[index]) return name;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const suffix = `（${numbers[index]}）`;
    const characters = Array.from(stem);
    while (new TextEncoder().encode(characters.join('') + suffix + ext).length > 255) characters.pop();
    return characters.join('') + suffix + ext;
  };
  for (let round = 0; round < 100; round++) {
    const batchKeys = new Set(occupied);
    const proposed = names.map((_, index) => {
      let value = candidate(index);
      while (batchKeys.has(uploadSliceNameKey(value))) {
        numbers[index] = numbers[index]! + 1;
        if (numbers[index]! > 10000) throw new Error('同名文件过多，请缩短或调整文件名后重试。');
        value = candidate(index);
      }
      batchKeys.add(uploadSliceNameKey(value));
      return value;
    });
    const conflicts = new Set<string>();
    for (let start = 0; start < proposed.length; start += 200) {
      const chunk = proposed.slice(start, start + 200);
      const result = uploadNameCheckResultSchema.parse(await check(chunk));
      if (result.conflicts.some(name => !chunk.includes(name))) throw new Error('名称检查返回异常，请重试。');
      result.conflicts.forEach(name => conflicts.add(name));
    }
    if (!conflicts.size) return proposed;
    proposed.forEach((name, index) => { if (conflicts.has(name)) numbers[index] = numbers[index]! + 1; });
  }
  throw new Error('暂时无法找到可用名称，请调整文件名或重试。');
}
