#!/usr/bin/env node
/**
 * 界面语言判据的冒烟（`src/client/ghost-lang.ts` 的 `resolveGhostLang`）。
 *
 * ## 这条防的是什么
 * 宿主 `@deepseek-ai/dsh-client-locale` 0.2.x 起注册的语言**不止中英**：
 * `lib/client.js:1806` 那段 `addLanguage` 追加了 `ja`/`es`/`fr`/`de`/`ru`/`pt` 六门，
 * 每门都写 `fallback: "en"`，而内核的 `assertFallbackChain` 强制「完整回退链必须
 * 抵达英文」，抵达不了直接拒绝注册。本插件只有 zh/en 两套文案 ⇒ 非中文各门必须落
 * **英文**，落中文就是当着日文用户的面印一张中文卡片，并且**覆盖了宿主自己做对
 * 的回退决策**。旧实现正是后者，而且这个判断在三个地方各抄了一遍
 * （设置卡片 / 设置页导航条目名 / 幽灵键位提示行），抄三遍 ⇒ 修一处漏两处。
 *
 * ## 为什么断言分成四档而不是一句「其余全英文」
 * `undefined` 与 `'en'` 结果不同且**语义也不同**：前者是 locale 服务缺席
 * （旧宿主组合，那批宿主没有多语言界面 ⇒ 中文才是对的），后者是宿主明说了英文。
 * 把「缺席」也写成英文，会让 0.1.x 那几代的中文用户界面突然变英文；把它和 `'en'`
 * 塌成同一条断言，下一个人就会顺手合并两个分支，把缺席那条改错。所以逐档钉住。
 *
 * ## ⚠️ 载入方式
 * 直读 `src/`（`--experimental-strip-types`），不读 `lib/` —— 判据能被源码直载正是
 * 它单独成文件的理由（`docs/gitea-workflow.md` §3：改 src 不重建就跑冒烟会假绿）。
 * `useGhostT.ts` 引了 react，测不了，所以判据必须留在 `ghost-lang.ts` 里。
 *
 * 用法：node --experimental-strip-types scripts/ghost-lang-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGhostLang } from '../src/client/ghost-lang.ts';

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message.split('\n')[0]}`);
  }
};

const CLIENT_DIR = join('src', 'client');
const clientFiles = () => readdirSync(CLIENT_DIR).filter((n) => /\.(ts|tsx)$/.test(n));
const readClient = (name) => readFileSync(join(CLIENT_DIR, name), 'utf8');

/**
 * 剥掉注释，只留代码。
 *
 * 本闸扫的是**代码里的判据**，注释里提一句「别再抄 startsWith('zh')」不是抄。
 * 不剥注释的第一版当场把 `useGhostT.ts` 的一句说明文字判成违规——那是闸在骗人，
 * 而骗人的结构闸比没有闸更贵（下一个人会去改注释而不是改代码）。
 * 做法：先删块注释，再逐行把「行首或空白之后的 `//`」及其后内容去掉。
 * 「空白或行首」这个限定是必需的：`'https://x'` 里的 `//` 前面是 `:`，不能当注释，
 * 否则引号里的 URL 会被拦腰截断（第一版把 `//` 前面限定成「非空白」，结果行首缩进的
 * 注释一个都没删掉，闸又在骗人）。
 */
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .map((line) => line.replace(/(^|\s)\/\/.*$/g, '$1'))
  .join('\n');

const clientCode = (name) => stripComments(readClient(name));

// ─── 1. 缺席 ⇒ 中文（旧宿主组合，README 对外承诺的行为）──────────────────
check('locale 服务缺席 ⇒ zh', () => {
  assert.equal(resolveGhostLang(undefined), 'zh');
});

// ─── 2. 中文各读法 ⇒ zh ───────────────────────────────────────────────────
check('zh / zh-CN / zh-TW / zh-Hans ⇒ zh', () => {
  for (const id of ['zh', 'zh-CN', 'zh-TW', 'zh-Hans']) {
    assert.equal(resolveGhostLang(id), 'zh', `${id} 应落 zh`);
  }
});

// ─── 3. 宿主 addLanguage 注册的六门 ⇒ en（与内核 fallback: "en" 同向）─────
// 这一组是本文件存在的全部理由；旧实现在这里六门全部返回 zh。
check('en / en-US / ja / es / fr / de / ru / pt ⇒ en', () => {
  for (const id of ['en', 'en-US', 'ja', 'es', 'fr', 'de', 'ru', 'pt']) {
    assert.equal(resolveGhostLang(id), 'en', `${id} 应落 en（宿主该门 fallback 即 en）`);
  }
});

// ─── 4. 未收录 id ⇒ en，且不许回落中文 ─────────────────────────────────────
// `LocaleId = string`：内核允许语言包插件注册任意 id（`it`/`ko`/`ar` 都可能出现在
// `active` 里）。中文是**源语言**而不是兜底语言，兜底只能是英文——否则宿主每新增
// 一门语言就多一个中文卡片事故。空串按「宿主说了个不认识的玩意儿」处理，同样 en。
check('未收录 id（含空串）⇒ en', () => {
  for (const id of ['it', 'ko', 'ar', 'xx-YY', '']) {
    assert.equal(resolveGhostLang(id), 'en', `未知 id ${JSON.stringify(id)} 应落 en`);
  }
});

// ─── 5. 判据唯一性：三处调用点不许各自再抄一遍 ─────────────────────────────
// 「抄一遍漏两处」是已经发生过的真实事故形态（旧代码里 `=== 'en' ? … : 'zh'` 有
// 三份，每份都要人手同步）。这条是**结构闸**而非行为闸：判据被复制回去的时候
// 行为往往是**对的**（两份都写对就看不出来），只有行为测试抓不到，所以直接读源码。
// 拦三种抄法：比较 active 的字面量分支、重新 `startsWith('zh')`、重复定义 zh|en 联合。
check('判据只在 ghost-lang.ts 有一份', () => {
  const offenders = [];
  for (const name of clientFiles()) {
    if (name === 'ghost-lang.ts') continue;
    const text = clientCode(name);
    const hits = [];
    if (/active\s*===\s*'en'/.test(text)) hits.push("active === 'en' 比较");
    if (/startsWith\('zh'\)/.test(text)) hits.push("startsWith('zh') 判据");
    if (/type\s+\w*Lang\s*=\s*'zh'\s*\|\s*'en'/.test(text)) hits.push('重复定义 zh|en 语言联合');
    if (hits.length > 0) offenders.push(`${name}: ${hits.join(', ')}`);
  }
  assert.deepEqual(offenders, [], `判据被抄回去了 ⇒ 收回 resolveGhostLang：${offenders.join(' / ')}`);
});

// ─── 6. 反向守卫：真实调用点必须还在（≥3 处）───────────────────────────────
// 上一条防「抄多了」，这一条防「抄没了」：有人为了消灭重复判据把三处合并成
// 「不读语言」的写死常量，前一条照样绿，但语言跟随整个失效。
// 数的是**调用出现次数**而不是文件数：设置卡片走 `useGhostT`（转发），
// 导航条目名与键位提示在 `index.ts` 里各调一次 ⇒ 3 处调用分布在 2 个文件。
// 按文件数会误报「只有 2 处」，逼出一次把转发拆掉的重构来喂闸——闸不该有这种要求。
check('resolveGhostLang 有 ≥3 处真实调用', () => {
  const perFile = {};
  let calls = 0;
  for (const name of clientFiles()) {
    if (name === 'ghost-lang.ts') continue;
    const n = (clientCode(name).match(/resolveGhostLang\s*\(/g) ?? []).length;
    if (n > 0) perFile[name] = n;
    calls += n;
  }
  assert.ok(
    calls >= 3,
    `resolveGhostLang 应被至少 3 处调用（卡片 / 导航条目名 / 键位提示），实际 ${calls} 处：` +
      Object.entries(perFile).map(([k, v]) => `${k}×${v}`).join(', '),
  );
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ghost-lang-smoke: ${failed === 0 ? '界面语言回退方向正确且判据唯一' : `${failed} 条不合格`}`);
process.exit(failed === 0 ? 0 : 1);
