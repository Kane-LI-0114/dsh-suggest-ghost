/**
 * 跟随宿主 DSH 界面语言的文案 hook（设置卡片用）。
 *
 * 宿主的 `@deepseek-ai/dsh-client-locale` 在 client context 上暴露 `locale`
 * 服务：`getSnapshot()` 返回携带 `active`/`revision` 的不可变快照，
 * `subscribe(fn)` 返回退订函数。本 hook 以 `useSyncExternalStore` 订阅其
 * active locale，宿主「设置 → General → Language」切换时组件无刷新重渲染。
 *
 * 语言的**收窄判据不在本文件**，在 `ghost-lang.ts`（那份判据要能被 strip-types
 * 冒烟直载，而本文件引了 react）。宿主 0.2.x 起注册的语言不止中英，
 * 非中文各门一律落英文 ⇒ 详见 `resolveGhostLang` 的注释。
 * @module dsh-suggest-ghost/client/useGhostT
 */
import { useCallback, useSyncExternalStore } from 'react';
import { resolveGhostLang, type GhostLang, type LocaleFaceLike } from './ghost-lang.js';

export type { GhostLang, LocaleFaceLike } from './ghost-lang.js';

const noopSubscribe = (): (() => void) => () => {};

/**
 * 返回当前应使用的语言 id；宿主语言切换时组件自动重渲染。
 * @param locale 宿主 locale 服务（经槽位 inject 注入；可为 undefined）。
 */
export function useGhostT(locale: LocaleFaceLike | undefined): GhostLang {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      locale === undefined ? noopSubscribe() : locale.subscribe(onStoreChange),
    [locale],
  );
  // locale 服务缺席 ⇒ undefined（= 旧宿主 ⇒ 中文），而不是伪造一个 'zh' 读数：
  // 「缺席」与「宿主说 zh」是两件事，压在一起下一句 `startsWith('zh')` 就分不出它们了。
  const getActive = useCallback(
    () => (locale === undefined ? undefined : locale.getSnapshot().active),
    [locale],
  );
  const active = useSyncExternalStore(subscribe, getActive, getActive);
  return resolveGhostLang(active);
}
