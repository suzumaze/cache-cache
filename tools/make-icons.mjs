// 拡張アイコン(16/48/128 PNG)を tools/icon.svg から生成する。
// icon.svg = Material Symbols「paid」（丸＋$）をラベンダー地・黄色で加工したもの。
// 変換に ImageMagick の `magick` を使う（要インストール: brew install imagemagick）。
// 高密度でラスタライズしてから縮小し、小サイズでもアンチエイリアスを効かせる。
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const svg = resolve(here, 'icon.svg');
const outDir = resolve(here, '..', 'icons');

for (const size of [16, 48, 128]) {
  const out = resolve(outDir, `icon-${size}.png`);
  execFileSync('magick', ['-background', 'none', '-density', String(size * 16), svg, '-resize', `${size}x${size}`, out]);
  console.log(`icons/icon-${size}.png`);
}
console.log('done');
