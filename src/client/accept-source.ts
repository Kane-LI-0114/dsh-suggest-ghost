/**
 * 采纳前的**同源候选**判定（Gitea #166 方案 B1）——纯逻辑，零 DOM、零宿主依赖。
 *
 * ## 要闭合的现象
 *
 * `src/client/index.ts:3190` 的 keydown 过去注册在 **window 捕获阶段**，抢在宿主与
 * 其它插件的处理器之前，且全仓没有「别人是否已经处理了这个键」的判据。与第三方
 * 输入预测（CodexUI）同装时，用户按 Tab 想采纳**屏幕上看到的那条**，本插件却按
 * **自己槽里那条**整段覆盖输入框（`accept-guard.ts` 的 `buildFullAccept` 对 `llm`
 * 就是 `return content.text`）。
 *
 * 方案 A（keydown 改到冒泡层 + `defaultPrevented` 判据）先解决「谁先跑」；
 * 本模块是**另一道**、不依赖 A 的闸：采纳前校验「本插件的浮层此刻画的这句」
 * 与「即将写入的 accepted」是否**同源**。
 *
 * ## 判据
 *
 * 浮层（overlay）的正文由 `overlayShapeOf` 唯一决定：
 *  - `llm`    ⇒ 整段文本就是 `content.text`；
 *  - `history` / `inline` ⇒ 只画**后缀** `content.suffix`。
 *
 * 所以「画的那句」= 浮层节点上读回来的那段文本（`GhostOverlay.paintedText`，
 * 必须**真的从节点读**，不能用内部状态里的 content —— 那与 accepted 同源，比了等于
 * 没比），「要写的那句」= `accept-guard.ts` 的 `acceptTarget` / `buildFullAccept`
 * 的结果（由调用方传入）。{@link paintedSuggestionText} 保留为「这份 content 本该
 * 画成什么」的参考口径（留痕与读法说明用），**不参与判定**。
 * 两者不同源 ⇒ 放弃采纳、一个字符都不写，并留一行 `tab-abandon: painted-mismatch`。
 *
 * **本模块刻意不接受任何 DOM 参数**：它只比较插件自己持有的两份值，因此天然满足
 * 「不得引入宿主 DOM 遍历」这条评审约束（`querySelector` 在本模块里零命中，
 * 见 `scripts/tab-ownership-smoke.mjs` 的同源闸）。
 *
 * ## `isPainted` 与「同源」的关系（容易读错，写清楚）
 *
 * `GhostOverlay.isPainted` 证明的是「节点真的画出来了」（`display:block` 且
 * `verify()` 通过），**不是**「画的内容与槽里的 content 一致」——`overlay.show()`
 * 之后 `shown` 与 `overlay.current` 同帧写入，正常情况下恒同源。缺的正是那一道
 * 「拿两者的文本比一比」：本模块补的就是它，`isPainted !== true` 时连比较都不必，
 * 直接判不同源（供调用方把「没画」与「画错」分开留痕）。
 *
 * @module dsh-suggest-ghost/client/accept-source
 */

/** 只读「画的是什么」所需的最小形态（与 `index.ts` 的 `GhostContent` 结构兼容）。 */
export type PaintedContent =
  | { kind: 'llm'; text: string }
  | { kind: 'history' | 'inline'; suffix: string };

/**
 * 浮层**实际绘制**的建议文本。
 *
 * 与 `index.ts` 的 `overlayShapeOf` 是同一份口径（那边折成 `suffixText` 交给
 * `buildText`，这边直接取原文），两处一致性由 `scripts/tab-ownership-smoke.mjs`
 * 的同源闸钉住：浮层的 `buildText` 若改成画别的东西而这里没跟上，冒烟当场红。
 */
export function paintedSuggestionText(content: PaintedContent): string {
  return content.kind === 'llm' ? content.text : content.suffix;
}

/** 同源判定的输入。 */
export interface AcceptSourceInput {
  /**
   * 浮层**此刻画在屏幕上**的那段文本（采纳那一刻从浮层节点上读回来，
   * 见 `GhostOverlay.paintedText`；没画 / 节点已摘走时为 `null`）。
   *
   * ⚠️ 这个字段是判据的**唯一**文本来源。不要改成传「内部状态里的 content」：
   * 那与 `accepted` 同源推导，两者必然相等，判据会退化成同义反复（#166 B1 的本意
   * 正是校验「屏幕上的那句 vs 要写进去的那句」）。
   */
  readonly paintedText: string | null;
  /**
   * 浮层当前对应的内容对象（只为区分形态：`history`/`inline` 只画后缀，`llm` 画整段）。
   * 它的文本**不参与**判定——判定用 {@link paintedText}。
   */
  readonly paintedContent: PaintedContent;
  /** 即将写入的采纳目标文本（`acceptTarget(content)` / `buildFullAccept(...)` 的结果）。 */
  readonly accepted: string;
}

/** 判定的结果（`reason === null` 才是通过）。 */
export interface AcceptSourceVerdict {
  /** 同源且浮层在画 ⇒ 可以写。 */
  readonly allow: boolean;
  /** 放弃原因；通过时为 `null`。 */
  readonly reason: 'not-painted' | 'painted-mismatch' | null;
  /** 浮层画的那句（诊断用），与 `accepted` 同为字符数，**不落正文**。 */
  readonly paintedChars: number;
  /** 将要写入的那句的字符数。 */
  readonly acceptedChars: number;
}

/**
 * 「屏幕上画的那句」与「要写入的那句」是否同源。
 *
 * 三条独立判据，任一不满足即放弃：
 *  1. 浮层必须在绘制中（`isPainted`）——没画出来的建议没有「屏幕上那句」可言，
 *     采纳它就等于照一条用户没看见的文本覆盖输入框；
 *  2. 画的文本必须**包含**要写入的文本：`llm` 形态两者相等；`history`/`inline`
 *     形态浮层只画后缀，而要写入的整段 `accepted` 里必然含这个后缀；
 *  3. 浮层画的文本必须**出现在** `accepted` 的尾部位置——后缀是接在草稿之后的，
 *     只做 `includes` 会被「草稿里恰好也有这段字」骗过。这里用「从末尾往前对」的
 *     判据：`accepted.endsWith(painted)`。空串（没画出任何字符）一律不同源。
 *
 * @param input - 三份值全部由调用方在同一时刻取出（见 `index.ts` 的采纳支）。
 */
export function acceptSourceVerdict(input: AcceptSourceInput): AcceptSourceVerdict {
  const paintedChars = input.paintedText === null ? 0 : input.paintedText.length;
  const acceptedChars = input.accepted.length;
  // `null` = 连节点都没读到（浮层从未画过 / 已被整体摘掉）。空串 = 画了但一个字没有，
  // 两者都放弃，但理由分开记：现场排查时「没画」与「画错」的下一步完全不同。
  if (input.paintedText === null) return { allow: false, reason: 'not-painted', paintedChars, acceptedChars };
  if (input.paintedText === '') return { allow: false, reason: 'painted-mismatch', paintedChars, acceptedChars };
  if (!input.accepted.endsWith(input.paintedText)) {
    return { allow: false, reason: 'painted-mismatch', paintedChars, acceptedChars };
  }
  return { allow: true, reason: null, paintedChars, acceptedChars };
}
