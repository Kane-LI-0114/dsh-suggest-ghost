#!/usr/bin/env node
/**
 * 域池的冒烟（Gitea #157 的连带问题：重启后热表从 0 开始累积）。
 *
 * ## 这条脚本存在的理由
 *
 * 现场事故（`~/.dsh/dsh-web.log`）：
 *
 *     hotness restore FAILED, staying in-memory: cannot create effect on inactive context
 *     hotness restore FAILED, staying in-memory: open rejected after 40 attempts:
 *       domain 'suggest_ghost_hotness' is already open      ×2
 *
 * 磁盘 2000 条完好，但重启后内存表只有 9 条 —— 用户看到的是「我的几千条历史没了」。
 *
 * 旧实现的释放依赖 `ctx.effect` 的 disposer，而 HMR 时不保证它跑。**本脚本测的正是
 * 这个前提被打破时的行为**：用一个「不调用 release 的租约」模拟死掉的 fiber，
 * 断言继任者仍能拿到**同一个**域实例（而不是撞 already-open 后降级）。
 *
 * ## 判据
 *
 *  1. 同 key 第二次 acquire 复用**同一个句柄**，且 `open()` 只被调用 1 次；
 *  2. 旧租约**永不释放**（模拟 disposer 不跑）时，新租约照样拿得到；
 *  3. `release()` 幂等，重复调用不会把别人的租约减掉；
 *  4. 归零后**不立刻关**（空闲期内复用同一个句柄）；
 *  5. `__resetPoolForTests()` 真的关掉句柄（测试隔离本身要可信）。
 *
 * 用法：`node --experimental-strip-types scripts/hotness-domain-pool-smoke.mjs`
 */
import assert from 'node:assert/strict';
import {
  acquireDomain,
  poolSnapshot,
  __resetPoolForTests,
  IDLE_CLOSE_MS,
} from '../src/hotness-domain-pool.ts';

let passed = 0;
const run = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};
const runAsync = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
};

/** 造一个假域（记录 open/close 次数）。 */
const makeFakeDomain = () => {
  const state = { opens: 0, closes: 0 };
  const open = async () => {
    state.opens += 1;
    return {
      id: `dom-${state.opens}`,
      close: () => {
        state.closes += 1;
      },
    };
  };
  return { state, open };
};

console.log('\n—— 域池：同 key 复用 ——');
{
  const { state, open } = makeFakeDomain();
  const a = await acquireDomain('k1', open);
  const b = await acquireDomain('k1', open);
  run('两次 acquire 复用同一个句柄', () => assert.equal(a.domain, b.domain));
  run('open() 只被调用 1 次', () => assert.equal(state.opens, 1));
  run('引用计数为 2', () => {
    const snap = poolSnapshot().find((x) => x.key === 'k1');
    assert.equal(snap?.refs, 2);
  });
  a.release();
  b.release();
}

console.log('\n—— 关键判据：disposer 不跑（租约永不归还）时，继任者仍能拿到域 ——');
await runAsync('旧租约不释放，新租约照样拿得到同一个句柄', async () => {
  const { state, open } = makeFakeDomain();
  // 模拟 fiber#1：拿到域后「死了」，release 永远不调用
  const dead = await acquireDomain('k2', open);
  assert.ok(dead.domain);
  // 模拟 fiber#2（HMR 之后的继任者）：应当复用，而不是 open 抛 already-open
  const next = await acquireDomain('k2', open);
  assert.equal(next.domain, dead.domain, '继任者没有复用同一个句柄');
  assert.equal(state.opens, 1, 'open() 又被调用了一次 —— 这正是真实的 already-open 现场');
  next.release();
});

console.log('\n—— release 幂等 ——');
await runAsync('重复 release 不会把别人的租约减掉', async () => {
  const { open } = makeFakeDomain();
  const a = await acquireDomain('k3', open);
  const b = await acquireDomain('k3', open);
  a.release();
  a.release();
  a.release();
  const snap = poolSnapshot().find((x) => x.key === 'k3');
  assert.equal(snap?.refs, 1, '三次 release 只用减一次');
  b.release();
});

console.log('\n—— 空闲期：归零后不立刻关 ——');
await runAsync('全部释放后句柄仍在池里（空闲期未到）', async () => {
  const { state, open } = makeFakeDomain();
  const a = await acquireDomain('k4', open);
  a.release();
  const snap = poolSnapshot().find((x) => x.key === 'k4');
  assert.ok(snap !== undefined, '刚释放就把条目删了 —— 空闲期没生效');
  assert.equal(state.closes, 0, '刚释放就 close 了');
  // 空闲期内再次 acquire 必须复用（且取消定时器）
  const b = await acquireDomain('k4', open);
  assert.equal(state.opens, 1, '空闲期内没有复用');
  b.release();
});

run('空闲期是正数常量（0 等于没有空闲期）', () => {
  assert.ok(IDLE_CLOSE_MS > 0, IDLE_CLOSE_MS);
  assert.ok(IDLE_CLOSE_MS >= 5_000, '空闲期太短，覆盖不了 HMR 重启窗口');
});

console.log('\n—— 测试隔离本身可信 ——');
await runAsync('__resetPoolForTests 真的关掉句柄且池清空', async () => {
  const { state, open } = makeFakeDomain();
  const a = await acquireDomain('k5', open);
  assert.ok(a.domain);
  await __resetPoolForTests();
  assert.equal(state.closes, 1, 'reset 没关句柄');
  assert.equal(poolSnapshot().length, 0, 'reset 后池不为空');
});

console.log(`\n${passed} 项通过${process.exitCode ? '，有失败' : ''}\n`);
