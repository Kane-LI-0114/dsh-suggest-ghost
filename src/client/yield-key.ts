/**
 * 「这个键是不是别人认领了」——Gitea #166 方案 A 的判据本体（纯逻辑，零 DOM）。
 *
 * ## 为什么单独成文件
 *
 * 让路语义只有在**本插件的处理器跑在别人之后**时才可能成立。前半句是注册阶段的事
 * （`index.ts` 把 keydown 从 window 捕获改到冒泡），后半句是这里的判据：
 * `event.defaultPrevented === true` ⇒ 有人已经为这一键调过 `preventDefault()` ⇒
 * 本插件让路：不写草稿、不 `stopPropagation`、也不替它 `preventDefault`
 * （那个键归它，默认动作由它决定）。
 *
 * 拆成纯函数有两个理由：一是让 `scripts/tab-ownership-smoke.mjs` 能直载做判定
 * （`.tsx` 不能被 strip-types 加载，与 `keyspec.ts` 同款拆法）；二是这条判据的
 * 边界必须能被单独钉住 —— 工单正文已经把报告人的原始建议更正过一次：
 * **在 window 捕获阶段读 `defaultPrevented` 恒为 `false`**，所以「光加判据」拦不住
 * 任何东西（见冒烟第 1 节最后一条）。
 *
 * @module dsh-suggest-ghost/client/yield-key
 */

/** 让路判据所需的全部输入（不读别的字段，避免把注册顺序之类的实现细节漏进判据）。 */
export interface YieldProbe {
  /** `event.defaultPrevented`：此刻是否已有人为这一键调过 `preventDefault()`。 */
  readonly defaultPrevented?: boolean;
}

/**
 * 是否让路。
 *
 * @returns `true` = 别人认领了这个键，本插件什么都不做。
 */
export function shouldYieldKey(event: YieldProbe): boolean {
  return event.defaultPrevented === true;
}

/** 认领后的动作清单（写成数据而不是散在各分支里，方便断言"没吞键"）。 */
export interface YieldAction {
  /** 让路（什么都不做）。 */
  readonly yield: boolean;
  /** 是否由本插件 `preventDefault()`。 */
  readonly preventDefault: boolean;
  /** 是否由本插件 `stopPropagation()`。 */
  readonly stopPropagation: boolean;
  /** 诊断理由。 */
  readonly reason: 'claimed-by-outer' | 'ownerless';
}

/**
 * 让路 / 接管的完整动作集合。
 *
 * 让路支：三个动作全 `false` —— 尤其**不** `stopPropagation`：别人先认领之后仍可能有
 * 更外层的处理器要看这个事件（如全局快捷键表、无障碍层），本插件没有资格替他们截断。
 */
export function decideYieldAction(event: YieldProbe): YieldAction {
  if (shouldYieldKey(event)) {
    return { yield: true, preventDefault: false, stopPropagation: false, reason: 'claimed-by-outer' };
  }
  return { yield: false, preventDefault: true, stopPropagation: true, reason: 'ownerless' };
}
