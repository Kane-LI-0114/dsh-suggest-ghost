/**
 * 界面语言判据（纯函数，零依赖）。
 *
 * 单独成文件与 `key-hint-text.ts` 是同一个理由：`.ts` 里不能引 react，否则
 * `scripts/ghost-lang-smoke.mjs` 无法用 `--experimental-strip-types` 直载源码
 * （`docs/gitea-workflow.md` §3 那条「改 src 不重建就跑冒烟会假绿」的坑，直载源码
 * 是唯一便宜的防法）。`useGhostT.ts` 只保留 hook 本体，判据从本文件导入。
 *
 * @module dsh-suggest-ghost/client/ghost-lang
 */

/** 本插件收录的界面语言 id（zh 为源语言，en 为翻译目标，也是其余各门的落点）。 */
export type GhostLang = 'zh' | 'en';

/** 宿主 locale 服务的结构化子集（避免引入运行时包类型依赖）。 */
export interface LocaleFaceLike {
  /** 当前不可变快照（变更前引用稳定；`active` 为语言 id）。 */
  getSnapshot(): { active: string; revision: number };
  /** 订阅快照变化；返回退订函数。 */
  subscribe(fn: () => void): () => void;
}

/**
 * 把宿主的 active locale 收窄到本插件收录的那两门。**判据的唯一来源**——
 * 设置卡片（`useGhostT`）、设置页导航条目名（`sectionLabel`）、幽灵键位提示
 * （`activeLang`）三处都走它，不许各自再抄一遍（`src/transcript.ts` 里
 * `uiPriorLanguage` 那份「判据只有一处，否则第四份判据就这么长出来」的教训）。
 *
 * 三种输入三种语义，**不能塌成一个默认值**：
 *  - `undefined`（locale 服务缺席 = 旧宿主组合，0.1.x 那几代）→ `zh`：那批宿主本身
 *    没有多语言界面，改造前的行为就是中文，保持不变（README 对外承诺的也是这条）；
 *  - `zh*` → `zh`：源语言；带区域子标签的读数（`zh-CN`/`zh-TW`）同归中文；
 *  - 其余一切（`en` / `ja` / `es` / `fr` / `de` / `ru` / `pt` / 未收录 id）→ `en`。
 *
 * 第三支是本文件存在的理由。宿主 `@deepseek-ai/dsh-client-locale`（0.2.x 实测
 * `lib/client.js:1806`）用 `addLanguage` 在 `zh`/`en` 之外**又注册了 6 门**，
 * 且每一门写的都是 `fallback: "en"`；内核的 `assertFallbackChain` 甚至强制
 * 「任何一门的完整回退链必须抵达英文」，抵达不了就拒绝注册。也就是说宿主对
 * 非中文用户已经明确决定落到英文。本插件只有 zh/en 两套文案，英文是唯一与宿主
 * 自身决策一致的选项 —— 旧写法（三处各自 `=== 'en' ? 'en' : 'zh'`）把 6 门全部
 * 折成中文，等于在日文、俄文用户的界面上印出一张中文卡片：**把宿主已经做对的
 * 事改错了**。`dsh-later` 迁到 8 门字典（`src/locales/locale-id.ts` 记着同一个
 * 事实），那是补翻译的解法；本文件是不补翻译时的解法，两条都比「折成中文」对。
 * @param active - 宿主快照里的语言 id；`undefined` 表示 locale 服务缺席。
 */
export function resolveGhostLang(active: string | undefined): GhostLang {
  if (active === undefined) return 'zh';
  if (active.startsWith('zh')) return 'zh';
  return 'en';
}
