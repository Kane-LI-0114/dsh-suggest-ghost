/**
 * 生成中指示的**客户端在途状态机**——纯函数，零 DOM、零定时器。
 *
 * ## 为什么不直接用宿主推来的 `completionPending`
 *
 * 宿主确实有一个权威的在途位（`completionPending` Map），也已经随 `_push` 播报。
 * 但实测（2026-11-09，真实 GUI 采样 40 秒）它到客户端的时序**不可靠**：
 *
 * ```
 * +25s {caretGlow:1}  亮 1s
 * +26s {}             灭
 * +29s {caretGlow:1}  亮 2s
 * +31s {}             灭
 * +33s 出字
 * ```
 *
 * 一次健康续写在途 19~28 秒，指示却只在终点前闪了 1~2 秒。根因是 `_push` 走的
 * 「指纹判重 + 合并窗口 + settings 写盘」那条路会跳过中间态：一次写入可能根本没落盘，
 * 或者被紧随其后的状态覆盖。**让一个 1.6 秒的呼吸动画去承受这种时序噪声，用户看到的
 * 就是闪烁**，而不是"思考中"。
 *
 * 所以本模块把判据搬回客户端：**我们自己在什么时候发了 `complete`，自己最清楚**。
 * 宿主推送降级为「佐证」——它说的 `false` 只在没有本地在途时才有意义。
 *
 * ## 三条不变量
 *
 * 1. **起点精确**：写 `complete` 的那一刻点亮（`start`），不依赖任何网络往返。
 * 2. **终点及时**：收到续写 / 在途被抢先 / 判死，一律立刻熄（`settle`）。
 * 3. **两端都有兜底**：`minVisibleMs` 防"闪一下就灭"，`deadlineMs` 防"永远亮着"
 *    ——前者是对用户的诚实（1 秒的闪烁等于没说），后者是对系统的诚实（灯亮着但
 *    实际上早就结束了，比没有指示更糟）。
 *
 * @module dsh-suggest-ghost/client/pending-clock
 */

/** 一次本地在途的起点。 */
export interface PendingStart {
  /** 发起时的会话 id（切会话即收口）。 */
  readonly sessionId: string;
  /** 发起时的草稿（草稿被改到不相干时要收口）。 */
  readonly draft: string;
  /** 发起时刻（`Date.now()`）。 */
  readonly startedAt: number;
}

/** 当前本地在途状态（`null` = 不在途）。 */
export type PendingState = PendingStart | null;

/** 判定输入：当前时刻与用户此刻的草稿/会话。 */
export interface PendingTick {
  readonly now: number;
  readonly sessionId: string | null;
  readonly draft: string;
  /** 指示的最短可见时长（防闪烁）。 */
  readonly minVisibleMs: number;
  /** 指示的硬上限（防永远亮着）。 */
  readonly deadlineMs: number;
}

/** 一次 tick 的结论。 */
export interface PendingTickResult {
  /** 是否应当点亮。 */
  readonly lit: boolean;
  /** 收口原因（`still` = 继续亮，不是收口）。 */
  readonly reason: 'still' | 'idle' | 'expired' | 'session-changed' | 'draft-unrelated';
  /**
   * 若此刻收口会早于 `minVisibleMs`，返回还需要等的毫秒数（调用方据此排一个定时器）。
   * `0` = 不需要等待。
   */
  readonly waitMs: number;
}

/**
 * 点亮。覆盖旧的在途（同一时刻至多一个在途：与宿主「同会话单飞」的语义一致）。
 *
 * 不做"已有在途就忽略"的判重：新的 `complete` 一定对应更新的一次请求，旧的那次
 * 要么已被宿主 abort、要么即将被 abort，本地跟着换成新的才是对的。
 */
export function startPending(sessionId: string, draft: string, now: number): PendingState {
  return { sessionId, draft, startedAt: now };
}

/**
 * 逐帧判定当前应不应该亮。
 *
 * 顺序即优先级：**过期 > 换会话 > 草稿不相干 > 最短时长 > 继续亮**。
 * 最短时长只推迟"本来就会收口"的情况，绝不拦截真正的收口理由——否则换会话后
 * 还会有一盏属于旧会话的灯亮着，那是最难查的形态。
 */
export function tickPending(state: PendingState, input: PendingTick): PendingTickResult {
  if (state === null) return { lit: false, reason: 'idle', waitMs: 0 };

  const elapsed = input.now - state.startedAt;

  // ① 硬上限：宿主可能永远不 settle（挂住、进程卡死），灯不能跟着挂住。
  if (elapsed >= input.deadlineMs) return { lit: false, reason: 'expired', waitMs: 0 };

  // ② 换会话：不属于当前会话的灯一律熄（归属守卫，与幽灵的 sessionId 守卫同款）。
  if (input.sessionId !== state.sessionId) return { lit: false, reason: 'session-changed', waitMs: 0 };

  // ③ 草稿变成与发起时不相干（删字/改中间）：宿主那边一定会 abort，本地不必等它通知。
  //    「只是变长」不算——那是 #33 的「边打边等」，两边的判据必须一致。
  if (!input.draft.startsWith(state.draft)) return { lit: false, reason: 'draft-unrelated', waitMs: 0 };

  // ④ 最短可见时长：已经到这个点了还不熄，说明这次生成确实在跑，继续亮。
  //    （最短时长**不**制造新的点亮——不在途就是不在途，见上面的 `state === null`。）
  return { lit: true, reason: 'still', waitMs: 0 };
}

/**
 * 宿主明确说「不在途」时是否采信。
 *
 * 只有当本地**没有**在途时才采信：本地有在途说明我们刚发过 `complete`，而宿主的
 * `false` 很可能是上一个请求的陈旧回声（`_push` 的合并窗口会让它晚到）。
 * 采信早了就是"发出去立刻被自己按灭"——这正是要修的那个闪烁。
 *
 * @param local - 本地在途状态。
 * @param hostPending - 宿主载荷里的 `completionPending`。
 * @returns 是否要让本地状态跟随宿主熄灭。
 */
export function shouldFollowHostFalse(local: PendingState, hostPending: boolean): boolean {
  if (hostPending) return false;
  return local === null;
}
