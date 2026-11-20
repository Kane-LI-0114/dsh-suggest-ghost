#!/usr/bin/env node
// 临时探针：删除 op 之后宿主有没有写 `_hot` / 客户端能不能看到变化
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';

process.env.DSH_SUGGEST_GHOST_TRACE = 'debug';
const HERE = dirname(fileURLToPath(import.meta.url));
const libDir = join(HERE, '..', 'lib');
assert.ok(existsSync(join(libDir, 'index.js')));
const { apply: applyHost } = await import(join(libDir, 'index.js'));
const NS = 'suggest-ghost';
const SESSION = 'session-a';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let document = { [NS]: { _ops: 'null', _push: 'null', _hot: 'null', _residual: 'null' } };
const writes = [];
let revision = 0;
class MemorySettings extends Service {
  constructor(ctx) { super(ctx, 'settings'); }
  describe() { return [{ ns: NS, revision, value: structuredClone(document[NS] ?? {}) }]; }
  update(ns, patch) {
    document = { ...document, [ns]: { ...structuredClone(document[ns] ?? {}), ...structuredClone(patch) } };
    revision += 1;
    writes.push({ at: Date.now(), cells: Object.keys(patch).sort().join(',') });
    this.ctx.emit('settings/document-updated', ns, revision);
    return Promise.resolve();
  }
}
const realLog = console.log.bind(console);
const traced = [];
console.log = (...args) => { const line = args.map(String).join(' '); if (line.includes('[ops-trace]')) traced.push(line); else realLog(...args); };
const captured = console.log;
console.debug = captured; console.info = captured; console.warn = captured;

const holder = { chunks: [{ type: 'finish', reason: { kind: 'stop' } }] };
class FakeLlm extends Service {
  constructor(ctx) { super(ctx, 'llm'); }
  stream() { const chunks = holder.chunks; return (async function* () { for (const c of chunks) { await sleep(2); yield c; } })(); }
}
const root = new Context();
if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
new SessionStore(root);
const settings = new MemorySettings(root);
new FakeLlm(root);
const session = root.sessions.create(SESSION, { meta: { cwd: process.cwd() } });
function userTurn(turn, text) {
  session.append('turn/start', { turn });
  session.append('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
}
holder.chunks = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '先跑一遍测试' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '先跑一遍测试' } },
  { type: 'finish', reason: { kind: 'stop' } },
];
applyHost(root, { maxInputBytes: 4096, maxOutputTokens: 512, timeoutMs: 2000, maxTranscriptChars: 12000, maxSuggestionChars: 240 });
await sleep(150);
await userTurn(1, 'AAA 第一条输入');
await sleep(400);
// 让 _hot 落地（pull 会绕开窗口）
await settings.update(NS, { _ops: JSON.stringify({ rev: 1, ops: [{ op: 'pull', sessionId: SESSION }] }) });
await sleep(300);
const cell = () => JSON.parse(document[NS]._hot ?? 'null');
const texts = () => ((cell() ?? {}).hot ?? []).map((e) => e.text);
realLog('\n[1] 落地 _hot 之后的条目：', JSON.stringify(texts()));

const beforeWriteIdx = writes.length;
realLog('[2] 发一条 delete（模拟点「删除」）…');
await settings.update(NS, { _ops: JSON.stringify({ rev: 2, ops: [{ op: 'delete', text: 'AAA 第一条输入' }] }) });
await sleep(300);
const newWrites = writes.slice(beforeWriteIdx);
realLog('[3] delete 之后发生的写：', JSON.stringify(newWrites.map((w) => w.cells)));
realLog('[4] 此刻 _hot 单元格里的条目：', JSON.stringify(texts()));

// 再看：host 内存里真的删了吗？发一次 pull，看应答里的 hot
const beforePull = writes.length;
await settings.update(NS, { _ops: JSON.stringify({ rev: 3, ops: [{ op: 'pull', sessionId: SESSION }] }) });
await sleep(300);
realLog('[5] pull 之后写的格：', JSON.stringify(writes.slice(beforePull).map((w) => w.cells)));
realLog('[6] pull 之后 _hot 条目：', JSON.stringify(texts()));
realLog('[7] ops-trace 末 12 行：');
for (const l of traced.slice(-12)) realLog('    ', l.slice(0, 200));
process.exit(0);
