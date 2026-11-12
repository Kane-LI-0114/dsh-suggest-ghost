/**
 * 存储域（storageDomain）的**进程级共享池**。
 *
 * ## 为什么需要它
 *
 * 宿主把同名域做成**进程内独占**：`dsh-storage-domain` 的 `open()` 在名字已被占用时
 * 抛 `domain 'X' is already open`。而本插件的持久化是按 **fiber** 建立与释放的
 * （`ctx.effect(() => () => close())`），于是有一个致命前提：**disposer 必须真的跑**。
 *
 * 实测这个前提不成立（live 进程 `~/.dsh/dsh-web.log`）：
 *
 *     hotness restore FAILED, staying in-memory: cannot create effect on inactive context
 *     hotness restore FAILED, staying in-memory: open rejected after 40 attempts:
 *       domain 'suggest_ghost_hotness' is already open      ×2
 *
 * 第一条说明：某个 fiber 在**已经失活**的 ctx 上还去挂 effect；后面两条是它的继任者
 * 在 6s（40×150ms）预算内**始终拿不到域**。磁盘上 2000 条数据完好，但重启后内存表从 0
 * 开始累积 —— 用户看到的就是「我的几千条历史没了」。
 *
 * ## 做法：把域从「fiber 所有」改成「进程所有」
 *
 * - 同名域在一个进程里**只 open 一次**，句柄存进本模块的 `Map`；
 * - 每个持有者拿到的是一份**租约**（lease），`release()` 只减引用；
 * - **引用归零也不立刻 close**：默认保留一个空闲期（{@link IDLE_CLOSE_MS}），
 *   期间新 fiber 直接复用 —— 这正是 HMR 重载的形状（旧死、新起，间隔毫秒级）；
 * - 进程退出时由 `process.on('exit')` 兜底关闭（同步，不 await）。
 *
 * 于是「disposer 没跑」从**致命**降级为**无害**：那个 fiber 的租约不再被释放，
 * 计数停在 1，域一直可用；继任者复用同一句柄，**不会再撞 already-open**。
 *
 * ## 边界（写清楚，免得后来者以为这解决了所有问题）
 *
 * - 只管**同进程内**的共享。多个 `dsh web` 进程同时开同一个 `DSH_HOME` 仍会互斥，
 *   那是宿主的锁语义，不归插件管 —— 但那种情况本来就该由用户避免（同一 home 双开）。
 * - 复用句柄意味着**旧 fiber 的 `flush()` 写链可能与新 fiber 并发**。本插件的写入是
 *   `table.put` 逐条、键为文本，幂等；且 `flush()` 用 `Promise.allSettled` 吞掉单条失败，
 *   不会互相覆盖成错误状态。
 * - **不做「等旧持有者关完再开」**：那条路要求旧 fiber 的 disposer 一定跑到，
 *   而实测它可能永远不跑 —— 等下去就是等一个不会到的事件。
 *
 * @module dsh-suggest-ghost/hotness-domain-pool
 */

/** 本模块依赖的最小域面（只取用到的方法，避免引宿主类型）。 */
export interface PooledDomain {
  /** 关掉句柄；幂等，调用方不必关心重复调用。 */
  close(): unknown;
}

/** 一次租约：`release()` 幂等。 */
export interface DomainLease<D extends PooledDomain> {
  readonly domain: D;
  /** 归还租约（只减引用，不一定关域）。重复调用安全。 */
  release(): void;
  /** 该租约是否已归还。诊断用。 */
  readonly released: boolean;
}

/** 池内一个条目的状态。 */
interface PoolEntry<D extends PooledDomain> {
  readonly domain: D;
  /** 未归还的租约数。**归零也不立刻关**，见模块注释。 */
  refs: number;
  /** 空闲关闭定时器（归零后启动）。 */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** 是否已关闭（关闭后条目移出 `Map`，此标志只防重入）。 */
  closed: boolean;
}

/**
 * 引用归零后**保留多久**再真正 `close()`。
 *
 * 取 30s：HMR 重载的「旧死→新起」实测在百毫秒量级，30s 足够覆盖；
 * 而进程在 30s 内不再需要它才是真的空闲长驻。太长会把文件句柄一直占着，
 * 太短则等于没有空闲期（又回到「各自 open / 各自 close」）。
 */
export const IDLE_CLOSE_MS = 30_000;

/**
 * 进程级域池。
 *
 * ⚠️ 用 `globalThis` 挂一份而不是模块级 `new Map()`：本插件在 HMR 下可能被加载成
 * **多份模块实例**（实测同一插件出现过 12 个 nonce 并存）。模块级变量会随实例各自
 * 一份，池就退化回「各自 open」，等于没修。`Symbol.for` 保证跨实例拿到同一个。
 */
const POOL_KEY = Symbol.for('dsh-suggest-ghost/hotness-domain-pool/v1');

type Pool = Map<string, PoolEntry<PooledDomain>>;

/** 取进程级池（跨模块实例共享）。 */
function pool(): Pool {
  const box = globalThis as unknown as Record<symbol, Pool | undefined>;
  let p = box[POOL_KEY];
  if (p === undefined) {
    p = new Map();
    box[POOL_KEY] = p;
  }
  return p;
}

/**
 * 进程退出时的兜底关闭注册表（只登记一次）。
 *
 * 必须在**同步**路径上关：`process.on('exit')` 里不能 await。域实现的 `close()`
 * 返回 Promise 也没关系 —— 宿主在进程退出时会由文件层自己 flush，这里只负责
 * 把「还挂着的名字」摘掉，让同一进程内的重开不撞锁。
 */
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // 只在真有 Node 进程钩子时挂（浏览器/手搓 ctx 里没有）。
  if (typeof process === 'undefined' || typeof process.on !== 'function') return;
  process.on('exit', () => {
    for (const [, entry] of pool()) {
      try {
        void entry.domain.close();
      } catch {
        /* 退出路径不问结果 */
      }
      entry.closed = true;
    }
    pool().clear();
  });
}

/**
 * 取一个域租约：已在池中则**复用**，否则用 `open` 新建。
 *
 * @param key - 域名（池的键，通常是 storageDomain 的 domain name）。
 * @param open - 池中缺席时的打开方式（**只在需要时调用**）。
 * @returns 租约；调用方在 fiber 结束时 `release()`。
 */
/** 打开失败时的重试预算（次数 × 间隔 ≈ 6s，与池化之前的值一致）。 */
export interface AcquireRetry {
  /** 最多尝试几次 open。池命中时**不消耗**这个预算。 */
  readonly attempts: number;
  /** 每次重试前的等待毫秒。 */
  readonly delayMs: number;
  /** 每次失败后的观察回调（留痕用，可为 undefined）。 */
  readonly onRetry?: (attempt: number, reason: string) => void;
}

/**
 * 取一个域租约：池里有就复用，没有就用 `open` 新建（失败按 `retry` 有限重试）。
 *
 * ⚠️ **池化与重试是两件事，都要保留**（这条是实测教训）：
 *  - 池化解决「**本进程内**已有句柄」——HMR 下旧 fiber 的 disposer 不跑，域被自己人占住；
 *  - 重试解决「**外部**占用」——例如另一个 `dsh web` 进程开着同一个 `DSH_HOME`，
 *    或者宿主正在释放。这种场面池里没有可用句柄，只能等。
 * 早先只做池化不做重试，`hotness-reload-restore-smoke` 的「前 3 次 open 被拒」场景
 * 当场变红 —— 它模拟的正是外部占用。
 *
 * @param key - 池键（域名）。
 * @param open - 池缺席时的打开方式（**只在需要时调用**）。
 * @param retry - 重试预算；省略则只尝试一次。
 * @returns 租约；调用方在 fiber 结束时 `release()`。
 */
export async function acquireDomain<D extends PooledDomain>(
  key: string,
  open: () => Promise<D>,
  retry?: AcquireRetry,
): Promise<DomainLease<D>> {
  installExitHook();
  const p = pool();
  const existing = p.get(key) as PoolEntry<D> | undefined;
  if (existing !== undefined && !existing.closed) {
    // ⚠️ 有空闲定时器就取消：这次复用说明它没被闲置，别让 30s 后把它关掉。
    if (existing.idleTimer !== null) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    existing.refs += 1;
    return makeLease(key, existing);
  }
  // 池里没有（或已关闭）：真去开一个新的（外部占用时按预算等）。
  const maxAttempts = retry === undefined ? 1 : Math.max(1, retry.attempts);
  const delayMs = retry === undefined ? 0 : Math.max(0, retry.delayMs);
  let domain: D | null = null;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      domain = await open();
      break;
    } catch (error) {
      const reason = String((error as { message?: unknown })?.message ?? error).slice(0, 60);
      if (attempt >= maxAttempts) throw new Error(`open rejected after ${attempt} attempts: ${reason}`);
      retry?.onRetry?.(attempt, reason);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  const entry: PoolEntry<D> = { domain, refs: 1, idleTimer: null, closed: false };
  p.set(key, entry as PoolEntry<PooledDomain>);
  return makeLease(key, entry);
}

/** 造一份租约（`release` 幂等）。 */
function makeLease<D extends PooledDomain>(key: string, entry: PoolEntry<D>): DomainLease<D> {
  let released = false;
  return {
    domain: entry.domain,
    get released() {
      return released;
    },
    release: () => {
      if (released) return;
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs > 0 || entry.closed) return;
      // 归零：**不立刻关**，给 HMR 的重启留窗口。
      if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => {
        void closeEntry(key, entry);
      }, IDLE_CLOSE_MS);
      // 不让这个定时器把进程钉住（冒烟里 ctx 是手搓的，没有正常卸载路径）。
      (entry.idleTimer as unknown as { unref?: () => void }).unref?.();
    },
  };
}

/**
 * 真正关闭并移出池。
 *
 * @param key - 池键。
 * @param entry - 待关闭条目。
 */
async function closeEntry(key: string, entry: PoolEntry<PooledDomain>): Promise<void> {
  if (entry.closed) return;
  entry.closed = true;
  if (entry.idleTimer !== null) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }
  const p = pool();
  if (p.get(key) === (entry as PoolEntry<PooledDomain>)) p.delete(key);
  try {
    await entry.domain.close();
  } catch {
    /* close 失败不该让调用方炸：名字已从池里摘掉，下次会重开 */
  }
}

/**
 * 当前池的**只读快照**（诊断与冒烟用；不暴露句柄内部）。
 *
 * @returns 每个域的未归还租约数。
 */
export function poolSnapshot(): ReadonlyArray<{ key: string; refs: number; closed: boolean }> {
  return [...pool().entries()].map(([key, e]) => ({ key, refs: e.refs, closed: e.closed }));
}

/**
 * 立刻清空池（**只给测试用**）。
 *
 * 生产路径永远不该调它：它会在仍有租约时硬关域，那正是本模块要避免的事。
 * 冒烟之间要隔离进程内状态，所以留这个出口，并在文档里写清用途。
 */
export async function __resetPoolForTests(): Promise<void> {
  const p = pool();
  const items = [...p.entries()];
  p.clear();
  for (const [, entry] of items) {
    entry.closed = true;
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    try {
      await entry.domain.close();
    } catch {
      /* 测试清理不问结果 */
    }
  }
}
