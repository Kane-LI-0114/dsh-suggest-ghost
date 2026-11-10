#!/usr/bin/env node
/**
 * 生成中指示的**客户端在途状态机**冒烟（`src/client/pending-clock.ts`）。
 *
 * ## 它要钉的是"用户能看到的那段时间"
 *
 * 真实 GUI 实测（2026-11-09，采样 40 秒）暴露出宿主推来的在途位不可靠：
 *
 * ```
 * +25s 亮 1s → +26s 灭 → +29s 亮 2s → +31s 灭 → +33s 出字
 * ```
 *
 * 一次健康续写在途 19~28 秒，指示却只在终点前闪了 1~2 秒。**用户要的是
 * "开始生成就亮，一直亮到出字"**，不是"终点前闪两下"。
 *
 * 所以判据搬回客户端：我们自己在写 `complete` 的那一刻点亮。本文件钉住三件事：
 *
 *  1. **起点精确**：`startPending` 之后立刻 `lit`，不需要任何等待；
 *  2. **终点及时**：换会话 / 草稿变成不相干 / 过期，三条都必须收口；
 *  3. **不闪**：最短可见时长内的收口不会被"提前"兑现（由调用方的定时器负责延后），
 *     但**真正的收口理由绝不因为最短时长而被拦下**——换会话后还亮着旧会话的灯，
 *     是最难查的形态。
 *
 * 用法：node --experimental-strip-types scripts/pending-clock-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  shouldFollowHostFalse,
  startPending,
  tickPending,
} from '../src/client/pending-clock.ts';

let passed = 0;
const run = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

const client = readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8');

const MIN = 1200;
const DEADLINE = 60_000;
/** 一个明确小于上限的偏移（可读性用）。 */
const US_MARGIN = 1;
const base = { minVisibleMs: MIN, deadlineMs: DEADLINE };
const tickAt = (state, ms, over = {}) => tickPending(state, {
  now: 1000 + ms, sessionId: 's1', draft: '帮我看看这次', ...base, ...over,
});

console.log('\n—— 起点：写完 complete 就亮，不等任何往返 ——');

run('不在途时 lit 为 false', () => {
  assert.equal(tickPending(null, { now: 0, sessionId: 's1', draft: '', ...base }).lit, false);
});

run('startPending 之后同一刻立即可见（0ms 也算亮）', () => {
  const st = startPending('s1', '帮我看看这次', 1000);
  assert.equal(tickAt(st, 0).lit, true, '点亮后第一帧没亮：那说明还要等一次往返，正是要修的病');
});

run('持续在途期间一直亮（覆盖真实 19~28 秒区间的抽样）', () => {
  const st = startPending('s1', '帮我看看这次', 1000);
  for (const ms of [100, 1000, 5000, 12_000, 19_000, 24_000, 28_000]) {
    assert.equal(tickAt(st, ms).lit, true, `${ms}ms 处灭了：这段正是用户该看到"思考中"的时间`);
  }
});

console.log('\n—— 终点：三条收口理由都必须兑现 ——');

run('换会话立刻收口（不允许留一盏属于旧会话的灯）', () => {
  const st = startPending('s1', '帮我看看这次', 1000);
  const r = tickAt(st, 100, { sessionId: 's2' });
  assert.equal(r.lit, false);
  assert.equal(r.reason, 'session-changed');
});

run('草稿被改成不相干内容立刻收口（宿主那边一定 abort）', () => {
  const st = startPending('s1', '帮我看看这次', 1000);
  const r = tickAt(st, 100, { draft: '完全不同的内容' });
  assert.equal(r.lit, false);
  assert.equal(r.reason, 'draft-unrelated');
});

run('草稿只是变长不收口（#33 边打边等，两边判据必须一致）', () => {
  const st = startPending('s1', '帮我看看这次', 1000);
  const r = tickAt(st, 100, { draft: '帮我看看这次改动里' });
  assert.equal(r.lit, true, '变长就熄：会和宿主的 keep 判据打架，表现成"打字时灯狂闪"');
});

run('到达硬上限必须熄（宿主卡死时灯不能跟着挂住）', () => {
  const st = startPending('s1', '帮我看看这次', 1000);
  const r = tickAt(st, DEADLINE);
  assert.equal(r.lit, false);
  assert.equal(r.reason, 'expired');
});

run('硬上限之内不熄', () => {
  const st = startPending('s1', '帮我看看这次', 1000);
  assert.equal(tickAt(st, DEADLINE - US_MARGIN).lit, true);
});

console.log('\n—— 不闪：最短可见时长与"真正的收口理由"互不干扰 ——');

run('最短可见时长不制造新的点亮（不在途就是不在途）', () => {
  const r = tickPending(null, { now: 0, sessionId: 's1', draft: '', minVisibleMs: 5000, deadlineMs: DEADLINE });
  assert.equal(r.lit, false, '最短时长把"没在途"点着了：灯会凭空亮');
});

run('最短可见时长不拦真正的收口理由（换会话仍然立刻熄）', () => {
  const st = startPending('s1', '帮我看看这次', 1000);
  const r = tickAt(st, 1, { sessionId: 's2', minVisibleMs: 10_000 });
  assert.equal(r.lit, false, '最短时长拦住了换会话收口：旧会话的灯会亮到下一次事件');
});

console.log('\n—— 宿主 false 的采信规则（A 方案的关键取舍）——');

run('本地有在途时，宿主的 false 不采信（那是上一个请求的陈旧回声）', () => {
  const st = startPending('s1', '帮我看看这次', 1000);
  assert.equal(shouldFollowHostFalse(st, false), false, '采信了：发出去立刻被自己按灭，就是观测到的闪烁');
});

run('本地空着时，宿主的 false 无副作用', () => {
  assert.equal(shouldFollowHostFalse(null, false), true);
});

run('宿主就是 true 时从不"跟随熄灭"', () => {
  assert.equal(shouldFollowHostFalse(null, true), false);
  assert.equal(shouldFollowHostFalse(startPending('s1', 'x', 0), true), false);
});

console.log('\n—— 接线守卫：点亮/熄灭必须挂在正确的位置 ——');

run('点亮挂在写出 complete 的同一处（不是别的地方）', () => {
  const at = client.indexOf("op: 'complete'");
  assert.ok(at > 0, '找不到 complete op 的构造处');
  const around = client.slice(Math.max(0, at - 900), at);
  assert.match(around, /lightLocalPending\(armedSessionId, draftNow\)/,
    '写出 complete 之前没有点亮：那灯就只能等宿主推送，正是要修的病');
});

run('熄灭挂在载荷应用处，且区分「有续写」与「宿主说不在途」', () => {
  const at = client.indexOf('settings = next;');
  assert.ok(at > 0);
  const around = client.slice(at, at + 2000);
  assert.match(around, /localPending = null/, '载荷到达处没有收口逻辑：灯会亮到下次无关事件');
  assert.match(around, /shouldFollowHostFalse/, '没有用 shouldFollowHostFalse 判宿主 false');
});

run('render 用的是本地判据（不是直接看宿主在途位）', () => {
  const at = client.indexOf('overlay.syncPendingStyle(');
  assert.ok(at > 0);
  const call = client.slice(at, at + 300);
  assert.match(call, /pendingLitNow\(/, 'render 直接用了宿主完成位：时序不可靠，会闪');
});

run('有兜底定时器（宿主一次都不推时也能收口）', () => {
  assert.match(client, /PENDING_DEADLINE_MS \+ 50/, '没有兜底重绘：推送全被吞时灯会一直亮');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : ''}\n`);
