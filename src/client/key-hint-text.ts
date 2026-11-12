/**
 * 键位提示的**文案拼装**（纯函数，零依赖）。
 *
 * 单独成文件是为了让 `scripts/key-hint-smoke.mjs` 能用
 * `--experimental-strip-types` 直接读它做判定 —— `.tsx` 不能被 strip-types 加载，
 * 而这里确实没有任何 JSX（与 `keyspec.ts` 同款拆法）。
 *
 * @module dsh-suggest-ghost/client/key-hint-text
 */

/** 拼提示行需要的最小输入。 */
export interface KeyHintInput {
  /** 幽灵形态。`llm` 没有行尾锚点，且 `→` 在该形态下是原生光标移动。 */
  kind: 'llm' | 'history' | 'inline';
  /** 当前生效的采纳快捷键（展示用，已按用户设置格式化，如 `Tab` / `F2` / `Ctrl+Enter`）。 */
  acceptKey: string;
  /** 当前生效的「换一条」快捷键（仅 `llm` 形态且重出开启时展示）。 */
  regenKey?: string;
  /** 逐词采纳是否开启。 */
  wordAccept: boolean;
  /** 重出（换一条）是否开启。 */
  regenEnabled: boolean;
  /** 界面语言。 */
  lang: 'zh' | 'en';
}

/**
 * 拼出提示行文本。
 *
 * 逐条出现的条件都对应一个**真实行为差异**，不是随意裁剪：
 *  - `→` 只在 `history` / `inline` 形态下出现：`llm` 形态下裸 `→` 走的是原生
 *    光标移动（见 `index.ts` 的逐词采纳分支条件），写上去就是错的说明；
 *  - `→` 还要求 `wordAccept` 开启（用户关掉后就不再成立）；
 *  - 「换一条」只在 `llm` 形态且 `regenEnabled` 开启时出现。
 *
 * @param input - 当前形态与设置。
 * @returns 提示行文本；分隔符用 `·`（与同类插件一致的密集写法）。
 */
export function keyHintText(input: KeyHintInput): string {
  const sep = ' · ';
  const wordByWord = input.kind !== 'llm' && input.wordAccept;
  if (input.lang === 'en') {
    const parts = [`${input.acceptKey} accept`];
    if (wordByWord) parts.push('\u2192 word');
    parts.push('Esc dismiss');
    if (input.kind === 'llm' && input.regenEnabled && input.regenKey) {
      parts.push(`${input.regenKey} another`);
    }
    return parts.join(sep);
  }
  const parts = [`${input.acceptKey} 采纳`];
  if (wordByWord) parts.push('\u2192 逐词');
  parts.push('Esc 关闭');
  if (input.kind === 'llm' && input.regenEnabled && input.regenKey) {
    parts.push(`${input.regenKey} 换一条`);
  }
  return parts.join(sep);
}
