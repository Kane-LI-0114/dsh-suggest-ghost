/**
 * 建议生成失败的**一次性静默指示**（Gitea #165 方案 3）。
 *
 * ## 它要解决的问题
 *
 * issue 的原话是「装了、也启用了，就是没反应」。失败诊断其实一直是推给客户端的
 * （宿主 `_push` 里带 `error` 摘要），但**客户端从没读过那个键** ⇒ 整类失败在界面上
 * 与「这一回合模型恰好没有建议」完全同形，用户唯一的取证渠道是去翻会话日志。
 *
 * ## 三条设计约束（社区评审原则 1）
 *
 *  1. **不弹窗、不抢焦点**：不是 toast、不是 dialog，没有任何 `role="alert"`、
 *     没有自动聚焦、没有 `pointer-events` 命中（`none`）⇒ 用户点不到它，
 *     它也永远不会挡在光标与建议之间。
 *  2. **一次性**：内容是「宿主这一次推送带了这个失败」。下一次推送不带 `error`
 *     就自动收走，没有定时器、没有通知中心、没有历史。
 *  3. **不解释成故障报告**：只说「这次没生成出来 + 原因分类」，不臆断成因。
 *     按 issue 的成本段，判据（该不该降级）在宿主侧用错误码做，这里只是观测面。
 *
 * ## 为什么与键位提示共用 `conversation.input.overlay` 槽位
 *
 * 那条槽位是宿主输入卡片顶部的**零高度绝对定位锚点**：子项不参与 flex 布局、
 * 不占垂直空间、不可能压到对话正文（理由详见 `key-hint-bar.tsx` 模块注释）。
 * 用户已经两次否决了「寄生式绝对定位」与「塞进任务区」，所以这里不再自己算几何。
 *
 * 与键位提示的冲突：两者都用 `top:0`。它们**互斥**是结构性的——键位提示只在
 * 幽灵真的画出来（`overlay.isPainted`）时出现，而失败指示出现的时刻正是「没有幽灵」。
 *
 * @module dsh-suggest-ghost/client/failure-note
 */
import { useSyncExternalStore, type ReactElement } from 'react';

/** 指示在 DOM 上的稳定钩子（测试与冒烟据此纯读 DOM，不靠日志）。 */
export const FAILURE_NOTE_TESTID = 'dsh-suggest-ghost-failure-note';

/**
 * 一次失败的归一化描述。
 *
 * `reason` 由 `src/client/index.ts` 的 `suggestionFailureReason` 产出，是**留痕与
 * 文案共用**的稳定标签（分桶只按本插件自己写死的报文前缀，不依赖宿主措辞）。
 */
export interface SuggestionFailureNote {
  readonly reason: string;
}

/** 槽位 `inject` 提供的面。 */
export interface FailureNoteFace {
  /** 当前应显示的失败（null = 不渲染）。 */
  failureNow: () => SuggestionFailureNote | null;
  /** 订阅「失败出现/解除」。返回退订函数。 */
  subscribe?: (fn: () => void) => () => void;
}

/**
 * 理由标签 → 给用户看的一行短文案。
 *
 * **只报「这次没成功 + 大致方向」**，不给操作建议、不提设置项名字：按 issue 的选型，
 * 方案 1（改默认预算）明确「另议」，提示里出现"去调大 maxOutputTokens"就是在
 * 替产品做决定。文案走宿主界面语言（zh / en 两套，与 `key-hint-text.ts` 同规）。
 */
export const FAILURE_NOTE_TEXT: Readonly<Record<string, { readonly zh: string; readonly en: string }>> = {
  'max-tokens': {
    zh: '建议生成未完成：输出预算被推理内容用完',
    en: 'Suggestion incomplete: reasoning used up the output budget',
  },
  effort: {
    zh: '建议生成失败：该模型不支持所选推理档位',
    en: 'Suggestion failed: this model does not support the selected reasoning effort',
  },
  timeout: {
    zh: '建议生成超时',
    en: 'Suggestion timed out',
  },
  shape: {
    zh: '建议生成失败：模型返回了无法采纳的内容',
    en: 'Suggestion failed: the model returned unusable content',
  },
  config: {
    zh: '建议生成失败：配置不完整',
    en: 'Suggestion failed: incomplete configuration',
  },
  other: {
    zh: '建议生成失败（详见控制台留痕）',
    en: 'Suggestion failed (see console trace)',
  },
};

/**
 * 取一行文案；未知理由落 `other`。
 *
 * @param reason - 归一化理由标签。
 * @param lang - `'zh'` 走中文，其余走英文（与 `resolveGhostLang` 的结论对齐）。
 * @returns 一行纯文本。
 */
export function failureNoteText(reason: string, lang: 'zh' | 'en'): string {
  const row = FAILURE_NOTE_TEXT[reason] ?? FAILURE_NOTE_TEXT.other!;
  return lang === 'zh' ? row.zh : row.en;
}

/** 槽位组件收到的 props（宿主按槽位契约注入 `FailureNoteFace`）。 */
export interface FailureNoteProps extends FailureNoteFace {
  /**
   * 当前界面语言。与键位提示完全同规（`KeyHintInput.lang`）：由 `index.ts` 在
   * 快照里一并给出，而不是组件自己去读 locale 服务 —— 槽位组件拿不到 ctx。
   */
  lang?: 'zh' | 'en';
}

/**
 * 槽位里的失败指示组件。
 *
 * @param props - 见 `FailureNoteProps`。
 * @returns 一行弱化的小字；没有失败时返回 null（不留占位、不占空间）。
 */
export function FailureNote(props: FailureNoteProps): ReactElement | null {
  const { failureNow, subscribe, lang } = props;
  const note = useSyncExternalStore(
    subscribe ?? (() => () => {}),
    failureNow,
    failureNow,
  );
  if (note === null) return null;
  return (
    <div
      data-suggest-ghost-failure={FAILURE_NOTE_TESTID}
      // 不是 alert：它不打断、不需要确认，读屏软件也不该把它当紧急播报。
      // 用 status 语义（礼貌播报）而非 alert（打断式）正是「静默」的一半。
      role="status"
      aria-live="polite"
      style={{
        // 与键位提示同一套定位（零高度锚点、卡片顶部），见模块注释。
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 9,
        padding: '0 12px',
        lineHeight: '9px',
        fontSize: 9,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        // 比提示行更弱一档：它是"没发生什么"的说明，不该比建议本身显眼。
        color: 'var(--dsw-alias-label-quaternary, var(--dsw-alias-label-tertiary, #8b8f94))',
        opacity: 0.85,
        // 不抢焦点、不拦点击：用户打字时它的存在完全无感。
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      {failureNoteText(note.reason, lang === 'zh' ? 'zh' : 'en')}
    </div>
  );
}
