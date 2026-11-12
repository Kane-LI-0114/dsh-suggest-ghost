/**
 * 幽灵文本的**就地快捷键提示**（Gitea #157）。
 *
 * 问题：幽灵出现时界面上没有任何地方说明能按什么键 —— 说明只写在设置页的字段
 * 描述里（`settings-card.tsx`），用户不点进设置就看不到；而本插件的键位是
 * **可配置**的（`acceptKey` / `regenKey` / `wordAccept`），改过键的用户尤其容易
 * 忘了自己改成了什么。同类插件（`dsh-input-assist`）的做法是在建议出现时于输入框
 * 边上浮一行小字，采纳/关闭后自行消失。
 *
 * ## 为什么是独立节点，而不是塞进 overlay
 *
 * 三条都是 overlay 现有实现里写死的事实，任一条都会让「挂在 overlay 里」不可行：
 *
 *  1. overlay 的样式表写死 `pointer-events:none`（`index.ts` 的 `GhostOverlay`
 *     构造函数）⇒ 里面的提示既不可交互，也拦不住误点；
 *  2. `align()` 把 overlay 的 `width` **收窄成「行尾到行末」** ⇒ 提示行会被挤进
 *     那一小段宽度里折成好几行；
 *  3. `llm` 形态**没有行尾锚点**（`align()` 里 `end === null`，`left/top` 用内容
 *     原点）⇒ 不能假设「幽灵下方紧跟一行」。
 *
 * ⇒ 本模块自建一个 `<div>`，挂在与 overlay **同一个父**（`.grow`，宿主显式
 * `position:relative` 的 offsetParent）。父被换掉/节点被摘走时由调用方的
 * `ensureMounted()` 同款判据放回去（#152 那套自愈语义）。
 *
 * ## 文案是**动态拼的**
 *
 * 键名取自当前生效的设置（`acceptKey` / `regenKey` / `wordAccept`），不是硬编码：
 * 用户把采纳键改成 F2，提示行当场变成 F2。语言跟随宿主界面语言（调用方传入）。
 *
 * @module dsh-suggest-ghost/client/key-hint
 */

/** 提示节点在 DOM 里的稳定 id（取证与冒烟据此纯读 DOM 判断，不靠日志）。 */
export const KEY_HINT_ID = 'dsh-suggest-ghost-keyhint';

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

/**
 * 提示节点：只负责「画/擦」与定位，不持有任何状态机。
 *
 * 与 overlay 共享父节点 ⇒ 随内容一起滚动，不需要额外的滚动监听。位置用
 * `align()` 同款的内容坐标系（`.grow` 的 offsetParent 系），放在编辑器**正下方**：
 * `top = 编辑器底边 + 一段小间距`，`left` 对齐内容起点。
 */
export class KeyHintNode {
  private readonly el: HTMLDivElement;
  private composer: HTMLElement | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = KEY_HINT_ID;
    // 默认不绘制：与 overlay 一样用 `display`（不是 opacity），确保不参与布局。
    this.el.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      // 小字、次要色阶：它是「提示」不是「内容」，不能和幽灵抢注意力。
      'font-size:11px',
      'line-height:1.6',
      'color:var(--dsw-alias-label-tertiary, #8b8f94)',
      'white-space:nowrap',
      'display:none',
      'z-index:1',
    ].join(';');
    this.el.dataset.keyhint = '0';
  }

  /** 供自愈路径比对「节点现在挂在谁的下面」。 */
  get parent(): HTMLElement | null {
    return this.el.parentElement;
  }

  /** 是否已绘制（纯读状态，供冒烟与自检）。 */
  get isShown(): boolean {
    return this.el.dataset.keyhint === '1';
  }

  /** 只读的文本视图（供冒烟断言「文案是动态拼的」）。 */
  get text(): string {
    return this.el.textContent ?? '';
  }

  /**
   * 保证节点在场（#152 同款判据：**不看引用、看 `isConnected`**，否则父节点被
   * 重建后这里会直接 return，节点再也回不来）。
   *
   * @param composer - 当前输入框元素。
   * @returns 挂好之后是否真的在文档里。
   */
  ensureMounted(composer: HTMLElement): boolean {
    this.composer = composer;
    const parent = composer.parentElement;
    if (parent === null) return false;
    if (this.el.parentElement !== parent || !this.el.isConnected) {
      // 放在父节点末尾（overlay 也在其中）：两者互不重叠，顺序无关。
      parent.appendChild(this.el);
    }
    return this.el.isConnected;
  }

  /**
   * 显示提示（文案与定位一次算完）。
   *
   * @param input - 当前形态与设置，用于拼文案。
   * @param composer - 当前输入框元素。
   * @returns 是否真的显示出来了（父节点缺失 / 未挂载时为 false）。
   */
  show(input: KeyHintInput, composer: HTMLElement): boolean {
    if (!this.ensureMounted(composer)) {
      this.hide();
      return false;
    }
    this.el.textContent = keyHintText(input);
    this.position(composer);
    this.el.style.display = 'block';
    this.el.dataset.keyhint = '1';
    return true;
  }

  /** 隐藏并擦掉文本（避免留一行对不上任何状态的旧文案在 DOM 里）。 */
  hide(): void {
    if (this.el.dataset.keyhint === '0') return;
    this.el.style.display = 'none';
    this.el.textContent = '';
    this.el.dataset.keyhint = '0';
  }

  /**
   * 定位到编辑器正下方。
   *
   * 用 `offsetTop/offsetLeft`（与滚动无关的内容坐标系），与 overlay 的 `align()`
   * 同一套口径；不复制排版属性 —— 提示行是独立文本，不需要和编辑器逐像素对齐
   * （那正是 overlay 复杂度的来源，这里没有那个需求）。
   *
   * @param ta - 当前输入框元素。
   */
  private position(ta: HTMLElement): void {
    const style = getComputedStyle(ta);
    const padLeft = parseFloat(style.paddingLeft) || 0;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const left = ta.offsetLeft + borderLeft + padLeft;
    const top = ta.offsetTop + ta.offsetHeight + (parseFloat(style.marginBottom) || 0);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }
}
