import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..', '..');

const output = execSync('pnpm licenses list --json', { cwd: root, encoding: 'utf8' });
const data = JSON.parse(output);

const lines = [
  '# Third-Party Licenses',
  '',
  '鲲擎多智能体集成工作站 使用了以下开源软件包。',
  '按许可证分类列出：',
  '',
];

for (const [license, pkgs] of Object.entries(data).sort()) {
  lines.push(`## ${license}`);
  lines.push('');
  for (const pkg of pkgs) {
    const name = pkg.name;
    lines.push(`- **${name}** — ${pkg.description || '(no description)'}`);
  }
  lines.push('');
}

lines.push('---');
lines.push(`生成时间: ${new Date().toISOString()}`);
lines.push(`总包数: ${Object.values(data).reduce((s, a) => s + a.length, 0)}`);

const dest = join(__dirname, '..', 'THIRD-PARTY-LICENSES.md');
writeFileSync(dest, lines.join('\n'), 'utf8');
console.log(`Generated: ${dest}`);
