#!/usr/bin/env node
/**
 * #167 采纳键判据的冒烟：**「屏幕上显示的键 == 按下后实际生效的键」** 从注释升级成断言。
 *
 * ## 为什么要有这条
 *
 * issue 的验收标准原话是「把『界面自洽』这件事从注释升级成断言，防下一次改动破坏它」。
 * 这条自洽今天是**对的**（历史补全显示时屏幕上老实写着 `Tab 采纳`，因为提示行用的也是
 * 同一个 `DEFAULT_ACCEPT_KEY`），但它靠的是两份复制出来的三元恰好相同，没有任何东西在看着。
 *
 * ## 为什么选「抽纯函数 + 行为对照」而不是加载 index.ts
 *
 * `src/client/index.ts` 是客户端大文件：顶部就 import 了 react、宿主客户端包与 `.tsx`，
 * 纯 Node 载不动（先不说它根本不该为了跑冒烟而被载）。所以走任务书的方案 a：
 *  1. 把「这条幽灵按哪个键」抽成 `src/client/accept-key.ts` 的 `acceptKeyFor()`（纯函数，
 *     零依赖，可 `--experimental-strip-types` 直载），并由 index.ts 的**两条**路径共用；
 *  2. 本脚本对这个纯函数做**行为断言**，而不是「源码里出现过某个字符串」的形状断言。
 *
 * ⚠️ 光有形状断言不够（`docs/gitea-workflow.md` §7 那条 #146 的教训：断言与实现共享前提，
 * 前提错了两边一起绿）。所以这里每条自洽断言都同时驱动**三样真实机器**：
 *  - `acceptKeyFor()`  —— 决定键；
 *  - `keyHintText()`   —— 决定屏幕上写什么；
 *  - `keyCodeOf()` + 一段与 `index.ts` 的 `parseAcceptKey` **逐字同构**的匹配器
 *    —— 决定按下那个键到底会不会命中。
 * 三者都不是本脚本自己发明的口径：匹配器那段唯一被复制的是 index.ts 里的 5 行，
 * 且下面有一条结构闸钉住它没被写歪（见 `checkMatcherParity`）。
 *
 * ## 三态
 * 本脚本全部输入都在离线可控范围内 ⇒ 只有 PASS / FAIL，没有 NOT-COVERED 项。
 * **真宿主两代（textarea / contenteditable composer）不在本脚本覆盖范围**，见 PR。
 *
 * 用法：`node --experimental-strip-types scripts/accept-key-smoke.mjs`
 */
import { acceptKeyFor, DEFAULT_ACCEPT_KEY, acceptKeyIsConfigurable } from '../src/client/accept-key.ts';
import { keyHintText } from '../src/client/key-hint-text.ts';
import { keyCodeOf } from '../src/client/keyspec.ts';

let failed = 0;
const check = (name, fn, detail) => {
  let ok = false;
  let why = '';
  try { ok = fn(); } catch (error) { ok = false; why = ` 抛错: ${String(error?.message ?? error)}`; }
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      实际: ${why || (detail ? detail() : '')}`}`);
};

/**
 * 与 `src/client/index.ts` 的 `parseAcceptKey` **同构**的匹配器（副本）。
 *
 * 复制而不是导入：那个函数在客户端大文件里，载不动。代价是这份副本有漂移风险，
 * 所以 `checkMatcherParity` 从 index.ts 源码里读出那几行关键判据，断言两边说的是同一件事。
 *
 * @param spec 快捷键 spec（`Tab` / `F2` / `Alt+G` …）。
 * @returns 判定函数；spec 无法解析时 `undefined`（与 index.ts 同语义：这一支永不命中）。
 */
const parseAcceptKey = (spec) => {
  const parts = spec.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const mods = new Set(parts.slice(0, -1));
  const keyCode = keyCodeOf(spec);
  if (keyCode === undefined) return undefined;
  return (event) => event.code === keyCode
    && event.altKey === mods.has('alt')
    && event.ctrlKey === mods.has('ctrl')
    && event.metaKey === mods.has('meta')
    && event.shiftKey === mods.has('shift');
};

/** 造一个最小的 KeyboardEvent 替身（匹配器只读这 5 个字段，见上）。 */
const keyEvent = (code, mods = {}) => ({
  code,
  altKey: mods.alt === true,
  ctrlKey: mods.ctrl === true,
  metaKey: mods.meta === true,
  shiftKey: mods.shift === true,
});

/** 某个 spec 在「被正确按下」时应带的 KeyboardEvent 事实（code + 修饰键状态）。 */
const eventForSpec = (spec) => {
  const parts = spec.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = new Set(parts.slice(0, -1));
  return keyEvent(keyCodeOf(spec), {
    alt: mods.has('alt'), ctrl: mods.has('ctrl'), meta: mods.has('meta'), shift: mods.has('shift'),
  });
};

/** 这条 spec 在「按对了」的时候会不会命中。 */
const firesWhenPressed = (spec) => {
  const matcher = parseAcceptKey(spec);
  const code = keyCodeOf(spec);
  return matcher !== undefined && code !== undefined && matcher(eventForSpec(spec)) === true;
};

/** 提示行里「第一段」的键名（`Tab 采纳 · …` 的 `Tab`，`F2 accept · …` 的 `F2`）。 */
const hintSegments = (hint) => hint.split(' · ');

/**
 * 被设置项忽略掉的那个键，按下后会不会**命中实际生效的那个键的匹配器**。
 *
 * 问的必须是「生效匹配器收不收这个键」，而不是「这个键自己的匹配器会不会命中自己」
 * （那永远为真，判不出任何事 —— 本脚本第一版就写成了后者，`history/*` 12 条因此全红）。
 */
const ignoredKeyHitsEffective = (configured, effective) => {
  if (configured === effective) return false;
  const matcher = parseAcceptKey(effective);
  const code = keyCodeOf(configured);
  if (matcher === undefined || code === undefined) return false;
  // 修饰键状态按**被忽略的那个 spec** 造：模拟用户照设置里写的键（例 `Alt+S`）去按。
  const parts = configured.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  const mods = new Set(parts.slice(0, -1));
  return matcher(keyEvent(code, {
    alt: mods.has('alt'), ctrl: mods.has('ctrl'), meta: mods.has('meta'), shift: mods.has('shift'),
  })) === true;
};

/** 这条形态在给定设置下：实际生效的键、提示行、以及「该键真的按得动吗」。 */
const probe = (kind, acceptKey, lang = 'zh') => {
  const effective = acceptKeyFor({ kind, acceptKey });
  const hint = keyHintText({
    kind, acceptKey: effective, regenKey: 'Alt+G', wordAccept: true, regenEnabled: true, lang,
  });
  const word = lang === 'en' ? 'accept' : '采纳';
  return {
    effective,
    hint,
    // 采纳键必须是**第一段**且整段等值 —— 用 `includes` 会被 `"Tab 采纳".includes("F2 采纳")`
    // 这种子串关系骗过（本脚本第一版就踩了，`history/F2` 四条因此假绿）。
    firstSegment: hintSegments(hint)[0],
    expectedFirst: `${effective} ${word}`,
    hits: firesWhenPressed(effective),
    ignoredHits: ignoredKeyHitsEffective(acceptKey, effective),
  };
};

console.log('【#167 采纳键：显示 == 实际生效】\n');

// ─── 1. 判据本身：设置项只管 llm ─────────────────────────────────────────
check('acceptKey=F2：llm 形态生效 F2', () => acceptKeyFor({ kind: 'llm', acceptKey: 'F2' }) === 'F2',
  () => acceptKeyFor({ kind: 'llm', acceptKey: 'F2' }));

check('acceptKey=F2：history 形态仍固定 Tab（设置项不越界）',
  () => acceptKeyFor({ kind: 'history', acceptKey: 'F2' }) === DEFAULT_ACCEPT_KEY,
  () => acceptKeyFor({ kind: 'history', acceptKey: 'F2' }));

check('acceptKey=F2：inline 形态仍固定 Tab',
  () => acceptKeyFor({ kind: 'inline', acceptKey: 'F2' }) === DEFAULT_ACCEPT_KEY,
  () => acceptKeyFor({ kind: 'inline', acceptKey: 'F2' }));

check('acceptKey=Ctrl+Enter：history / inline 都不跟着变',
  () => acceptKeyFor({ kind: 'history', acceptKey: 'Ctrl+Enter' }) === 'Tab'
    && acceptKeyFor({ kind: 'inline', acceptKey: 'Ctrl+Enter' }) === 'Tab',
  () => JSON.stringify([acceptKeyFor({ kind: 'history', acceptKey: 'Ctrl+Enter' }),
    acceptKeyFor({ kind: 'inline', acceptKey: 'Ctrl+Enter' })]));

check('默认值口径：不传 acceptKey 时三形态都是 Tab',
  () => ['llm', 'history', 'inline'].every((kind) => acceptKeyFor({ kind }) === 'Tab'),
  () => JSON.stringify(['llm', 'history', 'inline'].map((kind) => acceptKeyFor({ kind }))));

// 空串/空白**不做兜底**：本单是「收窄文案，行为不动」，历史实现原样透出配置值 ⇒
// 提示行显示空键名、匹配器返回 undefined（这一支永不命中）。这是**可观测的自洽**
// （显示什么就是不生效什么），不是本单该顺手改的行为。真要收窄缺口，该动的是 schema 层。
check('空串/空白原样透出，不回落 Tab（与改动前逐字相同）',
  () => acceptKeyFor({ kind: 'llm', acceptKey: '' }) === ''
    && acceptKeyFor({ kind: 'llm', acceptKey: '   ' }) === '   ',
  () => JSON.stringify([acceptKeyFor({ kind: 'llm', acceptKey: '' }),
    acceptKeyFor({ kind: 'llm', acceptKey: '   ' })]));

check('acceptKeyIsConfigurable：只有 llm 受设置项控制（文案与判据同口径）',
  () => acceptKeyIsConfigurable('llm') === true
    && acceptKeyIsConfigurable('history') === false
    && acceptKeyIsConfigurable('inline') === false,
  () => JSON.stringify(['llm', 'history', 'inline'].map(acceptKeyIsConfigurable)));

// ─── 2. 界面自洽：显示的键 == 实际生效的键（核心断言）────────────────────
// 每条都要求四件事同时成立：
//   ① 提示行**第一段**整段等值于 `<生效键> 采纳|accept`（不是 includes）；
//   ② 按生效键真的命中（经真实的主键表 + 与 index.ts 同构的匹配器）；
//   ③ 被设置项忽略的那个键**按不动**（否则「设置项其实生效了」也能蒙混过关）；
//   ④ 提示行不承诺那个被忽略的键。
for (const kind of ['llm', 'history', 'inline']) {
  for (const configured of ['Tab', 'F2', 'Ctrl+Enter', 'Alt+S']) {
    for (const lang of ['zh', 'en']) {
      const word = lang === 'en' ? 'accept' : '采纳';
      check(`${kind}/${configured}/${lang}：提示行写的键 == 实际生效的键 == 按得动的键`, () => {
        const p = probe(kind, configured, lang);
        if (p.firstSegment !== p.expectedFirst) return false;
        if (!p.hits) return false;
        if (p.ignoredHits) return false;
        if (configured !== p.effective && p.hint.includes(`${configured} ${word}`)) return false;
        return true;
      }, () => {
        const p = probe(kind, configured, lang);
        return `first=${JSON.stringify(p.firstSegment)} 期望=${JSON.stringify(p.expectedFirst)}`
          + ` hits=${p.hits} 被忽略键仍命中=${p.ignoredHits} hint=${JSON.stringify(p.hint)}`;
      });
    }
  }
}

// ─── 3. 设置项确实在 llm 形态下起作用（不是「一律 Tab」的退化实现）────────
check('llm + acceptKey=F2：提示行第一段是 F2，F2 命中、而 Tab 按下去命中不了', () => {
  const p = probe('llm', 'F2');
  // ⚠️ 这里不许写成 `firesWhenPressed('Tab') === false`：那问的是「Tab 自己的匹配器收不收
  // Tab」，答案永远为真，判不出任何事。要问的是「**生效的** F2 匹配器收不收一次 Tab 按下」。
  const matcher = parseAcceptKey('F2');
  return p.firstSegment === 'F2 采纳' && p.hits
    && matcher !== undefined && matcher(keyEvent('Tab')) === false;
}, () => {
  const matcher = parseAcceptKey('F2');
  return `first=${JSON.stringify(probe('llm', 'F2').firstSegment)}`
    + ` F2收下Tab=${matcher === undefined ? 'undefined' : matcher(keyEvent('Tab'))}`;
});

check('llm + acceptKey=F2：en 提示行第一段是 F2 accept',
  () => probe('llm', 'F2', 'en').firstSegment === 'F2 accept',
  () => probe('llm', 'F2', 'en').hint);

// ─── 4. 结构闸：判据不许被抄回 index.ts（判据只许有一处）─────────────────
// 与 transcript.ts 的 uiPriorLanguage 同一条纪律：第二份判据长出来的那一刻，
// 行为与提示就开始各说各话。这里钉的是「那两个三元不许回来」。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const INDEX_SRC = readFileSync(join(process.cwd(), 'src', 'client', 'index.ts'), 'utf8');

check('index.ts 里不再持有 `kind === \'llm\' ? … : DEFAULT_ACCEPT_KEY` 那份三元',
  () => !/kind\s*===\s*'llm'\s*\?\s*[\w.]+\s*:\s*DEFAULT_ACCEPT_KEY/.test(INDEX_SRC),
  () => (INDEX_SRC.match(/.*DEFAULT_ACCEPT_KEY.*/g) ?? []).join(' | '));

check('index.ts 从 accept-key.ts 导入判据，且提示行与采纳两条路径都用它',
  () => /from '\.\/accept-key\.js'/.test(INDEX_SRC)
    // 两次调用：一次在 render 的 setKeyHint，一次在 onKeyDown。
    && (INDEX_SRC.match(/acceptKeyOfContent\(content\)/g) ?? []).length === 2,
  () => `import=${/from '\.\/accept-key\.js'/.test(INDEX_SRC)} calls=${(INDEX_SRC.match(/acceptKeyOfContent\(content\)/g) ?? []).length}`);

check('index.ts 的 DEFAULT_ACCEPT_KEY 字面量不再存在（常量只有一份，在 accept-key.ts）',
  () => !/const\s+DEFAULT_ACCEPT_KEY\s*=/.test(INDEX_SRC),
  () => (INDEX_SRC.match(/.*const DEFAULT_ACCEPT_KEY.*/g) ?? []).join(' | '));

check('匹配器副本没漂移：index.ts 的 parseAcceptKey 仍按 code + 四个修饰键判定', () => {
  const start = INDEX_SRC.indexOf('function parseAcceptKey');
  if (start < 0) return false;
  const body = INDEX_SRC.slice(start, start + 900);
  return body.includes('event.code === keyCode')
    && body.includes("event.altKey === mods.has('alt')")
    && body.includes("event.ctrlKey === mods.has('ctrl')")
    && body.includes("event.metaKey === mods.has('meta')")
    && body.includes("event.shiftKey === mods.has('shift')");
}, () => {
  const start = INDEX_SRC.indexOf('function parseAcceptKey');
  return start < 0 ? '找不到 parseAcceptKey' : INDEX_SRC.slice(start, start + 400);
});

// ─── 5. 文案登记：设置项 hint 必须讲清作用范围（与判据同口径）─────────────
const CARD_SRC = readFileSync(join(process.cwd(), 'src', 'client', 'settings-card.tsx'), 'utf8');
const acceptBlock = (() => {
  const start = CARD_SRC.indexOf("key: 'acceptKey',");
  return start < 0 ? '' : CARD_SRC.slice(start, start + 700);
})();

check('设置项文案讲清了「只对下一条建议」与「历史/续写固定 Tab」（zh）',
  () => acceptBlock.includes('下一条建议') && acceptBlock.includes('固定用 Tab')
    && acceptBlock.includes('历史补全') && acceptBlock.includes('停顿续写'),
  () => acceptBlock);

check('设置项文案讲清了同一件事（en）',
  () => acceptBlock.includes('LLM next suggestion') && acceptBlock.includes('always use Tab')
    && acceptBlock.includes('History') && acceptBlock.includes('pause completion'),
  () => acceptBlock);

console.log(`\n${failed === 0 ? '✅' : '❌'} accept-key-smoke: ${failed === 0 ? '全部通过' : `${failed} 条红`}`);
process.exit(failed === 0 ? 0 : 1);
