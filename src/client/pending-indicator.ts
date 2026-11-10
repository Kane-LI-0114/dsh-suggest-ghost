/**
 * 生成中指示（pending indicator）的判据与样式声明——**纯函数，零 DOM**。
 *
 * ## 这个模块存在的理由
 *
 * 插件在生成期间过去是**完全静默**的：停顿后请求在途 19~28 秒（本环境实测，
 * 见 CHANGELOG 的「实测事实」一节），而界面上没有任何东西说明"它在忙"。
 * 用户能观察到的只有两种结局：幽灵出现，或者什么都不出现 —— 而"什么都没出现"
 * 至少对应四种不同的原因（未触发 / 在途未回 / 答了被丢弃 / 上界判死），彼此同形。
 *
 * ## 两个选项必须完全独立
 *
 * 用户明确要求「两个选项互不影响、可以同时开启」，所以这里**没有任何互斥分支**：
 * 两个开关各自产出各自的声明，组合是调用方直接拼起来的。冒烟按四种组合穷尽断言，
 * 其中"两个都关 ⇒ 必须一个像素都不加"这条最容易在改动中被破坏。
 *
 * ## 为什么 V4 要额外遵守"不覆盖宿主样式"
 *
 * V4 的泛光要画在输入框上，而宿主 composer 卡片自带 `box-shadow: var(--dsw-elevation-soft)`，
 * 直接改 `box-shadow` 会把宿主的层次阴影吃掉（表现为卡片"塌平"）。
 * 所以 V4 走 **`::after` + 内描边**：既不碰宿主的任何一条声明，也不改布局
 * （`position:absolute; inset:0` 且尺寸为 0 的伪元素不参与排版回路）。
 *
 * @module dsh-suggest-ghost/client/pending-indicator
 */

/** 两个指示的开关（来自用户设置；缺省值见 {@link DEFAULT_PENDING_STYLE}）。 */
export interface PendingStyleSettings {
  /** C1：生成期间让原生光标呼吸（`caret-color`）。**默认关，实验性**。 */
  readonly caretGlow: boolean;
  /** V4：生成期间输入框呼吸一圈内描边光。**默认关，实验性**。 */
  readonly boxGlow: boolean;
}

/**
 * 设置的缺省值：**两项都关**（2026-11-09 起按实验性发布）。
 *
 * 与 `dsh-later` 的「高级语法」同一口径：默认关、设置里标「实验性」、想用的人自己开。
 * 理由不是"没做完"，而是**观感与干扰程度要用真实使用来观察**——本环境一次健康续写
 * 在途 19~28 秒，指示在这段长等里是帮忙还是添乱，只有用过的人知道。
 */
export const DEFAULT_PENDING_STYLE: PendingStyleSettings = Object.freeze({
  caretGlow: false,
  boxGlow: false,
});

/** 一次绘制要应用的两条声明；`null` = 这个指示关闭，不产出任何声明。 */
export interface PendingDeclarations {
  /** 打到 `#dsh-suggest-ghost-overlay[data-…]` 上的宿主侧规则；`null` = 不产出。 */
  readonly box: string | null;
  /** 打到 `[data-composer-input]` 上的光标规则；`null` = 不产出。 */
  readonly caret: string | null;
}

/**
 * 此刻是否应该点亮指示。
 *
 * 判据只有一条：**这次草稿的续写正在途**。刻意不看 `session.running`
 * ——那是宿主 agent 回合在跑，宿主自己的界面已经表达过了；叠上我们的光
 * 只会让"谁在忙"更难分辨。
 *
 * @param style - 用户设置（含缺省已合并）。
 * @param pending - 当前会话是否有续写在途（`completionPending` 的派生值）。
 * @returns 是否应当点亮。
 */
export function shouldShowPending(style: PendingStyleSettings, pending: boolean): boolean {
  if (pending !== true) return false;
  // 两个开关**任一**开启即可点亮；全关则一个像素都不加。
  return style.caretGlow === true || style.boxGlow === true;
}

/**
 * 把设置解析成两条具体的 CSS 声明。
 *
 * 返回字符串而不是布尔，是为了让"关掉"与"开着"在调用处**同形**（都是往样式表里
 * 塞一条规则），避免出现 `if (开着) 加类 else 删类` 这种两处容易写反的分支。
 *
 * @param style - 用户设置。
 * @param pending - 是否有续写在途。
 * @returns 两条声明（关闭 / 不在途时对应项为 `null`）。
 */
export function pendingDeclarations(
  style: PendingStyleSettings,
  pending: boolean,
): PendingDeclarations {
  if (!shouldShowPending(style, pending)) return { box: null, caret: null };
  return {
    box: style.boxGlow ? BOX_GLOW_RULE : null,
    caret: style.caretGlow ? CARET_GLOW_RULE : null,
  };
}

/**
 * V4 的内描边呼吸。
 *
 * 三个刻意的选择：
 *  1. **`::after` 而不是改卡片自己的 `box-shadow`**：宿主那条 `--dsw-elevation-soft`
 *     原样保留，我们只叠一圈内描边。
 *  2. **最低不透明度不是 0**：`0.28` 起步的淡描边让指示在呼吸低谷也不会消失。
 *     宿主动效里同类问题有过先例（输入框 `@keyframes uV2eYG_input-pending` 从
 *     `opacity:.35` 起跳），这里沿用同一思路。
 *  3. **只动 `opacity` 与 `box-shadow`**：前者可合成，后者被限定在描边宽度内，
 *     不会触发整个输入区的重排。
 *
 * 选择器的宿主侧部分一律经 `body:has()` 去命中插件**自己的**节点
 * （React/Lexical 重渲染会剥掉编辑器上的外来类，而我们的 overlay 节点不受影响）——
 * 与既有 `data-shown` 让位 placeholder 的做法同构。
 */
export const BOX_GLOW_RULE = [
  '@keyframes sg-box-glow{0%,100%{opacity:.55}50%{opacity:1}}',
  'body:has(#dsh-suggest-ghost-overlay[data-box-glow="1"]) [data-composer-card]::after{',
  'content:"";position:absolute;inset:0;pointer-events:none;',
  'border-radius:inherit;box-shadow:inset 0 0 0 1.5px var(--dsw-alias-state-business-primary);',
  'opacity:.55;animation:sg-box-glow 1.6s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1)) infinite}',
].join('');

/**
 * C1 的光标呼吸。
 *
 * ⚠️ 宿主自己就写着 `caret-color: var(--dsw-alias-state-business-primary)`，并且会在
 * `[data-composer-chip-selected]` 时把它置成 `#0000` 隐藏光标。所以这里**只换颜色、
 * 不改层叠优先级**：若用户选中了引用 chip，宿主那条 `#0000` 仍然赢——那正合语义
 * （此刻光标本就不该出现），我们不去抢。
 *
 * `@media (prefers-reduced-motion)` 下降级为静态色：呼吸动画对光敏与认知负荷敏敏的
 * 用户是实打实的干扰，而"在忙"这件事仍然由 V4（或其静态态）表达。
 */
export const CARET_GLOW_RULE = [
  '@keyframes sg-caret-glow{0%,100%{caret-color:var(--dsw-alias-state-business-primary)}',
  '50%{caret-color:var(--dsw-alias-label-primary)}}',
  'body:has(#dsh-suggest-ghost-overlay[data-caret-glow="1"]) [data-composer-input]{',
  'animation:sg-caret-glow 1.6s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1)) infinite}',
  '@media (prefers-reduced-motion:reduce){',
  'body:has(#dsh-suggest-ghost-overlay[data-caret-glow="1"]) [data-composer-input]{',
  'animation:none;caret-color:var(--dsw-alias-label-primary)}}',
].join('');
