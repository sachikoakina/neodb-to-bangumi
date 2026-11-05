/**
 * 校验 .env.example 与代码读取的环境变量双向一致：
 * 代码读取（ENV_KEYS）而文档缺失 → 提示；文档有而代码不读 → 提示。
 */
import { readFileSync } from 'node:fs';
import { consola } from 'consola';
import { ENV_KEYS } from '../src/sync-config';

const ENV_EXAMPLE = '.env.example';

let failures = 0;

const content = readFileSync(ENV_EXAMPLE, 'utf8');
// 同时匹配生效行 `KEY=` 与注释行 `# KEY=`（示例文件里可选项以注释呈现）。
const documented = new Set<string>();
for (const match of content.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)\s*=/gm)) {
  documented.add(match[1]!);
}

for (const key of ENV_KEYS) {
  if (!documented.has(key)) {
    failures += 1;
    consola.error(`代码读取了 ${key}，但 ${ENV_EXAMPLE} 未记录`);
  }
}
for (const key of documented) {
  if (!ENV_KEYS.includes(key)) {
    failures += 1;
    consola.error(`${ENV_EXAMPLE} 记录了 ${key}，但代码并不读取`);
  }
}

if (failures > 0) {
  consola.error(`verify-docs: ${failures} 处不一致`);
  process.exitCode = 1;
} else {
  consola.info(`verify-docs: ${ENV_KEYS.length} 个变量双向一致`);
}
