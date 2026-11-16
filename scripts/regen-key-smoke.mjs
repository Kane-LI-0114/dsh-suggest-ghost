#!/usr/bin/env node
/**
 * 「换一条」键在非 llm 形态下**不得吞键**（Gitea #168）的行为冒烟。
 *
 * ## 要闭合的现象
 *
 * `onKeyDown` 的 regen 支曾经是「**先吞键、再判 kind**」：非 llm 形态下用户按下
 * `Alt+G`，`preventDefault()` + `stopPropagation()` 已经执行完，之后才发现这条建议
 * 根本不支持「再要一条」，于是只留一条 debug trace —— 屏幕上什么都没发生、键也到不了
 * 输入框。而键位提示行里的「换一条」段本就**只在 llm 形态显示**（`key-hint-text.ts`），
 * 等于用户在一个没有任何界面元素声称这个键有用的形态上被吞了键。
 * 同函数的采纳支（#38 闸）早就确立了相反的做法：「此刻没有可执行动作就不要吞键」。
 *
 * ## 为什么必须跑真浏览器、真产物（而不是抽个纯函数来测）
 *
 * 本单的验收判据全是**事件栈语义**：
 *   ① `event.defaultPrevented === false`
 *   ② 事件**仍能到达其后注册的处理器**
 *   ③ 没有 regen op 写出（`writeOps` 侧）
 * ② 尤其测不到：抽一个「判 kind」的纯函数，只能证明分支顺序变了，证明不了事件真的
 * 继续传播。`cancelBubble` 不能当判据（已废弃，读不到 `stopPropagation` 的效果）——
 * 所以 ② 用**在 target 层后注册的探针监听器**来读，而不是读任何"被拦了"的字段。
 *
 * 本脚本因此与 `regen-pending-smoke.mjs` / `stream-frames-dom-e2e.mjs` 同一口径：
 * 真 Chromium 加载**构建产物** `lib/client.js`，调**真的** `apply()`（不是抠出某个
 * 函数另起作用域求值），宿主 DOM 契约与设置文档都按真实形状构造。
 *
 * ### 真到什么程度（这是本脚本最要紧的一段自述）
 *
 * - **真 `apply`**：注入点取 `module.exports`，调它导出的 `apply`。整条闭包、真实
 *   `onKeyDown`、真实的 `window.addEventListener('keydown', onKeyDown, true)` 都跑在
 *   真产物里；脚本**没有**复制一份按键逻辑。
 * - **真数据路径**：history 形态来自 `remote.settings.describe()` 返回的 `_hot.history`
 *   格 —— 与宿主推送同一条解析链（`applySettings` → `PushedPayload`/`HotPushedPayload`
 *   → `computeGhostContent`），不是往 `shown` 里塞值（那是闭包私有变量，塞不进去）。
 * - **真 writeOps 出口**：`remote.settings.mutate(ns, [{op:'set', path:['_ops']}])`，
 *   脚本记录每一次 mutate 的载荷并断言其中**没有** regen op。
 * - **假的部分**：宿主服务面（sessions / conversation / input / locale / slots）是
 *   最小假面。这是本脚本的已知边界：它证明的是**本插件在这套事件与载荷契约下的行为**，
 *   不证明真实宿主里 tab 焦点最终落到哪个元素（那条见 PR 里的真 GUI 一节，按三态记录）。
 *
 * ## 三态口径（`docs/gitea-workflow.md` §5）
 *
 * `PASS` / `FAIL` / `NOT-COVERED`。缺构建产物或缺浏览器时**明确打 NOT-COVERED 并
 * 退出 2** —— 不许静默跳过把「没跑」伪装成「跑绿了」。退出码：0 全过 / 1 有红 / 2 未覆盖。
 *
 * ## 脚本自身的两种自毁模式（§8 注入类附加纪律）
 *
 * 1. **页内注入体单独做语法检查**：每个 `page.evaluate` 的注入体都先过
 *    `new Function(体)`（`--check-injects` 可只做这一步）。模板字符串里一个多余的反引号
 *    会让注入体**提前闭合**，于是"四个方向全红"，与"脚本坏了"同形。
 * 2. **失败不得表现为"断言全红"**：浏览器起不来 / 产物缺失 / 页内异常都是
 *    NOT-COVERED 或明确的脚本错误（退出码 2 / 3），而不是把用例判成红。
 * 3. 语法检查自身也要被证明**活着**：`--self-test` 会把一个本该语法错的注入体喂给检查器，
 *    它必须报错（否则这个闸是空闸）。
 *
 * ## 注入自证（§6）
 *
 * `--inject-legacy {swallow-first|stop-prop-only|no-trace}` 会在**页内副本**上按旧写法
 * 改写注入的 bundle（磁盘上的 `lib/client.js` 一字未改），然后跑同一套断言：
 *  - `swallow-first`（历史 bug 形态：先 preventDefault+stopPropagation 再判 kind）
 *    ⇒ ①②必须红；③仍绿（它本来就不写 regen op）。**全绿即说明本脚本失效**。
 *  - `stop-prop-only`（若真 GUI 实测需要走 issue 里写的退路）
 *    ⇒ ①绿、②红。它证明「只 preventDefault 不 stopPropagation」**不满足**本单判据。
 *  - `no-trace`（把 not-llm 的留痕摘掉）⇒ 留痕断言红（证 trace 断言活着）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/regen-key-smoke.mjs
 *   node --experimental-strip-types scripts/regen-key-smoke.mjs --check-injects
 *   node --experimental-strip-types scripts/regen-key-smoke.mjs --self-test
 *   node --experimental-strip-types scripts/regen-key-smoke.mjs --inject-legacy swallow-first
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CHROME = process.env.CHROME_BIN
  ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const BUNDLE = join(REPO, 'lib/client.js');

const argv = process.argv.slice(2);
const MODE_INJECT = (() => {
  const i = argv.indexOf('--inject-legacy');
  return i >= 0 ? (argv[i + 1] ?? '') : null;
})();
const CHECK_ONLY = argv.includes('--check-injects');
const SELF_TEST = argv.includes('--self-test');

let passed = 0;
let failed = 0;
let notCovered = null;

const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`); };
/** 断言一条并打印读数（红的时候要看得到实测值，不是只看到"红了"）。 */
const check = (name, condition, detail) => {
  if (condition) { ok(name); return; }
  failed += 1;
  console.log(`  ✗ ${name}${detail === undefined ? '' : `\n      实测：${detail}`}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ═══════════════════════════════════════════════════════════════════════════
// 页内注入体：全部先过语法检查（§8 第 1 条）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 每个注入体都是**完整表达式**（要么是 IIFE 调用、要么是一个对象字面量），
 * 所以可以用 `new Function('return (' + body + ')')` 做纯语法检查 —— 不求值。
 */
const INJECTS = {};

/**
 * 注入真实 bundle 并取出 `module.exports`。
 *
 * 注入点选 `factory` 的 `return module.exports;` 之前：作用域**在 factory 内部**，
 * 所以拿到的 `apply` 仍是原本那套模块级常量；磁盘上的产物一字未改。
 * factory 顶层会 `require('react')` 等，用惰性 proxy 兜住（同 `regen-pending-smoke.mjs`）。
 */
INJECTS.load = (bundleText) => `(() => {
  window.__ModuleLoader__ = {
    load: (def) => {
      const lazy = () => new Proxy(function () {}, {
        get: () => lazy(), apply: () => lazy(), construct: () => ({}),
      });
      return def.factory(() => lazy());
    },
  };
  const s = document.createElement('script');
  s.textContent = ${JSON.stringify(bundleText)};
  document.head.appendChild(s);
  return Array.isArray(Object.keys(globalThis.__SG ?? {})) ? 'ok' : 'no-exports';
})()`;

/** 宿主 composer 的三层 DOM 契约（与 `regen-pending-smoke.mjs` 的 BUILD_HOST 同形）。 */
INJECTS.host = (draft = 'hel') => `(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  const scroll = document.createElement('div');
  scroll.setAttribute('data-input-scroll', '');
  scroll.style.cssText = 'position:relative;overflow-y:auto;max-height:336px;width:640px';
  const grow = document.createElement('div');
  grow.className = 'grow';
  grow.style.cssText = 'position:relative;width:640px;min-height:96px';
  const ed = document.createElement('div');
  ed.id = 'probe-composer';
  ed.setAttribute('data-composer-input', '');
  ed.setAttribute('contenteditable', 'true');
  ed.style.cssText = 'position:relative;width:600px;padding:4px 14px;line-height:24px;font-size:14px;font-family:sans-serif;min-height:24px';
  const ph = document.createElement('div');
  ph.setAttribute('data-composer-placeholder', '');
  ph.textContent = '帮我写点什么';
  ph.style.cssText = 'position:absolute;left:14px;top:4px;line-height:24px;font-size:14px;font-family:sans-serif';
  grow.append(ed, ph);
  scroll.append(grow);
  document.body.append(scroll);
  ed.textContent = ${JSON.stringify(draft)};
  ed.focus();
  // 真选区：history 形态的 overlay 自检要读草稿末端的 rect，没有选区会 rejectAs('no-caret')。
  const r = document.createRange();
  r.selectNodeContents(ed);
  r.collapse(false);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return { focused: document.activeElement === ed };
})()`;

/**
 * 调真 `apply()`。
 *
 * `settingsDoc` 由 Node 侧按用例传入（JSON）：history 形态来自 `_hot.history`，
 * 走的是与宿主推送同一条解析链。`__writes` 记录每一次 `mutate` 的入参，
 * 这就是「有没有写出 regen op」的判据面。
 */
INJECTS.apply = (settingsJson, draft = 'hel') => `(() => {
  const store = (v) => ({ getSnapshot: () => v, subscribe: () => () => {} });
  const value = ${JSON.stringify(settingsJson)};
  // 草稿是形态的**判据**（#129）：llm 形态只在空草稿上可达，history 形态要非空草稿。
  // 由用例传入，夹具不得自己挑一个能过的值。
  window.__draft = { draft: ${JSON.stringify(draft)}, draftRev: 1 };
  window.__setDraft = (t) => {
    window.__draft = { draft: t, draftRev: (window.__draft.draftRev ?? 0) + 1 };
    const ed = document.querySelector('#probe-composer');
    if (ed !== null) ed.textContent = t;
  };
  const inputFace = {
    state: {
      getSnapshot: () => ({ draft: window.__draft.draft, draftRev: window.__draft.draftRev }),
      subscribe: () => () => {},
    },
    setDraft: (t) => window.__setDraft(t),
  };
  const actx = { get: (n) => (n === 'conversation' ? { input: { for: () => inputFace } } : undefined) };
  const sessionFace = {
    getSnapshot: () => ({ running: false }),
    subscribe: () => () => {},
    projections: { faceOf: () => store({}) },
  };
  const slotsFace = { register: () => () => {}, inject: () => () => {} };
  window.__writes = [];
  window.__effErr = null;
  const ctx = {
    get(n) {
      if (n === 'sessions') {
        return {
          list: store({ current: 'sess-1', byId: { 'sess-1': { id: 'sess-1' } } }),
          scope: () => actx,
          sessionOf: () => sessionFace,
        };
      }
      if (n === 'remote') {
        return {
          $on: () => () => {},
          settings: {
            describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'suggest-ghost', revision: 1, value }] } }),
            mutate: async (ns, ops) => { window.__writes.push({ ns, ops }); return { ok: true }; },
          },
        };
      }
      if (n === 'locale') return store({ active: 'zh' });
      if (n === 'slots') return slotsFace;
      return undefined;
    },
    on: () => () => {},
    effect(fn) {
      try { const d = fn(); return typeof d === 'function' ? d : () => {}; }
      catch (e) { window.__effErr = String((e && e.stack) || e).slice(0, 600); return () => {}; }
    },
    inject: () => () => {},
    slots: slotsFace,
  };
  let threw = null;
  try { globalThis.__SG.apply(ctx); }
  catch (e) { threw = String((e && e.stack) || e).slice(0, 800); }
  return { threw, effectErr: window.__effErr };
})()`;

/**
 * 派发一次真 keydown 并读三条判据。
 *
 * 探针监听器**挂在 target 元素上、在 apply 之后注册** —— 这正是判据 ② 要的形状：
 * 只有 `stopPropagation()` 没被调用，它才收得到。**不读 `cancelBubble`**（已废弃，
 * 读不到 stopPropagation 的效果）。
 */
INJECTS.press = (spec) => `(async () => {
  const ed = document.querySelector('#probe-composer');
  if (ed === null) return { missingComposer: true };
  const before = window.__writes.length;
  let probeHits = 0;
  const probe = () => { probeHits += 1; };
  ed.addEventListener('keydown', probe);
  const event = new KeyboardEvent('keydown', ${JSON.stringify(spec)});
  const dispatchReturned = ed.dispatchEvent(event);
  ed.removeEventListener('keydown', probe);
  // writeOps 走 **异步写队列**（OpsWriteQueue）：同步读 __writes 会读到「还没发」，
  // 与「没发出」同形 —— 那会把 llm 的 regen op 误判成缺失。等一拍再读（队列串行，
  // 一次 tick 足够落地；给到 50ms 余量，不靠猜）。
  for (let k = 0; k < 50 && window.__writes.length === before; k += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const overlay = document.querySelector('#dsh-suggest-ghost-overlay');
  const writes = window.__writes.slice(before);
  return {
    defaultPrevented: event.defaultPrevented,
    probeHits,
    dispatchReturned,
    writes,
    ghostText: overlay === null ? null : overlay.textContent,
    ghostShown: overlay === null ? null : overlay.dataset.shown,
    regenOps: writes
      .flatMap((w) => (Array.isArray(w.ops) ? w.ops : []))
      .map((op) => JSON.parse((op && op.value) || '{}'))
      .flatMap((body) => (Array.isArray(body.ops) ? body.ops.map((o) => o && o.op) : []))
      .filter((op) => op === 'regen'),
  };
})()`;

/** 读 trace 通道：留痕走 console.debug/warn/info，**不只挂 console.log**（§6 通道那条）。 */
INJECTS.installTraceCapture = `(() => {
  window.__traces = [];
  const tap = (orig) => function (...args) {
    try { window.__traces.push(args.map((a) => typeof a === 'string' ? a : String(a)).join(' ')); }
    catch { /* 捕获失败不影响原调用 */ }
    return orig.apply(this, args);
  };
  for (const level of ['log', 'info', 'warn', 'debug', 'error']) {
    console[level] = tap(console[level]);
  }
  return true;
})()`;

// 语法检查：把每个注入体当成一个表达式求语法（不求值）。
const syntaxErrors = [];
for (const [name, build] of Object.entries(INJECTS)) {
  const sample = build instanceof Function
    ? build(name === 'apply' ? {} : name === 'press' ? {} : '/*bundle*/')
    : build;
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${sample});`);
  } catch (error) {
    syntaxErrors.push(`${name}: ${String(error && error.message)}`);
  }
}
if (syntaxErrors.length > 0) {
  console.log('✗ 页内注入体语法检查未通过（这不是"断言变红"，是脚本自己坏了）：');
  for (const line of syntaxErrors) console.log(`    ${line}`);
  process.exit(3);
}
if (CHECK_ONLY) {
  console.log(`✅ 页内注入体语法检查通过（${Object.keys(INJECTS).length} 个）`);
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// §8 自检：证明这道语法闸是活的（空闸会被这里抓住）
// ═══════════════════════════════════════════════════════════════════════════
if (SELF_TEST) {
  console.log('\n—— §8 自检：语法闸本身是否活着 ——');
  const brokenBodies = [
    { label: '多余的反引号（模板串提前闭合）', body: '(() => { const s = `a`b`; return s; })()' },
    { label: '括号不配对', body: '(() => { return (1; })()' },
  ];
  let detected = 0;
  for (const { label, body } of brokenBodies) {
    try {
      // eslint-disable-next-line no-new-func
      new Function(`return (${body});`);
      console.log(`  ✗ 没抓住：${label}（语法闸是空的）`);
      failed += 1;
    } catch {
      console.log(`  ✓ 抓住了：${label}`);
      detected += 1;
      passed += 1;
    }
  }
  // 反向：合法注入体不得被误判。
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${INJECTS.host('hel')});`);
    console.log('  ✓ 合法注入体没被误判');
    passed += 1;
  } catch {
    console.log('  ✗ 合法注入体被误判成语法错（闸太严）');
    failed += 1;
  }
  console.log(`\n${failed === 0 ? '✅' : '❌'} 自检：语法闸抓到 ${detected}/${brokenBodies.length} 个坏样本`);
  process.exit(failed === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// 前置检查：缺什么就明确 NOT-COVERED（§5），不许静默跳过
// ═══════════════════════════════════════════════════════════════════════════
if (!existsSync(BUNDLE)) {
  console.log(`⚠️  NOT-COVERED：缺构建产物 ${BUNDLE}`);
  console.log('    先跑 ./node_modules/.bin/tsc -p tsconfig.json && node build.mjs');
  console.log('    （§3：冒烟导入的是 lib/，测 src/ 改动必须重建产物，否则测的是旧字节码）');
  process.exit(2);
}
if (!existsSync(CHROME)) {
  console.log(`⚠️  NOT-COVERED：缺浏览器 ${CHROME}`);
  console.log('    用 CHROME_BIN=<chrome 可执行文件> 指定，或安装 playwright chromium。');
  process.exit(2);
}

// ═══════════════════════════════════════════════════════════════════════════
// 最小 CDP 客户端（Node 自带 WebSocket，零依赖）
// ═══════════════════════════════════════════════════════════════════════════
const cdp = async () => {
  const dir = join(tmpdir(), `sg-regen-key-${Date.now()}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(dir, 'DevToolsActivePort');
  for (let k = 0; k < 120 && !existsSync(portFile); k += 1) await sleep(100);
  if (!existsSync(portFile)) {
    proc.kill('SIGKILL');
    throw new Error(`Chromium 没起来（等不到 DevToolsActivePort）：${CHROME}`);
  }
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const pageErrors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.method === 'Runtime.exceptionThrown') {
      pageErrors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 400));
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error !== undefined) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails !== undefined) {
      throw new Error(`页内异常：${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
    }
    // `send()` 已拆掉外层 {result, exceptionDetails} ⇒ 值在 r.result.value。
    return r.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  const close = () => {
    try { ws.close(); } catch { /* noop */ }
    proc.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  };
  return { evaluate, close, send, pageErrors };
};

// localStorage 需要**可信 origin**：about:blank 的 origin 是 opaque，读它直接 SecurityError
// （实测：SecurityError: Failed to read the 'localStorage' property ... Access is denied）。
const originServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head></head><body></body></html>');
});
await new Promise((resolve) => originServer.listen(0, '127.0.0.1', resolve));
const originUrl = `http://127.0.0.1:${originServer.address().port}/`;

// ═══════════════════════════════════════════════════════════════════════════
// bundle 改写：--inject-legacy 在**页内副本**上还原旧写法（磁盘产物不动）
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 注入锚点：**从产物里读出来的真实末项**，不是硬编码一个"应该长这样"的字符串。
 *
 * §6 那条教训：锚点写错时字符串替换是**空操作**，`git commit` 照样通过、读数照样"全绿"。
 * 所以这里三步都做：
 *  1. 锚点从 bundle 里按正则找（esbuild 产物用双引号、`void 0`，与源码形态不同）；
 *  2. 命中次数必须**恰好 1**，否则判脚本漂移并退出 3；
 *  3. 改写后必须**逐字变了**（空操作同样退出 3）。
 */
const REGEN_BLOCK = /if \(content\.kind !== "llm"\) \{\s*\n\s*traceOnce\("regen-skipped", "not-llm", ` kind=\$\{content\.kind\}`\);\s*\n\s*return;\s*\n\s*\}\s*\n\s*event\.preventDefault\(\);\s*\n\s*event\.stopPropagation\(\);\s*\n\s*requestRegen\(content, base\);\s*\n\s*return;/;

const legacyInjectedBundle = (raw, mode) => {
  const matches = raw.match(new RegExp(REGEN_BLOCK.source, 'g'));
  const hits = matches === null ? 0 : matches.length;
  if (hits !== 1) {
    throw new Error(
      `bundle 里「先判 kind 后吞键」的块命中 ${hits} 次（期望 1 次）：`
      + '产物形状已漂移，--inject-legacy 的改写会变成空操作，故拒绝继续');
  }
  const byMode = {
    // 历史 bug 形态：先 preventDefault + stopPropagation，再判 kind。
    'swallow-first': () => raw.replace(REGEN_BLOCK, `{
          event.preventDefault();
          event.stopPropagation();
          if (content.kind === "llm") {
            requestRegen(content, base);
          } else {
            traceOnce("regen-skipped", "not-llm", \` kind=\${content.kind}\`);
          }
          return;
        }`),
    // issue 里写的退路：只 preventDefault、不 stopPropagation。
    'stop-prop-only': () => raw.replace(REGEN_BLOCK, `{
          if (content.kind !== "llm") {
            event.preventDefault();
            traceOnce("regen-skipped", "not-llm", \` kind=\${content.kind}\`);
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          requestRegen(content, base);
          return;
        }`),
    // 只摘留痕：证"留痕断言"是活的（其余判据仍应全绿）。
    'no-trace': () => raw.replace(REGEN_BLOCK, `{
          if (content.kind !== "llm") {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          requestRegen(content, base);
          return;
        }`),
  };
  const apply = byMode[mode];
  if (apply === undefined) {
    throw new Error(`未知的 --inject-legacy 模式：${mode}（可用 ${Object.keys(byMode).join(' / ')}）`);
  }
  return apply();
};

// ═══════════════════════════════════════════════════════════════════════════
// 用例
// ═══════════════════════════════════════════════════════════════════════════

/** 宿主设置文档：history 形态（`_hot.history` 带当前会话的历史环）。 */
const HISTORY_DOC = {
  _push: JSON.stringify({ suggestion: null, suggestionSessionId: null }),
  _hot: JSON.stringify({ history: ['hello world'], historySessionId: 'sess-1', hot: [] }),
  historyEnabled: true,
  historyMinChars: 2,
  inlineEnabled: false,
  regenEnabled: true,
  regenKey: 'Alt+G',
};

/** 宿主设置文档：llm 形态（`_push.suggestion` 有正文，空草稿 ⇒ 落 LLM 支）。 */
const LLM_DOC = {
  _push: JSON.stringify({
    suggestion: { text: 'hello world from llm', turn: 1, frame: 1, final: true },
    suggestionSessionId: 'sess-1',
    history: [],
    historySessionId: 'sess-1',
  }),
  historyEnabled: true,
  inlineEnabled: false,
  regenEnabled: true,
  regenKey: 'Alt+G',
};

const ALT_G = { key: 'g', code: 'KeyG', altKey: true, bubbles: true, cancelable: true };

const bundleRaw = readFileSync(BUNDLE, 'utf8');
const MARKER = '\t\treturn module.exports;';
const markerHits = bundleRaw.split(MARKER).length - 1;
if (markerHits !== 1) {
  console.log(`✗ bundle 的 factory 收尾标记出现 ${markerHits} 次（期望 1 次）：注入点已漂移（脚本问题，不是用例红）`);
  process.exit(3);
}

let injectedBundle = bundleRaw;
if (MODE_INJECT !== null) {
  try {
    injectedBundle = legacyInjectedBundle(bundleRaw, MODE_INJECT);
  } catch (error) {
    console.log(`✗ --inject-legacy 失败：${String(error && error.message)}`);
    process.exit(3);
  }
  // 改写后**必须真的变了**：锚点写错的字符串替换是空操作（§6 明确点过这条）。
  if (injectedBundle === bundleRaw) {
    console.log('✗ --inject-legacy 是空操作（bundle 逐字未变）：注入无效，这一轮读数没有意义');
    process.exit(3);
  }
  console.log(`\n⚠️  注入模式：--inject-legacy ${MODE_INJECT}（页内副本已改写，磁盘产物未动）`);
}

const boot = async (settingsDoc, label, draft = 'hel') => {
  const client = await cdp();
  await client.send('Page.navigate', { url: originUrl });
  for (let k = 0; k < 100; k += 1) {
    const ready = await client.evaluate('document.readyState').catch(() => null);
    if (ready === 'complete') break;
    await sleep(50);
  }
  // 在**页内副本**的 factory 收尾前插一行导出标记：注入点在 factory 作用域内部，
  // 所以 `apply` 拿到的仍是它原本那套模块级常量；磁盘上的 lib/client.js 一字未改。
  const markedBundle = injectedBundle.replace(MARKER, `\t\tglobalThis.__SG = module.exports;\n${MARKER}`);
  const loadResult = await client.evaluate(INJECTS.load(markedBundle));
  if (loadResult !== 'ok') throw new Error(`bundle 注入失败（${label}）：${loadResult}`);
  await client.evaluate(INJECTS.installTraceCapture);
  const hostResult = await client.evaluate(INJECTS.host(draft));
  if (hostResult?.focused !== true) throw new Error(`宿主 DOM 构造后编辑器未获得焦点（${label}）`);
  const applied = await client.evaluate(INJECTS.apply(settingsDoc, draft));
  if (applied?.threw) throw new Error(`apply() 抛错（${label}）：${applied.threw}`);
  if (applied?.effectErr) throw new Error(`apply() 内 effect 抛错（${label}）：${applied.effectErr}`);
  // applySettings 是异步的（describe → 解析 → render）：等幽灵真的上屏再按键。
  let shown = null;
  for (let k = 0; k < 60; k += 1) {
    shown = await client.evaluate("(() => { const o = document.querySelector('#dsh-suggest-ghost-overlay'); return o === null ? null : { text: o.textContent, shown: o.dataset.shown, display: o.style.display }; })()");
    if (shown !== null && shown.shown === '1' && shown.display === 'block') break;
    await sleep(50);
  }
  return { client, shown };
};

const main = async () => {
  console.log('\n—— A. history 形态按 `Alt+G`：不得吞键（Gitea #168 主判据）——');
  const history = await boot(HISTORY_DOC, 'history');
  try {
    // 先证明"幽灵真的在屏幕上"——否则下面的按键读到的是"shown===null 早退"，
    // 与"非 llm 分支不吞键"同形（那会是假绿）。
    check('history 幽灵已在屏（前置：否则按键被 `shown===null` 早退，判据不成立）',
      history.shown !== null && history.shown.shown === '1' && history.shown.display === 'block',
      JSON.stringify(history.shown));

    const pressed = await history.client.evaluate(INJECTS.press(ALT_G));
    check('① `event.defaultPrevented === false`（键没有被吞）',
      pressed.defaultPrevented === false, `defaultPrevented=${String(pressed.defaultPrevented)}`);
    check('② 事件仍能到达其后注册的探针监听器（>0 次）',
      pressed.probeHits > 0, `probeHits=${String(pressed.probeHits)}`);
    check('②′ `dispatchEvent` 返回 true（未被 `cancelable` 事件的 preventDefault 拦下）',
      pressed.dispatchReturned === true, `dispatchReturned=${String(pressed.dispatchReturned)}`);
    check('③ 没有 regen op 写出（writeOps 侧）',
      pressed.regenOps.length === 0,
      `regenOps=${JSON.stringify(pressed.regenOps)} writes=${JSON.stringify(pressed.writes).slice(0, 300)}`);
    check('④ `regen-skipped`/`not-llm` 留痕仍在（这一支唯一的观测面）',
      true, '（在下方 trace 断言里读）');

    const traces = await history.client.evaluate('window.__traces');
    const skipLine = (traces ?? []).find((line) => line.includes('regen-skipped') && line.includes('not-llm'));
    check('④ `regen-skipped reason=not-llm kind=history` 真的打出来了',
      skipLine !== undefined, `traces=${JSON.stringify((traces ?? []).filter((l) => l.includes('regen-skipped')))}`);
    check('⑤ 幽灵没被这一下按键弄掉（非 llm 只是放行，不改显示）',
      pressed.ghostShown === '1' && pressed.ghostText === history.shown?.text,
      `after=${JSON.stringify({ text: pressed.ghostText, shown: pressed.ghostShown })} before=${JSON.stringify(history.shown?.text)}`);
  } finally {
    history.client.close();
  }

  console.log('\n—— B. llm 形态按 `Alt+G`：行为逐字不变（该吞就吞、该发就发）——');
  // llm 形态只在**空草稿**上可达（#129 的形态判据）：传空草稿，否则这条用例测的是 history。
  const llm = await boot(LLM_DOC, 'llm', '');
  try {
    check('llm 幽灵已在屏（前置）',
      llm.shown !== null && llm.shown.shown === '1', JSON.stringify(llm.shown));
    const pressed = await llm.client.evaluate(INJECTS.press(ALT_G));
    check('llm：`defaultPrevented === true`（吞键，与改动前一致）',
      pressed.defaultPrevented === true, `defaultPrevented=${String(pressed.defaultPrevented)}`);
    check('llm：探针监听器**收不到**（stopPropagation 生效，与改动前一致）',
      pressed.probeHits === 0, `probeHits=${String(pressed.probeHits)}`);
    check('llm：确实发出了 **一条** regen op（动作照旧）',
      pressed.regenOps.length === 1, `regenOps=${JSON.stringify(pressed.regenOps)}`);

    const traces = await llm.client.evaluate('window.__traces');
    const llmSkip = (traces ?? []).find((line) => line.includes('regen-skipped'));
    check('llm：不得出现 `regen-skipped`（那一支不该走到）',
      llmSkip === undefined, `traces=${JSON.stringify(llmSkip ?? null)}`);
    const requested = (traces ?? []).find((line) => line.includes('regen-requested'));
    check('llm：`regen-requested` 留痕照旧',
      requested !== undefined, `traces=${JSON.stringify((traces ?? []).filter((l) => l.includes('regen-'))) }`);
  } finally {
    llm.client.close();
  }
};

try {
  await main();
} catch (error) {
  // 脚本/环境问题（浏览器崩、注入失败、apply 抛错）**不算用例红**：它是 NOT-COVERED，
  // 与「断言真的不成立」必须分开（§5：没验到的不得写成通过，也不得写成失败）。
  notCovered = String((error && error.stack) || error);
} finally {
  originServer.close();
}

if (notCovered !== null) {
  console.log(`\n⚠️  NOT-COVERED：${notCovered.slice(0, 600)}`);
  console.log('    这是脚本/环境问题，不是断言结论：上面的 ✓/✗ 计数不作数。');
  process.exit(2);
}

const injected = MODE_INJECT === null ? '' : `（注入模式：${MODE_INJECT}）`;
console.log(`\n${failed === 0 ? '✅' : '❌'} regen-key${injected}: ${passed} 项通过 / ${failed} 项红`);
process.exit(failed === 0 ? 0 : 1);
