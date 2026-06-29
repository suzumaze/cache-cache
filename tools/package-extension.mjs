import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const root = process.cwd();
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
const distDir = join(root, 'dist');
const out = join(distDir, `cache-cache-${version}.zip`);
const staging = mkdtempSync(join(tmpdir(), 'cache-cache-package-'));
const include = ['manifest.json', 'service-worker.js', 'content', 'lib', 'sidepanel', 'icons'];

mkdirSync(distDir, { recursive: true });
if (existsSync(out)) rmSync(out);

for (const name of include) {
  const src = join(root, name);
  if (!existsSync(src)) throw new Error(`Missing required package entry: ${name}`);
  cpSync(src, join(staging, basename(name)), { recursive: true });
}

try {
  execFileSync('zip', ['-qr', out, '.'], { cwd: staging, stdio: 'inherit' });
  console.log(`Created ${out}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
