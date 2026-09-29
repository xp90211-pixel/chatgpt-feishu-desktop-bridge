import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = ['bridge', 'card-websocket', 'cards', 'chatgpt', 'cli', 'credentials', 'feishu', 'launch', 'mcp-client', 'roundtrip', 'service', 'status', 'stop', 'store', 'ui'];
const tests = ['bridge', 'card-websocket', 'credentials', 'feishu', 'selection', 'store'];
const allowed = new Set([
  '.gitignore', '.gitattributes', '.github/workflows/test.yml', 'README.md', 'SECURITY.md',
  'THIRD_PARTY_NOTICES.md', 'config.example.json', 'package.json', 'package-lock.json',
  'scripts/check-public.mjs', ...modules.map(name => `src/${name}.mjs`), ...tests.map(name => `test/${name}.test.mjs`),
]);
const rules = [
  ['real-service-id', /\b(?:cli_|ou_|oc_|om_)[a-f0-9]{16,}\b/gi],
  ['literal-conversation-id', /\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi],
  ['personal-windows-path', /\b[a-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\s<>"'\\/]+/gi],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ['bearer-value', /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}/g],
  ['jwt-value', /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g],
];

export function inspectPublicFile(file, text) {
  const findings = [];
  if (!allowed.has(file)) findings.push({ file, rule: 'file-not-in-public-manifest' });
  if (text.includes('\0')) findings.push({ file, rule: 'binary-content' });
  for (const [rule, pattern] of rules) {
    for (const match of text.matchAll(pattern)) findings.push({ file, rule, line: text.slice(0, match.index).split('\n').length });
  }
  for (const match of text.matchAll(/https?:\/\/([a-z0-9-]+\.feishu\.cn)\b/gi)) {
    if (!['open.feishu.cn', 'www.feishu.cn'].includes(match[1].toLowerCase())) findings.push({ file, rule: 'private-tenant-host', line: text.slice(0, match.index).split('\n').length });
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const findings = [];
  if (!files.length) throw new Error('No tracked or staged release files found. Stage the public files before checking.');
  for (const file of files) {
    const text = execFileSync('git', ['show', `:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
    findings.push(...inspectPublicFile(file, text));
  }
  const example = JSON.parse(execFileSync('git', ['show', ':config.example.json'], { cwd: root, encoding: 'utf8' }));
  if (example.enabled !== false) findings.push({ file: 'config.example.json', rule: 'example-must-disable-live-forwarding' });
  console.log(JSON.stringify({ status: findings.length ? 'PUBLIC_CHECK_FAILED' : 'PUBLIC_CHECK_PASSED', files: files.length, findings }, null, 2));
  process.exitCode = findings.length ? 1 : 0;
}
