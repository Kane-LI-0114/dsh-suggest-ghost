#!/usr/bin/env node
/**
 * 续写载荷与当前草稿的对齐判定冒烟（纯函数 `alignCompletion` / `decideCompletionReuse`）。
 *
 * 覆盖四组：
 *  1. **主路径**（这是本次修复的动机）：用户在生成期间继续打字 —— 线上实测 46 次停顿里
 *     45 次草稿长度都不同，全等判据把这些全判成失效。
 *  2. **必须丢弃的形态**：改中间 / 换内容 / 删字（删字后光标位置未知，贴上可能错位）。
 *  3. **重叠裁剪**：你已经照着续写打下去了，幽灵只该补剩下的部分。
 *  4. **「亮灯但没字」的整序列复现**（第 4 组）：发出 complete → 用户删字 → 宿主终于
 *     推回旧草稿的续写。这一组跨模块只读地驱动 `pending-clock.ts` 的纯函数，断言的是
 *     **用户可见结果**（灯灭、无幽灵），以及"为什么不显示"的**理由分档**——旧代的失效
 *     与"改坏了"必须分开，否则排查时两者同形。
 */
import assert from 'node:assert/strict';
import { alignCompletion, decideCompletionReuse } from '../src/client/completion-align.ts';
import { startPending, tickPending } from '../src/client/pending-clock.ts';

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

// ── 1. 主路径：草稿未变 / 末尾继续打字 ──────────────────────────────────────
run('草稿未变：整段续写都是幽灵（原行为不变）', () => {
  const r = alignCompletion('帮我看一下', '帮我看一下', '这个插件的构建流程');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'exact');
  assert.equal(r.suffix, '这个插件的构建流程');
  assert.equal(r.full, '帮我看一下这个插件的构建流程');
});

run('末尾多打一个不相干的字：续写整段保留，接在当前草稿后', () => {
  // 实测形态：draft=18 / payload=17（用户多打 1 字，且与续写开头不重合）
  const r = alignCompletion('帮我看一下这个插件X', '帮我看一下这个插件', '的构建流程');
  assert.equal(r.ok, true, '这正是"边打边等"的主路径，不该被丢弃');
  assert.equal(r.kind, 'extended');
  assert.equal(r.suffix, '的构建流程', 'X 与续写不重合，一个字符都不该裁');
  assert.equal(r.full, '帮我看一下这个插件X' + '的构建流程', 'full 必须是当前草稿 + 裁剪后的后缀');
});

run('末尾多打 5 个字（实测 draft=20 / payload=15）', () => {
  const r = alignCompletion('abcdefghijklmnopqrst', 'abcdefghijklmno', 'XYZ 后半句');
  assert.equal(r.ok, true);
  assert.equal(r.suffix, 'XYZ 后半句');
});

// ── 2. 重叠裁剪：你已经照着续写打下去 ───────────────────────────────────────
run('已打出续写开头 1 字：幽灵只补剩下的', () => {
  // typedSince='构' 与续写 '构建流程是什么' 的公共前缀 = 1 → 裁掉「构」，幽灵补「建流程是什么」。
  const r = alignCompletion('帮我看看这个插件的构构', '帮我看看这个插件的构', '构建流程是什么');
  assert.equal(r.ok, true);
  assert.equal(r.suffix, '建流程是什么', '已打出的「构」必须被裁掉，否则重复显示');
  assert.equal(r.full, '帮我看看这个插件的构构' + '建流程是什么', 'full 必须与 suffix 一致');
});

run('已打出续写开头 3 字：裁掉 3 个', () => {
  const r = alignCompletion('前面构建流', '前面', '构建流程是什么');
  assert.equal(r.suffix, '程是什么', '「构建流」已打出，应从「程」开始补');
});

run('已把整段续写打完：无幽灵可显示（不是错误）', () => {
  const r = alignCompletion('前面构建流程', '前面', '构建流程');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty-text');
});

run('你打的字与续写开头不重合：整段续写保留（不误裁）', () => {
  const r = alignCompletion('前面ABC', '前面', '构建流程');
  assert.equal(r.ok, true);
  assert.equal(r.suffix, '构建流程', '不重合时不能裁任何字符');
});

// ── 3. 必须丢弃的形态 ───────────────────────────────────────────────────────
run('改了中间：丢弃（贴合上去会错位）', () => {
  const r = alignCompletion('帮我XX一下', '帮我看看一下', '这个插件');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'draft-mismatch');
});

run('删了末尾：丢弃（删字后光标位置未知，宁可少显示不可显错）', () => {
  // 实测形态：draft=27 / payload=28。仍然不显示；理由归到「这一代作废」（见 3b 组）。
  const r = alignCompletion('帮我看看这个插件的构', '帮我看看这个插件的构建', '流程是什么');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payload-superseded');
});

run('换了内容（当前远短于载荷）：丢弃（实测 draft=3 / payload=48）', () => {
  const r = alignCompletion('看看', 'x'.repeat(48), '后半句');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'draft-mismatch', '首字符就不同 = 换了内容，不是「往回删」');
});

// ── 3b. 「旧代失效」必须与「改坏了」分开（本次修复的判据）──────────────────────
//
// 两者都**不显示**，区别只在理由：`cur` 是 `payloadDraft` 的真前缀 ⇒ 用户把草稿往回删，
// 这一代续写只是作废（`payload-superseded`）；别的形态才是"草稿被改坏了"
// （`draft-mismatch`）。实测现场 `reason=draft-mismatch draftChars=1 payloadDraftChars=15`
// 正是前者 —— 理由错了，排查时就会往"对齐判据太严"的方向查，而实际是"这一轮没有下一轮"。
run('删到只剩 1 字（实测形态 draft=1 / payload=15）：理由必须是 payload-superseded', () => {
  const r = alignCompletion('帮', '帮我看一下这个插件的构建流程', '用的是什么');
  assert.equal(r.ok, false, '删字后光标位置未知，仍然不显示');
  assert.equal(r.reason, 'payload-superseded', '这是「这一代作废」，不是「草稿被改坏」');
});

run('删字但仍是载荷前缀（多个长度）：一律 payload-superseded', () => {
  const payloadDraft = '帮我看一下这个插件';
  for (const cur of ['帮', '帮我', '帮我看', '帮我看一下']) {
    assert.equal(alignCompletion(cur, payloadDraft, '的构建流程').reason, 'payload-superseded', `cur=${cur}`);
  }
});

run('改中间 / 换内容 / 首字符就不同：仍然是 draft-mismatch（分档不是放宽）', () => {
  assert.equal(alignCompletion('帮我XX一下', '帮我看看一下', '这个插件').reason, 'draft-mismatch');
  assert.equal(alignCompletion('换个话题', '帮我看一下', '这个插件').reason, 'draft-mismatch');
  // 载荷首字符都不同、当前又短于载荷：不是「删字」，是换了内容。
  assert.equal(alignCompletion('看看', 'x'.repeat(48), '后半句').reason, 'draft-mismatch');
});

run('空续写 / 空草稿：丢弃并给出可区分的原因', () => {
  assert.equal(alignCompletion('草稿', '草稿', '').reason, 'empty-text');
  assert.equal(alignCompletion('', '', '后半句').reason, 'empty-draft');
  assert.equal(alignCompletion('   ', '   ', '后半句').reason, 'empty-draft');
});

run('载荷草稿为空且当前草稿非空：整段续写作为幽灵（前缀恒成立）', () => {
  const r = alignCompletion('新打的字', '', '后半句');
  assert.equal(r.ok, true);
  assert.equal(r.suffix, '后半句');
});

// ── 4. 「亮灯但没字」的整序列复现（用户可见结果，不是单个分支）─────────────────
//
// 现场序列（确定性，非竞态）：
//
//   0.5s  停顿触发 → 客户端发出 complete(草稿A)，灯亮
//   0.8s  用户删字（草稿退到 1 字）→ 灯判「草稿不相干」立刻熄
//   4.5s  宿主按草稿A 生成完毕，推回 completion(草稿A, 续写)
//   ⇒     对齐判据丢弃载荷，这一帧什么都不显示，而且**没有下一轮**
//
// 用户看到的就是"灯亮过、但没有字"。这里把整条链路的终点钉住：灯必须灭（熄得对），
// 幽灵必须为空（丢得对），**但理由必须是"这一代作废"**——现场把它记成「改坏了」，
// 于是所有人的注意力都被引向"对齐判据太严"，而真正缺的是"这一轮没有续上"。
const MIN_VISIBLE = 1200;
const DEADLINE = 60_000;
const 草稿A = '帮我看一下这个插件的构建流程';

run('整序列：发出 complete → 用户删字 → 宿主推回旧续写（灯灭、无字、理由为旧代作废）', () => {
  // ① 写出 complete 的那一刻点亮。
  const started = startPending('s1', 草稿A, 1_000);
  const lit = tickPending(started, {
    now: 1_500, sessionId: 's1', draft: 草稿A, minVisibleMs: MIN_VISIBLE, deadlineMs: DEADLINE,
  });
  assert.equal(lit.lit, true, '写完 complete 必须立刻亮，不等任何往返');

  // ② 用户删字：灯按「草稿不再拥有这次生成」收口——这一条是**正确**的，不该被改。
  const 草稿B = '帮';
  const afterDelete = tickPending(started, {
    now: 1_800, sessionId: 's1', draft: 草稿B, minVisibleMs: MIN_VISIBLE, deadlineMs: DEADLINE,
  });
  assert.equal(afterDelete.lit, false, '删字后灯必须熄，否则用户会等一个永远不会来的结果');
  assert.equal(afterDelete.reason, 'draft-unrelated');

  // ③ 4 秒后宿主终于推回按草稿A 生成的那份续写。
  const aligned = alignCompletion(草稿B, 草稿A, '用的是什么工具链');
  assert.equal(aligned.ok, false, '旧代续写不能贴在新草稿后面（会错位）');
  assert.equal(
    aligned.reason,
    'payload-superseded',
    '这是「这一代作废」，不是「草稿被改坏了」——分档错了会让排查走反方向',
  );

  // ④ 整帧裁决：不显示，但不许把形态扣住（历史补全应自然回来，用户至少有东西可看）。
  const form = decideCompletionReuse({
    inlineEnabled: true,
    draft: 草稿B,
    payload: { draft: 草稿A, text: '用的是什么工具链' },
    payloadBelongsToCurrentSession: true,
    aligned,
  });
  assert.equal(form.show, false);
  assert.equal(form.holdHistory, false, '旧代作废 ≠ 同代裁空，不该扣住历史补全');
});

// ── 5. decideCompletionReuse：只回答「这一帧算不算 / 扣不扣」，绝不销毁载荷 ──────
run('载荷仍拥有草稿（未变 / 末尾续打）：算对齐，不扣历史', () => {
  for (const cur of [草稿A, `${草稿A}X`]) {
    const aligned = alignCompletion(cur, 草稿A, '的构建流程');
    const form = decideCompletionReuse({
      inlineEnabled: true, draft: cur,
      payload: { draft: 草稿A, text: '的构建流程' },
      payloadBelongsToCurrentSession: true, aligned,
    });
    assert.equal(form.show, true, `cur=${cur}`);
    assert.equal(form.holdHistory, false);
  }
});

run('同代裁空（整段续写已打完）：不显示，且扣住历史（#38 形态不得翻转）', () => {
  const cur = '前面构建流程';
  const aligned = alignCompletion(cur, '前面', '构建流程');
  assert.equal(aligned.reason, 'empty-text');
  const form = decideCompletionReuse({
    inlineEnabled: true, draft: cur,
    payload: { draft: '前面', text: '构建流程' },
    payloadBelongsToCurrentSession: true, aligned,
  });
  assert.equal(form.show, false);
  assert.equal(form.holdHistory, true, '同一次生成内不许从 inline 掉到 history');
});

run('旧代作废 / 改坏了 / 别的会话 / 开关关闭：都不显示，都不扣历史', () => {
  const cases = [
    { name: '删字', draft: '帮', payload: { draft: 草稿A, text: 'x' }, session: true, enabled: true },
    { name: '改中间', draft: '帮我XX一下', payload: { draft: '帮我看看一下', text: 'x' }, session: true, enabled: true },
    { name: '别的会话', draft: 草稿A, payload: { draft: 草稿A, text: 'x' }, session: false, enabled: true },
    { name: '开关关闭', draft: 草稿A, payload: { draft: 草稿A, text: 'x' }, session: true, enabled: false },
  ];
  for (const c of cases) {
    const aligned = c.session
      ? alignCompletion(c.draft, c.payload.draft, c.payload.text)
      : null;
    const form = decideCompletionReuse({
      inlineEnabled: c.enabled, draft: c.draft, payload: c.payload,
      payloadBelongsToCurrentSession: c.session, aligned,
    });
    assert.equal(form.show, false, c.name);
    assert.equal(form.holdHistory, false, `${c.name}：续写这一路没有在场，历史补全应自然回来`);
  }
});

run('载荷为 null（宿主未推）：不显示、不扣历史（其余三支共用同一份判据）', () => {
  const form = decideCompletionReuse({
    inlineEnabled: true, draft: 草稿A, payload: null,
    payloadBelongsToCurrentSession: true, aligned: null,
  });
  assert.equal(form.show, false);
  assert.equal(form.holdHistory, false);
});

console.log('');
if (failed > 0) {
  console.error(`❌ completion-align-smoke: ${failed} 组失败`);
  process.exit(1);
}
console.log('✅ completion-align-smoke: 全部用例通过');
