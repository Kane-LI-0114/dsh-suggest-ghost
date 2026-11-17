/**
 * 「这条幽灵实际按哪个键采纳」的**唯一判据**（纯函数，零依赖）。
 *
 * ## 为什么必须收成一处（Gitea #167）
 *
 * 同一个三元曾同时写在两个地方：
 *  - 键位提示行的文案源（`index.ts` 的 render 路径，喂给 `keyHintText`）；
 *  - `onKeyDown` 里的采纳匹配（`parseAcceptKey(acceptKey)`）。
 *
 * 两份实现读的是同一组输入，所以「行为」与「提示」今天是一致的。但一致性靠的是
 * **巧合般的复制**，不是结构：哪天有人把 `acceptKey` 扩到历史的 `history` / 停顿续写
 * `inline` 形态（#167 的方案 1/3），只改行为那一处就足够让提示行开始说假话 ——
 * 屏幕上写着 `F2 采纳`、按下去却什么都不会发生，而没有任何断言会红。
 * 这与 `src/transcript.ts` 的 `uiPriorLanguage` 是同一课（「判据只许有一处」）：
 * 判据长成第二份时，两份的分叉在界面上只表现为「说一套做一套」。
 *
 * 现在两条路径**都**只经本函数，于是：
 *  - 行为改了，提示行自动跟着改（不可能只改一边）；
 *  - `scripts/accept-key-smoke.mjs` 可以直载本模块，对判据做**行为断言**，
 *    不必加载 `index.ts` 那个客户端大文件（它也载不动：顶部就 import 了 react / 宿主包）。
 *
 * ## 现行语义（#167 方案 2：收窄文案，行为不动）
 *
 * `acceptKey` 设置项**只对 `llm` 形态生效**（宿主推来的「下一条建议」）；历史前缀补全
 * 与停顿续写一律用固定的 {@link DEFAULT_ACCEPT_KEY}（`Tab`）。理由不是偷懒：
 * `acceptKey` 的 schema 允许字母键（`z.string().min(1)`，设置卡片文案也明说可以设成字母），
 * 一旦把它扩到 `history`/`inline`，用户把键设成 `F` 后**每打一个字母都会命中采纳** ——
 * 输入被建议吞掉。要扩范围必须先定「字母键在本地即时形态上是否禁用」或收窄 schema
 * 的合法字符集，两条都是产品决策，不该由缺陷单顺带定。详见 Gitea #167。
 *
 * @module dsh-suggest-ghost/client/accept-key
 */

/** 采纳快捷键不受设置项影响的形态：历史前缀补全与停顿续写。 */
export type FixedAcceptKeyKind = 'history' | 'inline';

/**
 * 固定的（硬编码）采纳键。
 *
 * 与 `index.ts` 的 `DEFAULT_ACCEPT_KEY` 是**同一个值**，且由 `index.ts` 从本模块导入，
 * 不存在第二份字面量。改这里会同时改掉「llm 之外的形态按什么键」与提示行上写的键。
 */
export const DEFAULT_ACCEPT_KEY = 'Tab';

/** 采纳键判据的入参。 */
export interface AcceptKeyInput {
  /** 幽灵形态（与 `GhostContent.kind` 同集）。 */
  kind: 'llm' | 'history' | 'inline';
  /**
   * 设置项「采纳快捷键」的当前值（仅 `llm` 形态会用到）。
   *
   * 声明成可选只为让本函数是纯全定义映射：`llm` 形态在类型上恒有该字段（`GhostContent`），
   * 调用方永远传得进来。**本函数不对取值做净化**（见 {@link acceptKeyFor}）。
   */
  acceptKey?: string | undefined;
}

/**
 * 这条幽灵**实际生效**的采纳键。
 *
 * 给 `index.ts` 的两条路径共用（提示行文案 + `onKeyDown` 的匹配）；冒烟也用它做行为断言。
 * 返回值已经是「可以交给 `parseAcceptKey` 的 spec」，不是展示用格式化串 —— 展示格式化
 * 在 `parseAcceptKey` 那一侧，本函数不掺和。
 *
 * **`llm` 形态一律原样返回设置值，不做任何兜底或净化**（Gitea #167 方案 2 是「收窄文案，
 * 行为不动」）。历史实现就是原样透出，所以空串/空白时提示行会显示一个空键名、`parseAcceptKey`
 * 返回 `undefined` ⇒ 这一支永不命中。那是**可观测的自洽**（显示什么就是不生效什么），
 * 不是需要在本单顺手修掉的缺陷；真要去掉这个缺口，该收窄的是 schema 层
 * （`z.string().min(1)` 允许空白串），而不是在运行时兜 —— 本仓的判据纪律如此，且那属于
 * 产品决策，不在 #167 的范围内。
 *
 * @param input - 形态与设置值。
 * @returns 采纳键 spec（如 `Tab` / `F2` / `Ctrl+Enter`）。
 */
export function acceptKeyFor(input: AcceptKeyInput): string {
  if (input.kind !== 'llm') return DEFAULT_ACCEPT_KEY;
  // `undefined` 在类型上不可能（`GhostContent` 的 llm 支恒带该字段），保留合并只为让
  // 本函数是纯函数式的全定义映射；运行时不额外制造与历史不同的取值。
  return input.acceptKey ?? DEFAULT_ACCEPT_KEY;
}

/**
 * 该形态的采纳键是否**受设置项控制**（`true`）还是固定键（`false`）。
 *
 * 文案用得到它：设置项的 hint 必须与这里同一口径描述作用范围，否则又是一份判据。
 *
 * @param kind - 幽灵形态。
 * @returns `llm` 形态为 `true`。
 */
export function acceptKeyIsConfigurable(kind: AcceptKeyInput['kind']): boolean {
  return kind === 'llm';
}
