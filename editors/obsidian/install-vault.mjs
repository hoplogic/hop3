#!/usr/bin/env node
// 装/卸插件于 Obsidian vault（作者定 2026-08-16:安装卸载都做进命令——手工拷贝/删目录=易错手工活）。
// 安装：main.js/manifest.json/styles.css 拷入 <vault>/.obsidian/plugins/hopspec/
// 卸载：--uninstall 删除该目录（只删本插件目录——受管边界,vault 其余零触碰）
// 用法：npm run install-vault -- <vault路径> | npm run uninstall-vault -- <vault路径>
//（省略路径时按 HOPSPEC_VAULT 环境变量）
// @a: anc-viz-plugin-layout
import { copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uninstall = process.argv.includes('--uninstall');
const vaultArg = process.argv.filter(a => a !== '--uninstall')[2] ?? process.env.HOPSPEC_VAULT;
if (!vaultArg) {
  console.error('用法: npm run install-vault -- <vault路径> | npm run uninstall-vault -- <vault路径>（或设 HOPSPEC_VAULT）');
  process.exit(2);
}
const vault = resolve(vaultArg);
if (!existsSync(join(vault, '.obsidian'))) {
  console.error(`目标不是 Obsidian vault（无 .obsidian/ 目录）: ${vault}`);
  process.exit(2);
}
const dst = join(vault, '.obsidian', 'plugins', 'hopspec');

if (uninstall) {
  if (!existsSync(dst)) { console.log(`未安装（${dst} 不存在）——无事可做`); process.exit(0); }
  rmSync(dst, { recursive: true });
  console.log(`已卸载 ${dst}（只删本插件目录,vault 其余零触碰）`);
  process.exit(0);
}

const files = ['main.js', 'manifest.json', 'styles.css'];
for (const f of files) {
  if (!existsSync(join(here, f))) {
    console.error(`缺构建产物 ${f}——先 npm run build`);
    process.exit(2);
  }
}
mkdirSync(dst, { recursive: true });
for (const f of files) copyFileSync(join(here, f), join(dst, f));
console.log(`已装入 ${dst}（${files.join(' / ')}）——Obsidian 设置里启用 HopSpec 插件即生效`);
