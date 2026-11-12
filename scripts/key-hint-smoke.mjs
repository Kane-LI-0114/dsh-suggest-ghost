/**
 * #157 键位提示的冒烟：`keyHintText()` 的文案拼装 + 节点几何/生命周期。
 *
 * ## 为什么这里能纯 Node 跑
 *
 * `key-hint.ts` 不 import 任何宿主包（零运行时依赖，与 `keyspec.ts` 同款），
 * `keyHintText()` 是纯函数。`KeyHintNode` 需要 DOM，所以这里只对纯函数做判定；
 * 节点行为留给真宿主取证（浏览器侧），不在本脚本里假装测到。
 *
 * ## 断的是什么（每条都对应一个真实行为差异，不是形状摆设）
 *
 *  1. 默认设置下：`Tab 采纳 · → 逐词 · Esc 关闭`；
 *  2. **`llm` 形态不出现 `→`** —— 该形态下裸 `→` 走原生光标移动，写上去就是错的说明；
 *  3. `wordAccept=false` 时不出现 `→`；
 *  4. 采纳键**跟着设置变**（把 `acceptKey` 换成 `F2`，文案里必须是 `F2`，不是 `Tab`）
 *     —— 这条是在防「文案硬编码」这个具体退化；
 *  5. 「换一条」只在 `llm` 形态**且** `regenEnabled` 时出现；
 *  6. en 与 zh 两种语言都覆盖。
 *
 * 用法：`node scripts/key-hint-smoke.mjs`（退出码 0 = 全过，1 = 有红）。
 */
// 直读 `src/`（`--experimental-strip-types`）：`build.mjs` 只把 `src/client/index.ts`
// 打成 `lib/client.js`，独立模块不在产物里，与 `keyspec-smoke.mjs` 同款口径。
import { keyHintText, KEY_HINT_ID } from '../src/client/key-hint.ts';

/** @type {{name:string, fn:()=>boolean, detail:()=>string}[]} */
const cases = [];
/**
 * 登记一条用例。
 * @param name 用例名（红的时候直接打出来）。
 * @param fn 返回是否通过。
 * @param detail 失败时打印的实际值。
 */
const test = (name, fn, detail) => { cases.push({ name, fn, detail }); };

const base = {
  kind: /** @type {const} */ ('history'),
  acceptKey: 'Tab',
  regenKey: 'Alt+G',
  wordAccept: true,
  regenEnabled: true,
  lang: /** @type {const} */ ('zh'),
};

test('默认设置（history，zh）= Tab 采纳 · → 逐词 · Esc 关闭',
  () => keyHintText(base) === 'Tab 采纳 · → 逐词 · Esc 关闭',
  () => keyHintText(base));

test('llm 形态**不出现** →（该形态下裸 → 是原生光标移动）',
  () => !keyHintText({ ...base, kind: 'llm' }).includes('→'),
  () => keyHintText({ ...base, kind: 'llm' }));

test('inline 形态出现 →（停顿续写支持逐词）',
  () => keyHintText({ ...base, kind: 'inline' }).includes('→'),
  () => keyHintText({ ...base, kind: 'inline' }));

test('wordAccept=false 时不出现 →',
  () => !keyHintText({ ...base, wordAccept: false }).includes('→'),
  () => keyHintText({ ...base, wordAccept: false }));

test('采纳键跟随设置：acceptKey=F2 ⇒ 文案里是 F2 且不含 Tab',
  () => {
    const s = keyHintText({ ...base, acceptKey: 'F2' });
    return s.includes('F2') && !s.includes('Tab');
  },
  () => keyHintText({ ...base, acceptKey: 'F2' }));

test('default 口径：非 Tab 的 acceptKey 在 zh 文案里替换掉 Tab（不是追加）',
  () => {
    // 这条是「硬编码 Tab」的专用捕获：上一版只断言「含 F2 且不含 Tab」，
    // 而硬编码实现如果写成 `Tab 采纳 · F2 ...` 就漏过了 —— 实测变异没变红，
    // 所以判据改成**整行等值**：非 default 键位下，文案必须逐字等于只含该键的形态。
    const s = keyHintText({ ...base, acceptKey: 'F2' });
    return s === 'F2 采纳 · → 逐词 · Esc 关闭';
  },
  () => keyHintText({ ...base, acceptKey: 'F2' }));

test('采纳键跟随设置：acceptKey=Ctrl+Enter 原样透出',
  () => keyHintText({ ...base, acceptKey: 'Ctrl+Enter' }).includes('Ctrl+Enter'),
  () => keyHintText({ ...base, acceptKey: 'Ctrl+Enter' }));

test('「换一条」只在 llm 形态出现',
  () => keyHintText({ ...base, kind: 'llm' }).includes('Alt+G 换一条')
    && !keyHintText({ ...base, kind: 'history' }).includes('Alt+G'),
  () => `${keyHintText({ ...base, kind: 'llm' })} | ${keyHintText({ ...base, kind: 'history' })}`);

test('regenEnabled=false 时不出现「换一条」',
  () => !keyHintText({ ...base, kind: 'llm', regenEnabled: false }).includes('换一条'),
  () => keyHintText({ ...base, kind: 'llm', regenEnabled: false }));

test('en 文案：Tab accept · → word · Esc dismiss',
  () => keyHintText({ ...base, lang: 'en' }) === 'Tab accept · → word · Esc dismiss',
  () => keyHintText({ ...base, lang: 'en' }));

test('en + llm：another 出现且不出现 →',
  () => {
    const s = keyHintText({ ...base, kind: 'llm', lang: 'en' });
    return s.includes('another') && !s.includes('→');
  },
  () => keyHintText({ ...base, kind: 'llm', lang: 'en' }));

test('节点 id 稳定（取证脚本据此纯读 DOM）',
  () => KEY_HINT_ID === 'dsh-suggest-ghost-keyhint',
  () => KEY_HINT_ID);

let failed = 0;
for (const c of cases) {
  let ok = false;
  try { ok = c.fn(); } catch (e) { ok = false; }
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}${ok ? '' : `\n      实际: ${c.detail()}`}`);
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed === 0 ? 0 : 1);
