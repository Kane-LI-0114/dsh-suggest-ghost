#!/usr/bin/env node
/**
 * #157 键位提示的**真宿主几何取证**：提示行到底在不在输入框下方，会不会压东西。
 *
 * ## 为什么必须有这一条
 *
 * PR #158 合并时把这条列成唯一的实质遗留风险：纯 Node 的 `key-hint-smoke.mjs`
 * 只证明「文案在各档设置下拼得对」，`KeyHintNode.position()` 用
 * `offsetTop + offsetHeight` 把提示行摆在「编辑器下方」这件事**一行都没验过**。
 * 本脚本补的就是这一层 —— 判据全部来自真宿主 DOM 的 `getBoundingClientRect()`，
 * 不读日志、不读我自己的中间量。
 *
 * ## 断的五件事（每条都可证伪）
 *
 *  1. **在场**：幽灵显示时 `#dsh-suggest-ghost-keyhint` 存在、`display:block`、
 *     `data-keyhint="1"`；
 *  2. **在下方**：提示行 `rect.top` ≥ 编辑器 `rect.bottom - 1`（允许 subpixel）；
 *  3. **不重叠**：提示行与 overlay（幽灵）、与编辑器本身**无交集**（面积交为 0）；
 *  4. **文案跟随设置**：`acceptKey` 改成 `F2` 后提示行里出现 `F2`、且不再以 `Tab` 开头
 *     —— 与 Node 侧用例同一条判据，这里验的是**真链路**（settings → render → DOM）；
 *  5. **成对消失**：把草稿清空 / 采纳之后，`data-keyhint` 回到 `"0"` 且 `display:none`。
 *
 * ## 失败三态分得开（本仓 §5 口径）
 *
 *  - 实例起不来 / 没进工作区 / 幽灵压根没出现 ⇒ **NOT-COVERED**（不是通过，也不是失败）；
 *  - 幽灵出现了但提示行不在 ⇒ **FAIL**，并打出双方 rect；
 *  - 全部成立 ⇒ **PASS**。
 *
 * ## 隔离
 *
 * 沙箱 home 前缀 `xk-157-`，由 `scripts/dev-sandbox.mjs` 建；token 只从沙箱日志取并
 * 全程 `redact()`。**不打印任何消息正文**，只打几何数字。
 *
 * ## 踩过的四条（都很安静，写在这里省下一个人一整轮）
 *
 *  1. **`Input.insertText` 是追加不是替换** ⇒ 漏了「先清空草稿」，历史条目被污染成
 *     「这是这是用于…」，而脚本一直以为自己打的是干净前缀。每次打字前必须 `clearDraft()`。
 *  2. **只发 `char` 或 `keyDown(text)` 都不进 Lexical**（draftChars 恒 0，而焦点诊断显示
 *     `focusedIsComposer=true`）⇒ 必须 `Input.insertText`（本仓 `hot-yield-ratio.mjs:580` 同结论）。
 *  3. **进了工作区 ≠ 有会话**：trace 打 `inline-arm-cancel: reason=no-session`，此时幽灵永不显示，
 *     而服务端一切正常（`push lands` / `parses=1 applies=1`）⇒ 必须点一次「新会话」。
 *  4. **全新沙箱没有历史** ⇒ 先发一条真消息把历史建起来，且前缀必须与那条历史真的构成前缀关系
 *     （`historyMinChars` 与长度都要够）。
 *
 * ## 判据 4 的形态是被实测纠正过的
 *
 * 原计划「进设置页把 acceptKey 改成 F2，看提示行变不变」。实测发现 `history` 形态的采纳键
 * **恒为 `Tab`**（`DEFAULT_ACCEPT_KEY`，v0.1.0 起如此），用户设置只对 `llm` 建议生效
 * （经建议载荷推下来）。⇒ 在 history 形态下断言「提示行跟着变 F2」，等于要求提示行**撒谎**
 * （说 F2 而实际按 Tab）。所以这条断的是「提示行说的是实际生效的键，且那个键真的能用」。
 *
 * 用法：
 *   node scripts/key-hint-geom-e2e.mjs --home ~/xk-157-geom
 *   node scripts/key-hint-geom-e2e.mjs --home ~/xk-157-geom --cleanup   # 收尾
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);

const HOME_ = String(opt('home', '')).replace(/^~/, homedir());
const GEN = String(opt('gen', '0.2.1-rc.2'));
const BIN = String(opt('bin', join(homedir(), 'dsh-versions', GEN, 'node_modules/.bin/dsh')));
const WS = String(opt('ws', join(homedir(), 'xk-157-ws'))).replace(/^~/, homedir());
const PORT = Number(opt('port', 4157));
const CHROME = process.env.CHROME_BIN
  ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
if (flag('cleanup')) {
  // 收尾走沙箱自己的三处枚举（含工作区），不手工 rm（本仓「工作区不一定在 home 里」那条）。
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('node', ['scripts/dev-sandbox.mjs', '--cleanup', '--home', HOME_], { cwd: REPO, stdio: 'inherit' });
  } finally { process.exit(0); }
}
if (HOME_ === '') throw new Error('必须给 --home <沙箱目录>（约定前缀 xk-157-）');

const secrets = new Set();
const redact = (s) => {
  let out = String(s);
  for (const sec of secrets) if (sec.length > 4) out = out.split(sec).join('«redacted»');
  return out.replace(/([?&]token=)[^\s"'\\]+/g, '$1«redacted»');
};
const say = (...p) => process.stdout.write(redact(p.join(' ')) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = join(HOME_, 'logs', 'sbx.log');

/** 三态计数器（§5：没验到的不得写成通过）。 */
const tally = { pass: 0, fail: 0, notCovered: 0 };
const check = (name, ok, detail) => {
  if (ok) tally.pass += 1; else tally.fail += 1;
  say(`  ${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : `\n      ${redact(String(detail))}`}`);
};
const skip = (name, why) => {
  tally.notCovered += 1;
  say(`  ⊘ NOT-COVERED  ${name}\n      缺前置：${why}`);
};

const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO });
  let out = ''; let err = '';
  p.stdout.on('data', (b) => { out += b.toString(); });
  p.stderr.on('data', (b) => { err += b.toString(); });
  p.on('error', reject);
  p.on('close', (code) => resolve({ code, out, err }));
});

/** 起沙箱实例并确保插件条目启用（补丁要断言真的打上了 —— §7 的教训）。 */
const launch = async () => {
  if (!existsSync(join(HOME_, 'profiles', 'web', 'cordis.patch.yml'))) {
    await run('node', ['scripts/dev-sandbox.mjs', '--home', HOME_, '--rewrite', `port: 3983=port: ${PORT}`,
      '--bin', BIN, '--check']);
  }
  const profile = join(HOME_, 'profiles', 'web', 'cordis.patch.yml');
  let t = readFileSync(profile, 'utf8');
  const i = t.indexOf('- id: suggest-ghost');
  if (i < 0) throw new Error('沙箱 profile 里没有本插件条目');
  let j = t.indexOf('\n- id: ', i + 5); if (j < 0) j = t.length;
  let blk = t.slice(i, j).replace(/^(\s*)disabled:\s*true\s*$/m, '$1disabled: false');
  if (/disabled:\s*true/.test(blk)) throw new Error('插件条目仍 disabled ⇒ 别用没生效的开关跑判据');
  writeFileSync(profile, t.slice(0, i) + blk + t.slice(j));
  mkdirSync(join(HOME_, 'node_modules'), { recursive: true });
  const peers = join(homedir(), '.dsh/profiles/web/node_modules/@deepseek-ai');
  const link = join(HOME_, 'node_modules/@deepseek-ai');
  if (existsSync(peers) && !existsSync(link)) await run('ln', ['-sfn', peers, link]);
  const r = await run('node', ['scripts/dev-sandbox.mjs', '--home', HOME_,
    '--rewrite', `port: 3983=port: ${PORT}`, '--bin', BIN, '--deploy', '.']);
  if (!/存活=yes/.test(r.out)) throw new Error('实例没起来：' + r.out.slice(-400));
  return existsSync(join(HOME_, 'sbx.pid'))
    ? readFileSync(join(HOME_, 'sbx.pid'), 'utf8').split(/\s+/).filter(Boolean) : [];
};

const urlOf = () => {
  const all = [...readFileSync(LOG, 'utf8').matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)/g)];
  if (all.length === 0) throw new Error('日志里没有 dsh web URL');
  const last = all[all.length - 1];
  secrets.add(last[2]);
  return `http://127.0.0.1:${last[1]}/?token=${last[2]}`;
};

/** 最小 CDP 客户端（Node 自带 WebSocket，零依赖）。 */
const cdp = async () => {
  const dir = join(tmpdir(), `xk157-chrome-${Date.now()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  for (let k = 0; k < 80 && !existsSync(join(dir, 'DevToolsActivePort')); k += 1) await sleep(150);
  const port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((x) => x.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const consoleLines = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error !== undefined) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      consoleLines.push({ t: Date.now(),
        text: (msg.params.args ?? []).map((a) => (typeof a.value === 'string' ? a.value : JSON.stringify(a.value ?? ''))).join(' ') });
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails !== undefined) throw new Error('页内异常：' + JSON.stringify(r.exceptionDetails).slice(0, 200));
    // CDP 的 send() 已拆掉外层 {result} ⇒ 值在 r.result.value（写错时静默 undefined）。
    return r.result?.value;
  };
  return { send, evaluate, consoleLines, close: () => { try { ws.close(); } catch { /* noop */ } proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); } };
};

const HELPERS = `
window.__k = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  name: (n) => ((n.textContent || '') + ' ' + (n.getAttribute('aria-label') ?? '') + ' ' + (n.title ?? '')).trim(),
  byText: (t, sel) => window.__k.qa(sel || 'button, [role=button]').find((n) => window.__k.name(n).includes(t)) ?? null,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  until: async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await window.__k.wait(150); } return false; },
  dismiss: async () => {
    const labels = ['保留当前显示', '暂不开启', '以后再说', '知道了', '不用了', '保留原样', '继续', '同意', '我已阅读'];
    for (let k = 0; k < 8; k += 1) {
      let hit = false;
      for (const d of window.__k.qa('[role=dialog], dialog[open]')) {
        if (/选择工作区目录|添加工作区|选择工作区/.test(d.textContent ?? '')) continue;
        const b = [...d.querySelectorAll('button')].find((x) => labels.some((L) => window.__k.name(x).includes(L)));
        if (b != null) { b.click(); hit = true; await window.__k.wait(250); }
      }
      if (!hit) break;
    }
  },
  // 选工作区：composer 的 phase 为 inert 时不收输入，会话也不可写 ⇒ 幽灵永不出现。
  // 这一段照 stream-frames-dom-e2e.mjs 的实测教训写：必须挑「工作区那个」 dialog，
  // 界面上同时挂着引导模态，取第一个 [role=dialog] 会拿到它 ⇒ 空转的绿。
  dlg: () => [...document.querySelectorAll('[role=dialog]')]
    .find((d) => /选择工作区目录|添加工作区|选择目录/.test(d.textContent ?? ''))
    ?? [...document.querySelectorAll('[role=dialog]')]
      .find((d) => [...d.querySelectorAll('button')].some((b) => /打开|取消/.test(window.__k.name(b))))
    ?? null,
  // 清空草稿：**每次打字前必须调**。实测漏了这一步，insertText 是**追加**不是替换，
  // 于是历史条目被污染成「这是这是用于…」（前几次运行的前缀留在编辑器里），
  // 而脚本还一直以为自己打的是干净前缀 —— 这类「输入侧脏了」比断言失败难查得多。
  clearDraft: () => {
    const n = window.__k.composer();
    if (n == null) return false;
    n.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(n);
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  },
  composer: () => {
    const all = window.__k.qa('[data-composer-input]');
    return all.find((n) => n.dataset.phase !== 'inert') ?? document.querySelector('[contenteditable=true]') ?? all[0] ?? null;
  },
  /** 三个几何量一次读全：编辑器 / 幽灵 overlay / 键位提示。 */
  geom: () => {
    const r = (el) => { if (el == null) return null; const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
               top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
    const overlay = document.getElementById('dsh-suggest-ghost-overlay');
    const hint = document.getElementById('dsh-suggest-ghost-keyhint');
    return {
      composer: r(window.__k.composer()),
      overlay: r(overlay),
      overlayShown: overlay == null ? null : (overlay.dataset.shown ?? null),
      overlayDisplay: overlay == null ? null : getComputedStyle(overlay).display,
      hint: r(hint),
      hintExists: hint != null,
      hintText: hint == null ? null : (hint.textContent ?? ''),
      hintFlag: hint == null ? null : (hint.dataset.keyhint ?? null),
      hintDisplay: hint == null ? null : getComputedStyle(hint).display,
    };
  },
};
`;

/** 交集面积（矩形无交集 ⇒ 0）。 */
const inter = (a, b) => {
  if (a == null || b == null) return 0;
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
};

let pids = [];
let c = null;
const NOT_COVERED = Symbol('not-covered');
try {
  mkdirSync(WS, { recursive: true });
  say(`=== #157 键位提示几何取证（gen=${GEN}，port=${PORT}）===`);
  pids = await launch();
  c = await cdp();
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Page.navigate', { url: urlOf() });
  await sleep(1500);
  await c.evaluate(HELPERS);
  await c.evaluate('window.__k.dismiss()');
  await sleep(800);

  const composer = await c.evaluate('window.__k.composer() != null');
  if (!composer) {
    skip('全部判据', '宿主没有可编辑 composer（可能停在工作区选择页或首屏模态）');
    throw NOT_COVERED;
  }

  // ── 前置：进入工作区（composer 为 inert 时收不到输入，幽灵永不出现） ──
  const WS_NAME = WS.split('/').pop();
  const entered = await c.evaluate(`(async () => {
    const x = window.__k;
    await x.dismiss();
    const phase = () => (x.composer()?.dataset.phase ?? 'inert');
    if (phase() !== 'inert') return { step: 'already-ready', phase: phase() };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await x.dismiss();
      const opener = x.byText('添加工作区') ?? x.byText('选择工作区');
      if (opener == null) return { step: '没有工作区入口', phase: phase() };
      opener.click();
      await x.until(() => x.dlg() != null, 9000);
      const target = ${JSON.stringify(WS_NAME)};
      const row = () => [...(x.dlg()?.querySelectorAll('button, [role=button], [role=treeitem], li, [title]') ?? [])]
        .find((n) => x.name(n) === target || (n.getAttribute?.('title') ?? '') === target);
      if (!(await x.until(() => row() != null, 12000))) {
        const cancel = [...(x.dlg()?.querySelectorAll('button') ?? [])].find((b) => /取消|Cancel/.test(x.name(b)));
        if (cancel != null) { cancel.click(); await x.wait(400); }
        continue;
      }
      row().click();
      await x.wait(600);
      const open = [...x.dlg().querySelectorAll('button')].filter((b) => x.name(b).includes('打开')).find((b) => !b.disabled) ?? null;
      if (open != null) open.click();
      const ready = await x.until(() => phase() !== 'inert', 20000);
      return { step: 'via-row', ready, phase: phase() };
    }
    return { step: '两轮都没进工作区', phase: phase() };
  })()`);
  say(`  进工作区：${JSON.stringify(entered)}`);
  if (entered?.phase === 'inert') {
    skip('全部判据', `composer 仍为 inert（进不去工作区：${entered?.step}）⇒ 幽灵不可能出现`);
    throw NOT_COVERED;
  }

  // ── 前置 2：必须有**当前会话** ──
  // 进了工作区不等于有会话：实测 trace 打 `inline-arm-cancel: reason=no-session`，
  // 此时 `currentSessionIdOf()` 返回 undefined ⇒ bound 建不起来 ⇒ 幽灵永不显示，
  // 而服务端一切正常（push landed / parses=1 applies=1）。点「新会话」即可。
  const sessionUp = await c.evaluate(`(async () => {
    const x = window.__k;
    for (let k = 0; k < 5; k += 1) {
      const b = x.byText('新会话') ?? x.byText('新建会话');
      if (b != null) { b.click(); await x.wait(1200); }
      const n = x.composer();
      if (n != null && (n.dataset.phase ?? '') !== 'inert') { await x.wait(600); return { ok: true, try: k, phase: n.dataset.phase }; }
    }
    return { ok: false, phase: x.composer()?.dataset.phase ?? null };
  })()`);
  say(`  新会话：${JSON.stringify(sessionUp)}`);

  // ── 造一条幽灵：往草稿里打字，历史前缀补全在 ≥3 字符后可出（historyMinChars） ──
  // 焦点诊断：contenteditable 拿不到真实焦点时，任何键都打不进文本（draftChars 恒 0）。
  // 先把「是不是焦点问题」与「是不是事件序列问题」分开，否则会盲试。
  const focusDiag = await c.evaluate(`(() => {
    const x = window.__k;
    const n = x.composer();
    if (n == null) return { step: 'no composer' };
    n.focus();
    const a = document.activeElement;
    return {
      step: 'focused', tag: n.tagName, editable: n.isContentEditable,
      focusedIsComposer: a === n || n.contains(a),
      activeTag: a?.tagName ?? null, activeCls: (a?.className ?? '').toString().slice(0, 60),
      tabIndex: n.getAttribute('tabindex'), readOnly: n.getAttribute('readonly') ?? n.getAttribute('aria-readonly'),
      rect: (() => { const r = n.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    };
  })()`);
  say(`  焦点诊断：${JSON.stringify(focusDiag)}`);
  const box = await c.evaluate(`(() => { const n = window.__k.composer(); const r = n.getBoundingClientRect();
    return { x: Math.round(r.x + 14), y: Math.round(r.y + 8) }; })()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(250);
  // ⚠️ 只发 `char` 事件在 contenteditable / Lexical 上**不进文本**（实测 draftChars 恒 0）：
  //    必须 keyDown(text) → char → keyUp 三段，与 `stream-frames-dom-e2e.mjs` 同款。
  // ⚠️ `key` 必须是 `Unidentified`（不是字符本身）：实测 key=字符时 Lexical 收不到输入
  //    （draftChars 恒 0，而焦点诊断显示 focusedIsComposer=true）——与
  //    `stream-frames-dom-e2e.mjs` 的 typeAll 逐字同款，别自作聪明"改精确"。
  // 三条都试过，只有第三条在 Lexical 上真的进文本（本仓 hot-yield-ratio.mjs:580 有同一结论）：
  //  ① 只发 `char`              ⇒ draftChars 恒 0
  //  ② keyDown(text)+char+keyUp ⇒ draftChars 恒 0
  //  ③ Input.insertText         ⇒ 进文本
  await c.evaluate('window.__k.clearDraft()');
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await sleep(300);
  await c.send('Input.insertText', { text: '这是' });
  await sleep(400);
  const afterInsert = await c.evaluate(`(() => {
    const n = window.__k.composer();
    const a = document.activeElement;
    return { chars: (n?.textContent ?? '').length, len: (n?.dataset.length ?? null),
      activeIsComposer: a === n, activeTag: a?.tagName ?? null,
      html: (n?.innerHTML ?? '').slice(0, 80), hasFocusApi: document.hasFocus() };
  })()`);
  say(`  insertText 之后：${JSON.stringify(afterInsert)}`);
  await sleep(1200);
  const typed = await c.evaluate(`(() => { const n = window.__k.composer();
    return { chars: (n?.textContent ?? '').length, phase: n?.dataset.phase ?? null }; })()`);
  say(`  打字结果：${JSON.stringify(typed)}`);
  if (typed.chars === 0) {
    // 草稿**打进去过又被清空**：把这段时间的插件留痕与 React 报错一起打出来，
    // 否则 NOT-COVERED 完全哑（本节就是为了不再"盲试"）。
    const t0 = Date.now() - 30000;
    const recent = c.consoleLines.filter((l) => l.t >= t0).map((l) => l.text);
    const rel = recent.filter((t) => /suggest-ghost|error|warn|unhandled/i.test(t)).slice(-12);
    say(`  近 30s 的相关 console（${recent.length} 行，取相关 ${rel.length} 行）：`);
    for (const t of rel) say(`      ${t.slice(0, 170)}`);
    skip('全部判据', '草稿里打不进字符（contenteditable 未获得真实焦点）⇒ 幽灵不可能出现');
    throw NOT_COVERED;
  }

  let g = await c.evaluate('window.__k.geom()');
  let ghostUp = g.overlayShown === '1' && g.overlayDisplay === 'block';

  // 全新沙箱**没有任何历史** ⇒ 历史前缀补全无候选可出。先发一条真消息把历史建起来，
  // 回合结束后（宿主会推新的下一条建议），清空草稿重打前缀，这次才有东西可补。
  if (!ghostUp) {
    const seed = '这是用于建立历史的一条测试消息';
    await c.evaluate('window.__k.clearDraft()');
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(300);
    await c.send('Input.insertText', { text: seed });
    await sleep(400);
    const before = await c.evaluate(`(() => (window.__k.composer()?.textContent ?? '').length)()`);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const cleaned = await c.evaluate(`(async () => { const x = window.__k;
      return x.until(() => (x.composer()?.textContent ?? '').length === 0, 8000); })()`);
    say(`  种子消息：提交前 ${before} 字符，提交后草稿已清=${cleaned}`);
    // 等回合结束（宿主在 turn/end 后才推下一条建议）
    let ended = await c.evaluate(`(async () => { const x = window.__k;
      return x.until(() => window.__k.qa('[data-streaming]').length === 0
        && (x.composer()?.textContent ?? '').length === 0, 60000); })()`);
    await sleep(2500);
    // 再打前缀，这次历史里有「这是用于建立历史的一条测试消息」可补
    await c.evaluate(`(() => { const n = window.__k.composer(); n?.focus(); return n != null; })()`);
    // 前缀必须与历史条目真的构成前缀关系：历史里是「这是用于建立历史的一条测试消息」，
    // 打「这是」只有 2 字符、与 historyMinChars=3 刚好不够 ⇒ 换成按种子原文打前缀。
    await c.evaluate('window.__k.clearDraft()');
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(300);
    await c.send('Input.insertText', { text: seed.slice(0, 8) });
    await sleep(2500);
    const probe = await c.evaluate('window.__k.geom()');
    say(`  种子后重打前缀：overlay shown=${probe.overlayShown} display=${probe.overlayDisplay}`);
    g = probe;
    ghostUp = g.overlayShown === '1' && g.overlayDisplay === 'block';
    if (!ghostUp) { await sleep(2500); g = await c.evaluate('window.__k.geom()');
      ghostUp = g.overlayShown === '1' && g.overlayDisplay === 'block'; }
  }
  say(`  幽灵状态：shown=${g.overlayShown} display=${g.overlayDisplay} | 草稿相关几何 ${JSON.stringify(g.composer)}`);

  if (!ghostUp) {
    // 哑的 NOT-COVERED 没有排查价值：把「为什么没出幽灵」的现场打出来。
    const why = await c.evaluate(`(() => {
      const x = window.__k;
      const n = x.composer();
      const el = document.getElementById('dsh-suggest-ghost-overlay');
      return {
        phase: n?.dataset.phase ?? null,
        draftChars: (n?.textContent ?? '').length,
        overlay: el == null ? null : { shown: el.dataset.shown ?? null, display: getComputedStyle(el).display, chars: (el.textContent ?? '').length },
        keyhint: document.getElementById('dsh-suggest-ghost-keyhint') == null ? null
          : { flag: document.getElementById('dsh-suggest-ghost-keyhint').dataset.keyhint },
      };
    })()`);
    say(`  未出幽灵的现场：${JSON.stringify(why)}`);
    // 历史补全的候选从哪来？把客户端看到的 history 与 hot 一起打出来（只有条数，不打印正文）
    const hist = await c.evaluate(`(() => {
      // 客户端把缓存放 localStorage：只读**条数**，不读正文
      try {
        const raw = localStorage.getItem('dsh-suggest-ghost:cache');
        if (raw == null) return { cache: null };
        const j = JSON.parse(raw);
        return { cache: 'present', history: (j.history ?? []).length, hot: (j.hot ?? []).length,
                 historySessionId: j.historySessionId ?? null };
      } catch (e) { return { cache: 'parse-error', msg: String(e).slice(0, 80) }; }
    })()`);
    say(`  客户端缓存（只读条数）：${JSON.stringify(hist)}`);
    // 直接调客户端自己的纯函数：拿缓存里的历史 + 当前草稿，问「该不该有候选」。
    // 这一步把「补全算法不认」与「渲染/绑定没走通」彻底分开。
    const ask = await c.evaluate(`(() => {
      try {
        const raw = localStorage.getItem('dsh-suggest-ghost:cache');
        const j = raw == null ? null : JSON.parse(raw);
        const h = j?.history ?? [];
        const n = window.__k.composer();
        const draft = n?.textContent ?? '';
        // historySuggestion 是模块内导出，页面里拿不到实例；这里只核**最朴素的条件**：
        // 有历史、草稿非空、且某条历史以草稿为前缀。
        const pref = h.find((x) => typeof x === 'string' && x.startsWith(draft));
        return { histN: h.length, draft, hasPrefixCandidate: pref !== undefined };
      } catch (e) { return { err: String(e).slice(0, 90) }; }
    })()`);
    say(`  候选自检：${JSON.stringify(ask)}`);
    // 历史里那 1 条到底是什么（只打长度与前 6 字，不打印全文）
    const heads = await c.evaluate(`(() => {
      try {
        const j = JSON.parse(localStorage.getItem('dsh-suggest-ghost:cache') ?? '{}');
        return (j.history ?? []).map((x) => ({ len: String(x).length, head: String(x).slice(0, 6) }));
      } catch (e) { return [{ err: String(e).slice(0, 60) }]; }
    })()`);
    say(`  历史条目画像：${JSON.stringify(heads)}`);
    const recent2 = c.consoleLines.slice(-60).map((l) => l.text)
      .filter((t) => /history|hot|render-source|not shown/.test(t)).slice(-8);
    for (const t of recent2) say(`      ${t.slice(0, 190)}`);
    skip('判据 1-3（在场 / 在下方 / 不重叠）', '没能造出一条幽灵（overlay 未绘制）⇒ 提示行的显示条件不成立');
    skip('判据 4（文案跟随设置）', '同上');
  } else {
    // ── 判据 1：在场 ──
    check('① 提示行存在且已显示（display:block 且 data-keyhint="1"）',
      g.hintExists && g.hintFlag === '1' && g.hintDisplay === 'block',
      `exists=${g.hintExists} flag=${g.hintFlag} display=${g.hintDisplay} text=${JSON.stringify(g.hintText)}`);

    // ── 判据 2：在编辑器下方 ──
    const below = g.hint != null && g.composer != null && g.hint.top >= g.composer.bottom - 1;
    check('② 提示行在编辑器**下方**（hint.top ≥ composer.bottom − 1）',
      below, `composer.bottom=${g.composer?.bottom} hint.top=${g.hint?.top}`);

    // ── 判据 3：不与幽灵 / 编辑器重叠 ──
    const aOverlay = inter(g.hint, g.overlay);
    const aComposer = inter(g.hint, g.composer);
    check('③ 提示行与幽灵、与编辑器都无交集（面积交 = 0）',
      aOverlay === 0 && aComposer === 0,
      `与 overlay 交=${aOverlay}px² 与 composer 交=${aComposer}px²\n      hint=${JSON.stringify(g.hint)}\n      overlay=${JSON.stringify(g.overlay)}`);

    // ── 判据 4：提示行**反映实际生效的键**（不是硬编码 Tab） ──
    //
    // 这条判据的形态是被实测纠正过的。原本计划「进设置页把 acceptKey 改成 F2，看提示行变不变」，
    // 实测发现两件事：
    //  ① 设置页里没有独立的「采纳快捷键」字段可点（那一版尝试拿到 `找不到「采纳快捷键」`）；
    //  ② 更要紧的：`history` 形态的采纳键**恒为 Tab**（`DEFAULT_ACCEPT_KEY`，v0.1.0 起如此），
    //     用户的 `acceptKey` 设置只对 `llm` 建议生效 —— 它是经建议载荷推下来的
    //     （`generate.ts:1050` → 推送 → `content.acceptKey`）。
    // ⇒ 在 history 形态下把设置改成 F2 再断言提示行变 F2，**会要求提示行撒谎**（说 F2 而实际按 Tab），
    //    那不是改好，是改错。
    // 所以这里断的是**这个形态下真正该成立的两件事**：提示行说 Tab、且 Tab 真的能采纳。
    const beforeText = g.hintText ?? '';
    const showsTab = /^Tab 采纳/.test(beforeText);
    // 真的按一次 Tab：草稿应当被补全成历史原文（= 采纳成功）
    const beforeDraft = await c.evaluate(`(() => (window.__k.composer()?.textContent ?? ''))()`);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t', unmodifiedText: '\t' });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await sleep(900);
    const afterDraft = await c.evaluate(`(() => (window.__k.composer()?.textContent ?? ''))()`);
    const accepted = afterDraft.length > beforeDraft.length && afterDraft.startsWith(beforeDraft);
    check('④ 提示行说的是**实际生效**的键（history 形态恒为 Tab），且按 Tab 真的采纳成功',
      showsTab && accepted,
      `提示行=${JSON.stringify(beforeText)} showsTab=${showsTab} | 采纳前 ${beforeDraft.length} 字 → 采纳后 ${afterDraft.length} 字 accepted=${accepted}`);

    // ── 判据 5：成对消失（清空草稿 → 提示行必须一起没） ──
    const cleared = await c.evaluate(`(async () => {
      const x = window.__k;
      const n = x.composer();
      if (n == null) return { step: 'no composer' };
      n.focus();
      // 全选 + 删除：比逐字符退格稳
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(n);
      sel.removeAllRanges(); sel.addRange(range);
      return { step: 'selected' };
    })()`);
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await sleep(1500);
    const g3 = await c.evaluate('window.__k.geom()');
    check('⑤ 草稿清空后幽灵与提示行**成对消失**（hint display:none 且 flag=0，或幽灵还在则提示行也还在）',
      (g3.overlayShown !== '1' && g3.hintFlag === '0') || (g3.overlayShown === '1' && g3.hintFlag === '1'),
      `cleared=${JSON.stringify(cleared)}\n      overlayShown=${g3.overlayShown} hintFlag=${g3.hintFlag} hintDisplay=${g3.hintDisplay}`);
  }
} catch (e) {
  if (e !== NOT_COVERED) { tally.fail += 1; say(`✗ 脚本异常：${e.message}`); }
} finally {
  if (c != null) c.close();
  if (pids.length > 0) {
    // 只停实例，不删沙箱（删要 --cleanup，走沙箱自己的三处枚举）
    for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* noop */ } }
  }
  say(`\n== 汇总：PASS ${tally.pass} / FAIL ${tally.fail} / NOT-COVERED ${tally.notCovered} ==`);
  if (tally.notCovered > 0) say('（NOT-COVERED 不是通过：缺的前置写在上面对应行里）');
  process.exit(tally.fail === 0 && tally.notCovered === 0 ? 0 : tally.fail > 0 ? 1 : 2);
}
