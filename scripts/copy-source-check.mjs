/**
 * 用户可见文案的来源检查（供 settings-copy-smoke 调用）。
 *
 * ## 判据
 * 本仓的界面文案只有三条合法来源：
 *  ① `GHOST_FIELDS` 里的 `{ zh: '…', en: '…' }` 双值；
 *  ② `zhStrings` / `enStrings` 字典（en 由映射类型锁键集，缺键编译期就红）；
 *  ③ 按 `lang` 分支的拼装函数（`key-hint-text.ts`：`if (input.lang === 'en')` 两支各写一份）。
 * 除此之外写在字符串字面量里的中文**没有任何既有测试能拦住**：类型对、渲染对，
 * 中文界面下看着甚至是对的——只有把宿主语言切走才露出来。所以这条只能写成机械规则。
 *
 * ## 为什么不能「grep 一下有没有中文」
 * 那样第一版报了 11 处假阳性（行尾注释、块注释、JSX 注释、双语值的 `+ '…'` 续行），
 * 第二版又把 `history.ts` 正则字符类里的 `^\d+月` 当成了文案。**假阳性的结构闸比没有闸
 * 更糟**：下一个人会去改注释、改正则，而不是改文案。故按下面三步收窄。
 *
 * ## 三步收窄
 *  1. **掩码**：删块注释与行注释（`//` 只在行首或空白之后才算注释，`https://` 不拦腰截断）；
 *     掩掉 `const zhStrings` → `const GHOST_STRINGS` 之间的两份源字典；掩掉每个
 *     `{ zh: … , en: … }` 双语字面量（从 `zh:` 回溯最近的 `{`，按花括号配平走到 `}`，
 *     多行值与 `+ '…'` 续行因此一起被掩掉）。掩码用空格替换非空白字符、**保留换行**，
 *     这样报出来的行号仍对得上源码。
 *  2. **只认字符串字面量**：扫单引号 / 双引号 / 反引号包裹的跨度，模板的 `${…}` 内部
 *     递归处理（`${}` 里再出现引号字面量也算）。正则字面量、注释、标识符里的 CJK 不算文案。
 *  3. **按理由放行**：非 UI 文本（给模型看的工具参数 description、诊断串、console.warn）
 *     与 ③ 那类 lang 分支，由调用方给一份**带理由**的放行表；表里每一条都要写清为什么
 *     不是界面文案。新增中文文案若不在表里 ⇒ 红。
 *
 * @module dsh-suggest-ghost/scripts/copy-source-check
 */

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 删注释（掩码第 1 步的前半）。 */
export function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/g, '$1'))
    .join('\n');
}

/** 把 `[from, to)` 区间的非空白字符换成空格（保留换行 ⇒ 行号不漂）。 */
function mask(lines, from, to) {
  for (let i = from; i < to && i < lines.length; i++) {
    lines[i] = lines[i].replace(/\S/g, ' ');
  }
}

/** 字符 idx 所在的 0-based 行号。 */
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length - 1;

/**
 * 掩掉源字典块与 `{ zh: …, en: … }` 双语字面量，返回**掩码后**的行数组。
 * 掩码而非删除：后续仍按原行号报告。
 */
export function maskLegitSources(lines) {
  const dictStart = lines.findIndex((l) => l.startsWith('const zhStrings'));
  const dictEnd = lines.findIndex((l) => l.startsWith('const GHOST_STRINGS'));
  if (dictStart >= 0 && dictEnd > dictStart) mask(lines, dictStart, dictEnd + 1);

  const text = lines.join('\n');
  let searchFrom = 0;
  for (;;) {
    const at = text.indexOf('zh:', searchFrom);
    if (at < 0) break;
    searchFrom = at + 3;
    const open = text.lastIndexOf('{', at);
    if (open < 0) continue;
    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) continue;
    mask(lines, lineOf(text, open), lineOf(text, close) + 1);
  }
  return lines;
}

/**
 * 从 `start`（指向开引号）收一个字符串字面量的跨度。
 * 反引号内的 `${ … }` 递归：模板插值里再出现的引号字面量同样算。
 * @returns `{ end, spans }`，end 为闭引号下标；spans 为该字面量里所有 CJK 出现的下标。
 */
function scanString(text, start) {
  const q = text[start];
  const spans = [];
  let i = start + 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (q === '`' && c === '$' && text[i + 1] === '{') {
      // 插值：跳过大括号配平的整段，段内的引号字面量单独收
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') { depth--; if (depth === 0) break; }
      }
      const inner = text.slice(i + 2, j);
      const nested = collectStringSpans(inner, i + 2);
      spans.push(...nested.spans);
      i = j;
      continue;
    }
    if (c === q) return { end: i, spans };
    if (CJK_RE.test(c)) spans.push(i);
    if (q !== '`' && c === '\n') break;   // 非模板字符串不跨行：遇到换行视为未闭合
  }
  return { end: i, spans };
}

/** 扫一段源码，收集所有字符串字面量里的 CJK 下标。 */
export function collectStringSpans(text, offset = 0) {
  const spans = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const { end, spans: inner } = scanString(text, i);
      spans.push(...inner);
      i = end;
    }
  }
  return { spans: spans.map((s) => s + offset) };
}

/**
 * 找出「没走合法来源的中文文案」。
 * @param src 已剥注释的源码（本函数内部会调 stripComments，直接传原文即可）。
 * @param allow 放行表：`{ re, why }`，命中的**行**放行；每条必须写理由。
 * @returns `行号: 行片段` 列表。
 */
export function findHardcodedCopy(src, allow = []) {
  const lines = maskLegitSources(stripComments(src).split('\n'));
  const text = lines.join('\n');
  const { spans } = collectStringSpans(text);
  const hits = [];
  for (const idx of spans) {
    const ln = lineOf(text, idx);
    const line = lines[ln];
    if (allow.some((a) => a.re.test(line))) continue;
    const tag = `${ln + 1}: ${line.trim().slice(0, 78)}`;
    if (!hits.includes(tag)) hits.push(tag);
  }
  return hits;
}
