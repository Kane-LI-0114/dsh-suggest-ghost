/**
 * 键位提示的**槽位版**（Gitea #157）。
 *
 * ## 为什么从手写 DOM 改成槽位组件
 *
 * 上一版是「自建 div + 绝对定位」，实测被用户否掉了两次：
 *
 *  1. 定位到输入卡片**外面**（下方/上方）⇒ 视口底部没空间就必须翻上去，而卡片上方
 *     是**对话正文**，提示行直接压在最后一条消息上（用户截图：两行叠字）；
 *  2. 定位到输入卡片**里面**⇒ 不压正文了，但把卡片的内部结构挤乱，用户评价「太丑」。
 *
 * 两次的共同病根是**寄生式定位**：节点是强行插进别人布局里的，位置靠自己算，
 * 于是「算对」和「好看」是两件互不相干的事，且每个宿主代次的布局变化都要重算。
 *
 * 参考实现对（`dsh-input-assist`）的做法完全不同 —— 它注册到宿主自己的槽位：
 *
 *     slots.inject("conversation.input.dock", () => slots.register({ ... }, GhostHint));
 *
 * 位置交给宿主的 flex 布局决定，**结构上不可能压到正文**，也不用手写任何几何。
 * 本文件就是照这个方式重写的版本：`composerStack`（`flex-direction:column; gap:6px`）
 * 会给它 6px 间距并排在输入卡片**上方**，它只是一行普通子项。
 *
 * ## 与旧实现的取舍（如实记）
 *
 * 槽位版会**占一点垂直空间**（一个 18px 行 + 6px gap），而不是浮在别的东西上面。
 * 这是"不遮挡"的必然代价：要么占位，要么叠。用户已明确否决了叠。
 *
 * @module dsh-suggest-ghost/client/key-hint-bar
 */
import { useSyncExternalStore, type ReactElement } from 'react';

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

/** 提示行在 DOM 上的稳定钩子（取证与冒烟据此纯读 DOM，不靠日志）。 */
export const KEY_HINT_TESTID = 'dsh-suggest-ghost-keyhint';

/** 槽位组件收到的 props（宿主按槽位契约注入 `useConfig` 之类，这里只用最小子集）。 */
export interface KeyHintBarProps {
  /** 当前应显示的提示；`null` = 不渲染（宿主不会为 null 留出空间）。 */
  hint: KeyHintInput | null;
}

/**
 * 槽位里的提示行组件。
 *
 * 样式与参考实现（`dsh-input-assist` 的 `.ia_ghosthint`）逐项对齐，理由见每一行注释：
 *  - `alignSelf:'flex-start'`：**不居中**。父级 `composerStack` 是 column flex，默认
 *    `stretch` 会把这一行拉满整宽；居中会飘在输入框正中、看起来像另起一个控件，
 *    左对齐才像"输入框上方的一行小字"。
 *  - `minHeight:18` / `lineHeight:'18px'`：flex 子项在挤压时行高会被压扁，
 *    固定两者可防抖。
 *  - `overflow:'hidden'` + `textOverflow:'ellipsis'`：窄窗下不换行、不撑高。
 *  - 颜色走 `label-tertiary`：比 placeholder 更弱，不与正文抢注意力。
 *
 * @param props - 见 `KeyHintBarProps`。
 * @returns 提示行元素；`hint` 为 null 时返回 null（不留占位）。
 */
export function KeyHintBar(props: KeyHintBarProps): ReactElement | null {
  const { hint } = props;
  if (hint === null) return null;
  return (
    <div
      data-suggest-ghost-keyhint={KEY_HINT_TESTID}
      style={{
        // ── 位置：输入卡片顶部、草稿首行之上的那段空隙（用户明确指定的位置）──
        //
        // 实测几何：card.top=672、草稿文字首行 top=686 ⇒ **空隙 14px**；
        // 编辑器 line-height=24px，但 11px 字号的字形只占约 11px，视觉上放得下。
        // （先前我把 `card padding-top:8px` 当成可用高度、下了"放不下"的结论 ——
        //   那是量错了层：真实空隙是 14px，用户圈出的位置本来就是够的。）
        //
        // 定位：父链为
        //   div(我的) → div(wrapper, static, rect=[0,0]) → .overlayAnchor(absolute, height:0)
        //   → .card(relative)，锚点就在卡片顶部内沿。
        //  - `top:0` ⇒ 与锚点对齐 = 卡片顶部内沿；
        //  - `height:14px` 把这一行的盒高压到空隙内，**不会碰到草稿首行**（判据 ③ 会验）；
        //  - `left:0;right:0` ⇒ 横向吃满卡片（wrapper 是 static，不构成包含块）。
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        // ── 盒高与字号：9px 字，盒子**只包到字**，底部不留空白 ──
        //
        // 空间约束（实测）：编辑器 `[data-composer-input]` 从卡片顶 +8px 开始，
        // 与提示行这条 672–686 的带子重叠。要让 9px 的字不被裁、且不被编辑器盖住：
        //  - `lineHeight` 必须 ≥ 字号的**字形**高度（9px 字约需 9px 行框），否则上下沿被裁；
        //  - 盒高不能超过 8px 太多（否则底部又被编辑器覆盖，判据 ③b 会红）。
        //
        // 折中做法：行框给 9px（字不被裁），盒子高度也收紧到 9px，
        // 底部**不再额外留 padding** —— 之前 14px 盒高时下面空着一大截，用户觉得宽。
        height: 9,
        padding: '0 12px',
        lineHeight: '9px',
        fontSize: 9,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        color: 'var(--dsw-alias-label-tertiary, #8b8f94)',
        pointerEvents: 'none',
      }}
    >
      {keyHintText(hint)}
    </div>
  );
}

/** 槽位 `inject` 提供的面。 */
export interface KeyHintDockFace {
  /** 当前应显示的提示（null = 不渲染）。 */
  keyHintNow: () => KeyHintInput | null;
  /**
   * 订阅「提示变化」。返回退订函数。
   *
   * 为什么需要它：提示值的持有方在 `index.ts` 的闭包里（不是 React state），
   * 槽位组件自己不重渲染就永远看不到新值。用 `useSyncExternalStore` 订阅是 React
   * 里做这件事的标准方式 —— 不引入额外状态库，也不需要把 `index.ts` 改造成 React。
   */
  subscribe?: (fn: () => void) => () => void;
}

/**
 * 槽位组件：把宿主的 `inject` 面接到 `KeyHintBar`。
 *
 * @param props - 宿主注入的 `KeyHintDockFace`（可能缺 `subscribe`，旧代次或契约变化时）。
 * @returns 提示行；无提示时为 null。
 */
export function KeyHintBarSlot(props: KeyHintDockFace): ReactElement | null {
  const { keyHintNow, subscribe } = props;
  // `subscribe` 缺席时退化成「只在挂载时读一次」——不会崩，只是不跟随更新。
  const hint = useSyncExternalStore(
    subscribe ?? (() => () => {}),
    keyHintNow,
    keyHintNow,
  );
  return <KeyHintBar hint={hint} />;
}
