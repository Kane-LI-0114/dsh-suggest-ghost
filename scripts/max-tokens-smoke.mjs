#!/usr/bin/env node
/**
 * 输出预算撞顶降级（Gitea #165 方案 2 + 3）冒烟。
 *
 * ## 它挡的是哪几类事故
 *
 * 1. **白烧三趟 doomed 请求**。默认 `maxOutputTokens = 512` 遇上推理模型时，思考
 *    token 会先把预算吃光 ⇒ 终止帧 `finish.kind === 'max-tokens'`。修复前这条错误
 *    走的是**常规重试链**（`maxAttempts = 3`），同一份 512 预算被重发三次，每回合
 *    白烧三趟注定失败的推理请求，而界面上什么都没发生（#165 的证据链第 4 条）。
 *    修法是「撞顶即放大预算、同回合只重发一次、不占常规重试预算」。
 * 2. **降级判据漂成报文匹配**。撞顶是 `FinishReason.kind` 的直接转写，判据必须是
 *    稳定 code（本仓口径 *never parse the result; route on code*，见
 *    `src/generate.ts` 的 `isUnsupportedEffort` 上方那段）。一旦有人把它写成
 *    `/maxOutputTokens/`，改一句措辞就静默失效，而失效形态正是"用户又回到装了没反应"。
 * 3. **放大变成烧 token 的死循环**。放大现在会**连续进行**（512→1024→2048→4096，
 *    见下方 `escalateMaxTokens` 上方那张实测表：1024 这一跳救不回重推理模型），
 *    所以终止性不能再靠「只重发一次」的布尔闸门，而靠 `escalateMaxTokens` 的两条
 *    停止条件 + `ceiling` 的结构上界。这里同时钉住**结构**（两处共用一个纯函数、
 *    不再有布尔闸门）与**行为**（逐跳到 ceiling 后不再涨、不无限重试）。
 * 4. **观测面缺口**。宿主一直把失败摘要拼进 `_push.error`，而客户端过去既没声明
 *    这个键、也没有任何地方消费它 ⇒ 诊断在类型层被保证丢弃（证据链第 6 条）。
 *
 * ## 三态口径（docs/gitea-workflow.md §5）
 *
 * 本文件全部是 PASS/FAIL 判定，没有 NOT-COVERED 分支：它驱动的是构建产物里
 * 的真实函数（`lib/generate.js`），不需要宿主、网络或 DOM。**真宿主**那条
 * （推理模型 + 默认 512 跑一个完成回合、截图）不在本脚本能力范围内，见 PR 说明。
 *
 * ## 为什么从 lib/ 导入
 *
 * 与 `scripts/reasoning-effort-smoke.mjs` 同一取舍：`generate.ts` 里有 `using`
 * 声明，`node --experimental-strip-types` 剥不动。改完 `src/` 必须先重建
 * （`./node_modules/.bin/tsc -p tsconfig.json && node build.mjs`），否则测的是旧字节码
 * （§3 那条实测踩过的坑）。
 *
 * 用法：node scripts/max-tokens-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_TOKENS_ESCALATION_CEILING,
  MAX_TOKENS_STOP_CODE,
  escalateMaxTokens,
  generateCompletion,
  generateSuggestion,
  isMaxTokensStop,
} from '../lib/generate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let failed = 0;
let cases = 0;
const run = async (name, fn) => {
  cases += 1;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
};

// ── 夹具（沿用 reasoning-effort-smoke.mjs 的形状，只加「撞顶」这一种流） ──────────
const userMsg = (seq, text) => ({
  type: 'user/message', seq, time: 0,
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
});
const asstMsg = (seq, text) => ({
  type: 'assistant/message', seq, time: 0,
  data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
});
const turnStart = (seq, turn) => ({ type: 'turn/start', seq, time: 0, data: { turn } });
const turnEnd = (seq, turn) => ({ type: 'turn/end', seq, time: 0, data: { turn, reason: { kind: 'completed' } } });

const fakeSession = () => ({
  id: 'session-max-tokens-smoke',
  snapshotEvents: () => [
    turnStart(1, 1), userMsg(2, '把冒烟跑一遍'), asstMsg(3, '跑完了，全绿。'), turnEnd(4, 1),
  ],
  requestHeader: () => ({ config: { provider: 'p-smoke', model: 'm-smoke' } }),
});

const baseConfig = (over = {}) => ({
  provider: 'p-smoke',
  model: 'm-smoke',
  maxInputBytes: 4096,
  maxOutputTokens: 512,
  timeoutMs: 5000,
  maxTranscriptChars: 12000,
  maxSuggestionChars: 240,
  ...over,
});

/** 一次「预算撞顶」的流：只给终止帧，正文一个字都没有。 */
const maxTokensStream = () => (async function* () {
  yield { type: 'finish', reason: { kind: 'max-tokens' } };
})();

/** 正常流：一条 text-delta + finish(stop)。 */
const textStream = (text) => (async function* () {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
})();

const fakeCtx = (script) => {
  const calls = [];
  return {
    calls,
    llm: {
      stream(options) {
        calls.push(options);
        return script(options, calls.length);
      },
    },
  };
};
const abortOf = () => new AbortController().signal;

// ── 1. 判据：只认 code，不认报文 ────────────────────────────────────────────────
await run('isMaxTokensStop：认稳定 code；报文相同但没有 code 的错误**不算**', () => {
  const coded = new Error('whatever wording'); coded.code = MAX_TOKENS_STOP_CODE;
  assert.equal(isMaxTokensStop(coded), true, '带 code 的撞顶错误必须被判中');
  // 反向：这是本仓纪律的要害——措辞不是契约。
  assert.equal(isMaxTokensStop(new Error('dsh-suggest-ghost: suggestion output reached maxOutputTokens')), false,
    '没有 code 时**不得**按报文判成撞顶（否则改一句措辞就让降级静默失效）');
  assert.equal(isMaxTokensStop({ code: 'UNSUPPORTED_REASONING_EFFORT' }), false, '别的 code 不得误判');
  assert.equal(isMaxTokensStop(undefined), false, 'undefined 不能抛');
  assert.equal(isMaxTokensStop(null), false);
  assert.equal(isMaxTokensStop('boom'), false);
});

await run('escalateMaxTokens：2 倍步长、ceiling 封顶、可连续放大（纯函数两条停止条件）', () => {
  // 步长：每一跳 ×2（这是「思考占比约一半」的最小整数倍，见 src 注释）。
  assert.equal(escalateMaxTokens(512), 1024, '默认 512 应放到 1024');
  assert.equal(escalateMaxTokens(1024), 2048);
  assert.equal(escalateMaxTokens(2048), MAX_TOKENS_ESCALATION_CEILING, '2048×2 恰好落到上限');

  // 停止条件 ①：到顶不放（否则上限形同虚设）。
  assert.equal(escalateMaxTokens(MAX_TOKENS_ESCALATION_CEILING), undefined,
    '已在上限时不得再放大');
  assert.equal(escalateMaxTokens(5000), undefined, '用户自己配得比上限高时不得"放大"');

  // 停止条件 ②：放大后必须**严格大于**当前 ⇒ 非法/零/负预算一律不放。
  assert.equal(escalateMaxTokens(0), undefined, '非法预算不放大');
  assert.equal(escalateMaxTokens(Number.NaN), undefined, 'NaN 不放大');
  assert.equal(escalateMaxTokens(-8), undefined, '负数不放大');

  // **连续性**（#165 方案 (a) 的核心）：从默认 512 起必须能连放到 4096。
  // 实测 1024 救不回重推理模型（512/1024/2048 全是 choices=0，只有 4096 出结果），
  // 所以「只放大一次」的旧设计在这条断言下必须红。
  const chain = [];
  let cur = 512;
  for (let i = 0; i < 10; i += 1) {
    const next = escalateMaxTokens(cur);
    if (next === undefined) break;
    chain.push(next);
    cur = next;
  }
  assert.deepEqual(chain, [1024, 2048, 4096],
    `从 512 起必须连跳到 4096（3 跳），实得 ${JSON.stringify(chain)}`);
  assert.ok(chain.length > 1, '必须不只放大一次（否则重推理模型救不回）');

  // **终止性**：40 次迭代内必然收敛（预算整数且被 ceiling 封顶 ⇒ 步数 ≤ log2(ceiling/start)）。
  let steps = 0;
  cur = 512;
  while (steps < 40) {
    const next = escalateMaxTokens(cur);
    if (next === undefined) break;
    cur = next;
    steps += 1;
  }
  assert.ok(steps <= 3, `放大步数必须有限且极小（结构上 ≤3），实得 ${steps}`);
});

// ── 2. 核心行为：建议路径撞顶 ⇒ 放大一次、该回合总请求数 ≤ 2 ───────────────────────
await run('建议：首次撞顶 ⇒ 第二次 maxTokens 更大，且该回合总请求数 ≤ 2（修复前是 3）', async () => {
  const ctx = fakeCtx((options, n) => (n === 1 ? maxTokensStream() : textStream('看一下失败原因')));
  const result = await generateSuggestion(ctx, baseConfig(), fakeSession(), 1, abortOf());

  // issue 验收原句：第二次请求的 maxTokens **大于**首次。
  assert.equal(ctx.calls.length, 2, `撞顶后应只重发一次（总请求数 ≤ 2），实得 ${ctx.calls.length}`);
  const [first, second] = ctx.calls;
  assert.equal(first.maxTokens, 512, '首次请求用的是配置预算');
  assert.ok(second.maxTokens > first.maxTokens,
    `第二次的 maxTokens 必须**大于**首次；实得 ${first.maxTokens} → ${second.maxTokens}`);
  assert.equal(second.maxTokens, 1024, '默认 512 放大一次应落在 1024');

  // 两笔账分开：放大重发**不占**常规重试预算 ⇒ attempts 仍是 1。
  assert.equal(result.metrics.attempts, 1,
    `放大重发不是常规重试，attempts 必须还是 1（实得 ${result.metrics.attempts}）`);
  assert.equal(result.metrics.maxTokensEscalated, true, '画像要记下"这一次放大过"');
  assert.equal(result.metrics.maxTokens, 1024, '画像记的必须是**实际请求**的预算');
  assert.equal(result.suggestion?.text, '看一下失败原因', '放大之后仍然要出建议');
});

await run('建议：连续撞顶 ⇒ 逐跳放大到 ceiling，之后不再放大、错误带稳定 code', async () => {
  const ctx = fakeCtx(() => maxTokensStream());
  let caught;
  try {
    await generateSuggestion(ctx, baseConfig(), fakeSession(), 1, abortOf());
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== undefined, '一直撞顶时必须抛错，不能静默返回');
  assert.equal(caught.code, MAX_TOKENS_STOP_CODE, `抛出的错误必须带稳定 code；实得 ${String(caught.code)}`);
  assert.equal(isMaxTokensStop(caught), true, '抛出的错误要能被判据认出来（客户端/宿主侧同一判据）');

  // **#165 方案 (a) 的核心性质**：放大可以连续发生，预算序列是 512→1024→2048→4096
  // 的几何链，到 ceiling 后**不再涨**（这是防死循环的那条）。
  const budgets = ctx.calls.map((c) => c.maxTokens);
  const ladder = [...new Set(budgets)];
  assert.deepEqual(ladder, [512, 1024, 2048, MAX_TOKENS_ESCALATION_CEILING],
    `预算必须逐跳放大到 ceiling；实得 ${budgets.join(',')}`);
  // 放大次数：正好 3 次（512→1024→2048→4096），且之后一律沿用 4096。
  const escalations = budgets.filter((v, i) => i > 0 && v > budgets[i - 1]).length;
  assert.equal(escalations, 3, `从 512 起应放大 3 次到 ceiling；实得 ${escalations} 次（budgets=${budgets.join(',')}）`);
  // **终止性**：到 ceiling 后不许再涨（否则就是烧 token 的死循环）。
  const tail = budgets.slice(budgets.findIndex((v) => v === MAX_TOKENS_ESCALATION_CEILING));
  assert.ok(tail.every((v) => v === MAX_TOKENS_ESCALATION_CEILING),
    `到达 ceiling 后不得再放大；实得 ${budgets.join(',')}`);
  assert.ok(budgets.length <= 3 + 3,
    `总请求数上界 = 3 次放大 + maxAttempts(3) 常规；实得 ${budgets.length}`);
});

await run('建议：非撞顶错误**不**触发放大（判据不许外溢成"什么错都放大"）', async () => {
  const ctx = fakeCtx(() => (async function* () {
    throw new Error('dsh-suggest-ghost: suggestion output must contain text only');
    yield 0;
  })());
  let caught;
  try {
    await generateSuggestion(ctx, baseConfig(), fakeSession(), 1, abortOf());
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== undefined, '真实失败必须抛出');
  const budgets = ctx.calls.map((c) => c.maxTokens);
  assert.ok(budgets.every((v) => v === 512),
    `非撞顶错误不得放大预算；实得 ${budgets.join(',')}`);
});

// ── 3. 续写路径同覆盖（它读的也是 maxOutputTokens，没有独立预算键） ────────────────
await run('续写：首次撞顶 ⇒ 放大一次，总请求数 ≤ 2', async () => {
  const ctx = fakeCtx((options, n) => (n === 1 ? maxTokensStream() : textStream('然后推到远端')));
  const result = await generateCompletion(ctx, baseConfig(), fakeSession(), '把改动', abortOf());
  assert.equal(ctx.calls.length, 2, `续写撞顶后应只重发一次，实得 ${ctx.calls.length}`);
  assert.ok(ctx.calls[1].maxTokens > ctx.calls[0].maxTokens,
    `续写的第二次 maxTokens 必须大于首次；实得 ${ctx.calls[0].maxTokens} → ${ctx.calls[1].maxTokens}`);
  assert.equal(result.metrics.attempts, 1, '续写：放大重发同样不占常规重试预算');
  assert.equal(result.metrics.maxTokensEscalated, true);
  assert.equal(result.text, '然后推到远端');
});

await run('续写：连续撞顶 ⇒ 逐跳放大到 ceiling，之后不再放大，错误带稳定 code', async () => {
  const ctx = fakeCtx(() => maxTokensStream());
  let caught;
  try {
    await generateCompletion(ctx, baseConfig(), fakeSession(), '把改动', abortOf());
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== undefined, '续写一直撞顶也必须抛错');
  assert.equal(caught.code, MAX_TOKENS_STOP_CODE);
  const budgets = ctx.calls.map((c) => c.maxTokens);
  // 与建议路径同一条几何链（两处共用 escalateMaxTokens ⇒ 形状必须一致）。
  const ladder = [...new Set(budgets)];
  assert.deepEqual(ladder, [512, 1024, 2048, MAX_TOKENS_ESCALATION_CEILING],
    `续写预算必须逐跳放大到 ceiling；实得 ${budgets.join(',')}`);
  const escalations = budgets.filter((v, i) => i > 0 && v > budgets[i - 1]).length;
  assert.equal(escalations, 3, `续写从 512 起应放大 3 次到 ceiling；实得 ${escalations}（budgets=${budgets.join(',')}）`);
  const tail = budgets.slice(budgets.findIndex((v) => v === MAX_TOKENS_ESCALATION_CEILING));
  assert.ok(tail.every((v) => v === MAX_TOKENS_ESCALATION_CEILING),
    `续写到达 ceiling 后不得再放大；实得 ${budgets.join(',')}`);
});

// ── 4. 上限：用户把预算配到上限之上时，不得"放大"到更贵 ────────────────────────────
await run('预算已在上限之上 ⇒ 撞顶时不放大，直接按常规失败路径报错', async () => {
  const ctx = fakeCtx(() => maxTokensStream());
  let caught;
  try {
    await generateSuggestion(ctx, baseConfig({ maxOutputTokens: 6000 }), fakeSession(), 1, abortOf());
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== undefined);
  assert.ok(ctx.calls.every((c) => c.maxTokens === 6000),
    `超过上限的预算不得被放大；实得 ${ctx.calls.map((c) => c.maxTokens).join(',')}`);
});

// ── 5. 结构断言：只重发一次靠**显式布尔闸门**，不靠重试次数算术 ────────────────────
//
// 形状断言必须配行为对照（§7 那条 #146 的教训）。上面的用例 2/3 已经是行为对照：
// 它们证明"放大只发生一次"。这里额外钉结构，因为 lead 明确要求"只重发一次"要能
// **从代码结构上看出来**——次数算术写法下多一条 `continue` 就是死循环，而行为用例
// 未必能拦住"多放大一轮但仍有限"的退化。
await run('结构：两条路径都经 escalateMaxTokens，终止性由 ceiling 结构给出', () => {
  const gen = read('src/generate.ts');
  // #165 方案 (a) 后不再有布尔闸门（「只放大一次」已被实测证伪：1024 救不回）。
  // 终止性改由 escalateMaxTokens 的两条停止条件 + ceiling 保证，所以这里断言的是
  // 「两处都调同一个纯函数」，而不是「两处各有一个布尔量」。
  const gates = [...gen.matchAll(/let maxTokensEscalated = false;/g)];
  assert.equal(gates.length, 0,
    `不应再有 maxTokensEscalated 布尔闸门（连续放大已取代「只放大一次」）；实得 ${gates.length} 处`);
  const counters = [...gen.matchAll(/let maxTokensEscalationCount = 0;/g)];
  assert.equal(counters.length, 2,
    `建议与续写两条路径各要一个放大计数器（观测用）；实得 ${counters.length} 处`);
  const calls = [...gen.matchAll(/escalateMaxTokens\(maxTokens\)/g)];
  assert.equal(calls.length, 2, `两条路径都必须经纯函数 escalateMaxTokens；实得 ${calls.length} 处`);
  // 判据不许退化成报文匹配：撞顶判据只许出现在 isMaxTokensStop 内部一处。
  const messageMatches = [...gen.matchAll(/isMaxTokensStop|maxOutputTokens/g)].length;
  const helperOnly = /export function isMaxTokensStop\(error: unknown\): boolean \{\s*const box[\s\S]{0,300}?\n\}/.exec(gen);
  assert.ok(helperOnly !== null, 'isMaxTokensStop 的定义形态变了（判据的唯一定义点）');
  assert.ok(!/maxOutputTokens/.test(helperOnly[0]),
    'isMaxTokensStop **不得**含 maxOutputTokens 报文匹配（判据只认 code）');
  assert.ok(messageMatches > 0);
});

// ── 6. 观测面：PushedPayload 有 error 键、客户端消费它、一条 trace 键 ──────────────
await run('客户端：PushedPayload 声明了 error 键', () => {
  const client = read('src/client/index.ts');
  const payload = /type PushedPayload = \{([\s\S]*?)\n\};/.exec(client);
  assert.ok(payload !== null, 'PushedPayload 形态变了');
  assert.match(payload[1], /^\s*error\?: unknown;/m,
    'PushedPayload 必须声明 error?: unknown（宿主一直推这个键，客户端过去没声明 ⇒ 类型层丢弃）');
});

await run('客户端：error 键至少一处消费（traceOnce suggestion-failed + 静默指示）', () => {
  const client = read('src/client/index.ts');
  assert.ok(client.includes("traceOnce('suggestion-failed'"),
    "客户端必须有一条 traceOnce('suggestion-failed', …) 留痕");
  // 消费判据：从载荷里真读了这个键，而不是只声明了类型。
  assert.match(client, /pushed\?\.error/,
    '客户端必须真的从载荷里读 error（只声明类型等于没消费）');
  assert.match(client, /noteSuggestionFailure\(/,
    '失败必须接到一次性静默指示上（否则用户仍然"看不出为什么没反应"）');
  assert.match(client, /'\s*suggestion-failed': null,/,
    'suggestion-failed 必须登记进 traceGates（否则 traceOnce 的理由闸没有槽位）');
});

await run('客户端：静默指示组件不弹窗、不抢焦点（社区评审原则 1）', () => {
  const note = read('src/client/failure-note.tsx');
  // 只在 **JSX 区域**里查（文件头注释会提到 `role="alert"` 说明为什么不用它，
  // 按全文子串判会把自己的说明当成违规）。JSX 区域从 `return (` 起。
  const jsxAt = note.indexOf('return (');
  assert.ok(jsxAt > 0, '组件返回值形态变了（找不到 `return (`）');
  const jsx = note.slice(jsxAt);
  const roleAttr = /role=["']([^"']*)["']/.exec(jsx);
  assert.ok(roleAttr !== null, '指示节点必须显式声明 role');
  assert.equal(roleAttr[1], 'status', `不得用 dialog/alert（打断式），必须是 status；实得 role="${roleAttr[1]}"`);
  assert.match(jsx, /aria-live="polite"/, '要用礼貌播报而不是紧急播报');
  assert.match(jsx, /pointerEvents: 'none'/, '不得拦点击（用户打字时无感）');
  assert.ok(!/\.focus\(/.test(jsx), '不得抢焦点');
  assert.ok(!/setTimeout|setInterval/.test(note), '不得有定时器（"一次性"靠下一次推送收回）');
});

await run('宿主：撞顶错误带 code（finishError 的 max-tokens 分支）', () => {
  const gen = read('src/generate.ts');
  const branch = /case 'max-tokens': \{([\s\S]*?)\n    \}/.exec(gen);
  assert.ok(branch !== null, "finish.kind === 'max-tokens' 的分支形态变了");
  assert.match(branch[1], /error\.code = MAX_TOKENS_STOP_CODE/,
    '撞顶错误必须打稳定 code（否则判据只能去匹配报文）');
});

console.log('');
if (failed > 0) {
  console.error(`❌ max-tokens-smoke: ${failed} 组失败（共 ${cases} 组）`);
  process.exit(1);
}
console.log(`✅ max-tokens-smoke: 全部通过（${cases} 组：撞顶逐跳放大到 ceiling、不占常规预算、判据只认 code、客户端消费 error 键）`);
