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
/**
 * `--shot <dir>`：把取证现场截下来存到该目录（默认不截）。
 *
 * **截图不是判据**：本脚本的判定一律来自 `getBoundingClientRect()`。截图的价值在另一处——
 * 几何数字正确但**看着不对**这类问题（颜色太淡、压住了 placeholder、和幽灵视觉上难分）
 * 只有人眼能判，而审 PR 的人手上没有现场。所以截图是给人看的物证，不参与 exit code。
 */
const SHOT_DIR = opt('shot', '') === '' ? '' : String(opt('shot', '')).replace(/^~/, homedir());
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
  /** 存一张截图；只截视口（不做 fullPage，现场就是用户看到的这一屏）。 */
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  };
  return { send, evaluate, shot, consoleLines, close: () => { try { ws.close(); } catch { /* noop */ } proc.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); } };
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
    // ⚠️ 这个列表要覆盖**其他插件**的推广弹窗：实测 dsh-context × dsh-cost-meter 的
    //    「让上下文占用与费用一起可见」全屏模态会盖住整个输入区（按钮是「暂不启用」）。
    //    漏了它 ⇒ 量到的几何是弹窗后面的，截图也全是别人的广告。
    const labels = ['保留当前显示', '暂不开启', '以后再说', '知道了', '不用了', '保留原样',
      '暂不启用', '取消', '稍后', '关闭', '继续', '同意', '我已阅读'];
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
    const hint = document.querySelector('[data-suggest-ghost-keyhint]');
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
  // 视口：默认窗口太窄（实测 780x380），截出来的图只看得到一条会话，没有取证价值。
  // 用 1280x800（本仓其他 GUI 取证的常用尺寸），且**必须在 navigate 之前设**。
  await c.send('Emulation.setDeviceMetricsOverride',
    { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  // 禁缓存 + 每次带一个唯一 query：实测改完 `lib/client.js` 重新部署后，页面仍在跑
  // 旧客户端（位置、z-index、甚至遮住它的元素都一模一样）—— 看起来像"改了没生效"，
  // 实际是 HTTP 缓存。这一条一定要有，否则会去改本来已经对的代码。
  await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  await c.send('Page.navigate', { url: `${urlOf()}&_=${Date.now()}` });
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
    // 种子消息要**够长、够多条**：用户实测的叠字发生在「对话区已滚到底、最后一条正文
    // 紧贴输入卡片上沿」的时候。只发一条短消息时消息停在顶部，提示行翻上去也碰不到它，
    // 判据 ③c 会给出"通过"的假象（本脚本第一版就是这样，没抓到用户的现场）。
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
    if (cleaned) {
      // 再灌几条长消息，把对话区填满并滚到底 —— 这才是用户截图里的那种布局。
      for (let i = 0; i < 4; i += 1) {
        const filler = `第${i + 1}条填充消息，用来把对话区滚到底部，使最后一条正文紧贴输入卡片上沿。`
          + '这一段故意写长一些，保证每条都能占满好几行，从而真正把可视区填满。'
          + '重复内容不影响判据，只影响布局。';
        await c.evaluate('window.__k.clearDraft()');
        await c.send('Input.insertText', { text: filler });
        await sleep(250);
        await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await c.evaluate(`(async () => { const x = window.__k;
          return x.until(() => (x.composer()?.textContent ?? '').length === 0, 6000); })()`);
        await sleep(400);
      }
      // 滚到底：把对话滚动容器拉到最底
      await c.evaluate(`(() => {
        const sels = ['[class*=viewArea]', '[class*=scrollBody]', '[class*=scroll]'];
        for (const sel of sels) {
          for (const el of document.querySelectorAll(sel)) {
            if (el.scrollHeight > el.clientHeight) { el.scrollTop = el.scrollHeight; }
          }
        }
        return true;
      })()`);
      await sleep(600);
    }
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
        keyhint: document.querySelector('[data-suggest-ghost-keyhint]') == null ? null
          : { flag: document.querySelector('[data-suggest-ghost-keyhint]').dataset.keyhint },
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
    const present = await c.evaluate(`(() => {
      const h = document.querySelector('[data-suggest-ghost-keyhint]');
      if (h == null) return { exists: false };
      return { exists: true, text: (h.textContent ?? ''), display: getComputedStyle(h).display,
        rect: (() => { const r = h.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom),
                   left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height) }; })() };
    })()`);
    check('① 提示行由宿主槽位渲染出来（存在于 DOM、可见、有文案）',
      present.exists && present.display !== 'none' && (present.text ?? '').length > 0,
      JSON.stringify(present));

    // ── 判据 2：它挂在宿主的 overlay 锚点里，且浮在锚点**上方**（不占行位）──
    //
    // 槽位从 `dock` 换成 `overlay` 之后，位置语义变成:
    //   父级 = `.overlayAnchor`（position:absolute; height:0; 在输入卡片顶部），
    //   提示行 = 该锚点的子项、`bottom:100%` ⇒ 浮在锚点上方一行。
    // 判据直接查这两件事：父级是 overlay 锚点、且 rect 在锚点之上。
    const inStack = await c.evaluate(`(() => {
      const h = document.querySelector('[data-suggest-ghost-keyhint]');
      if (h == null) return { step: 'absent' };
      const anchor = h.parentElement;
      const isAnchor = anchor != null && anchor.hasAttribute('data-composer-overlay');
      const ar = anchor?.getBoundingClientRect() ?? null;
      const hr = h.getBoundingClientRect();
      const n = window.__k.composer();
      const card = n?.closest('[data-input-scroll]')?.parentElement ?? n?.parentElement ?? null;
      const cr = card?.getBoundingClientRect() ?? null;
      // 父链画像：槽位容器可能多包一层（宿主 list 槽通常有自己的 wrapper），
      // 所以不能假设 parentElement 就是锚点本身。
      const chain = []; let e2 = h;
      for (let k = 0; k < 4 && e2 != null; k += 1) {
        const rr = e2.getBoundingClientRect();
        chain.push({ tag: e2.tagName, cls: (e2.className ?? '').toString().slice(0, 26),
          overlay: e2.hasAttribute?.('data-composer-overlay') ?? false,
          pos: getComputedStyle(e2).position,
          rect: [Math.round(rr.top), Math.round(rr.bottom)] });
        e2 = e2.parentElement;
      }
      return { step: 'ok', chain, isAnchor,
        anchorH: ar === null ? null : Math.round(ar.height),
        aboveAnchor: (() => {
          const a = chain.find((c) => c.overlay === true);
          return a == null ? false : hr.bottom <= a.rect[0] + 1;
        })(),
        insideCard: cr === null ? null : (hr.left >= cr.left - 1 && hr.right <= cr.right + 1),
        pos: getComputedStyle(h).position,
        hint: [Math.round(hr.top), Math.round(hr.bottom)], anchor: ar === null ? null : [Math.round(ar.top), Math.round(ar.bottom)] };
    })()`);
    // 判据按实测的形状写：父级可能多一层 wrapper，**祖上有 overlay 锚点**即可，
    // 关键是要「浮在锚点上方」（不占行位）且「在卡片宽度内」。
    check('② 提示行挂在 overlay 锚点族里，且横向落在输入卡片宽度内',
      inStack?.step === 'ok'
        && (inStack.chain ?? []).some((c) => c.overlay === true)
        && inStack.insideCard === true,
      JSON.stringify(inStack));

    // ── 判据 ②b：横向与输入卡片**对齐**（宽度约束一致、左边缘重合）──
    //
    // 判据 ② 只验了"在卡片上方"，实测过的错位是**横向**的：提示行贴 composerStack 左缘
    // （x≈283）而卡片居中（x≈427），用户截图反馈「怎么在这个位置」。几何都对、观感全错。
    // ⇒ 直接比左边缘：差值超过 2px 就算没对齐（留 2px 容差吸收圆角/亚像素）。
    const align = await c.evaluate(`(() => {
      const h = document.querySelector('[data-suggest-ghost-keyhint]');
      const n = window.__k.composer();
      if (h == null || n == null) return { step: 'absent' };
      const card = n.closest('[data-input-scroll]')?.parentElement ?? n.parentElement;
      const hr = h.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      return { step: 'ok', hintLeft: Math.round(hr.left), cardLeft: Math.round(cr.left),
        hintW: Math.round(hr.width), cardW: Math.round(cr.width),
        delta: Math.round(Math.abs(hr.left - cr.left)) };
    })()`);
    check('②b 提示行与输入卡片横向对齐（左边缘差值 ≤ 2px）',
      align?.step === 'ok' && align.delta <= 2,
      `hintLeft=${align?.hintLeft} cardLeft=${align?.cardLeft} delta=${align?.delta} hintW=${align?.hintW} cardW=${align?.cardW}`);

    // ── 判据 3：不与**草稿文字**、不与**幽灵文字**相交 ──
    //
    // 判据形态改过一次：原先要求「与编辑器元素的矩形零交集」，但那过严 ——
    // 编辑器盒（`[data-composer-input]`）从卡片顶往下 8px 就开始，**包含自身 padding
    // 与行高余量**；而提示行放在卡片顶部 14px 空隙里，几何上必然与那个矩形相交，
    // 视觉上却只占上方 11px、完全不碰草稿的字。
    //
    // ⇒ 改为量**文字**：用 Range 取草稿首字符矩形、幽灵 overlay 矩形，比它们的交集。
    //    这才是"压没压到内容"的直接判据。
    const textRects = await c.evaluate(`(() => {
      const n = window.__k.composer();
      const h = document.querySelector('[data-suggest-ghost-keyhint]');
      const ov = document.getElementById('dsh-suggest-ghost-overlay');
      if (n == null || h == null) return null;
      const hr = h.getBoundingClientRect();
      // 草稿文字：第一个非空文本节点的首字符
      let draft = null;
      const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t != null; t = walker.nextNode()) {
        if ((t.nodeValue ?? '').trim() === '') continue;
        const rng = document.createRange();
        rng.setStart(t, 0); rng.setEnd(t, Math.min(1, (t.nodeValue ?? '').length));
        const rr = rng.getBoundingClientRect();
        if (rr.height > 0) { draft = { top: Math.round(rr.top), bottom: Math.round(rr.bottom),
          left: Math.round(rr.left), right: Math.round(rr.right) }; break; }
      }
      // ⚠️ overlay 的 rect 含行高（比字形高），直接用它比会得到假阳性（实测 1148px²）。
      // 用 Range 量幽灵**首字符的墨迹矩形**，与"压没压到字"这个真实问题对齐。
      let ovr = null;
      if (ov != null && ov.dataset.shown === '1') {
        const w2 = document.createTreeWalker(ov, NodeFilter.SHOW_TEXT);
        for (let t = w2.nextNode(); t != null; t = w2.nextNode()) {
          if ((t.nodeValue ?? '').trim() === '') continue;
          const rng = document.createRange();
          rng.setStart(t, 0); rng.setEnd(t, Math.min(1, (t.nodeValue ?? '').length));
          const rr = rng.getBoundingClientRect();
          if (rr.height > 0) { ovr = { top: Math.round(rr.top), bottom: Math.round(rr.bottom),
            left: Math.round(rr.left), right: Math.round(rr.right) }; break; }
        }
        // 兜底：量不到字形就用元素 rect（至少不是静默跳过）
        if (ovr === null) { const r = ov.getBoundingClientRect();
          ovr = { top: Math.round(r.top), bottom: Math.round(r.bottom),
            left: Math.round(r.left), right: Math.round(r.right) }; }
      }
      return { hint: { top: Math.round(hr.top), bottom: Math.round(hr.bottom),
        left: Math.round(hr.left), right: Math.round(hr.right) }, draft, overlay: ovr };
    })()`);
    const aDraft = inter(textRects?.hint, textRects?.draft);
    const aOverlayTxt = inter(textRects?.hint, textRects?.overlay);
    check('③ 与草稿文字、与幽灵墨迹都不相交（面积交 = 0）',
      textRects != null && aDraft === 0 && aOverlayTxt === 0,
      `与草稿文字交=${aDraft}px² 与幽灵墨迹交=${aOverlayTxt}px² hint=${JSON.stringify(textRects?.hint)} draft=${JSON.stringify(textRects?.draft)} ghost=${JSON.stringify(textRects?.overlay)}`);

    // ── 判据 3b：可见（命中测试；纯展示元素要临时打开 pointer-events）──
    const hit = await c.evaluate(`(() => {
      const h = document.querySelector('[data-suggest-ghost-keyhint]');
      if (h == null) return { step: 'absent' };
      const r = h.getBoundingClientRect();
      const cx = r.left + 8;
      // 采样点取盒内**稳妥的三等分处**，不用底边减 2：14px 盒高时那一点贴着下沿，
      // 会被下一层（草稿行）命中 —— 那是 1px 级的边界效应，不是真的被盖住。
      const ys = [r.top + 3, r.top + r.height / 2, r.bottom - 3];
      const prev = h.style.pointerEvents;
      h.style.pointerEvents = 'auto';
      const probes = ys.map((cy) => {
        const el = document.elementFromPoint(cx, cy);
        const ok = el === h || (el != null && h.contains(el));
        // 没命中的点要报出**是谁**盖住了它（只报 tag 等于没报）
        let who = null;
        if (!ok && el != null) {
          const cs2 = getComputedStyle(el);
          const r2 = el.getBoundingClientRect();
          who = { tag: el.tagName, cls: String(el.className ?? '').slice(0, 22),
            z: cs2.zIndex, pos: cs2.position, bg: cs2.backgroundColor,
            rect: [Math.round(r2.top), Math.round(r2.bottom)] };
        }
        return { y: Math.round(cy), isHint: ok, tag: el?.tagName ?? null, who };
      });
      h.style.pointerEvents = prev;
      return { step: 'ok', probes };
    })()`);
    check('③b 提示行可见（命中测试通过）',
      hit?.step === 'ok' && hit.probes.every((x) => x.isHint), JSON.stringify(hit?.probes));

    // ── 诊断：编辑器盒子的内边距（决定"卡片顶空白"到底在哪一层）──
    const pad = await c.evaluate(`(() => {
      const n = window.__k.composer();
      const card = n?.closest('[data-input-scroll]')?.parentElement ?? n?.parentElement;
      if (n == null || card == null) return null;
      const cs = getComputedStyle(n), cc = getComputedStyle(card);
      const nr = n.getBoundingClientRect(), cr = card.getBoundingClientRect();
      return { composerPadTop: cs.paddingTop, cardPadTop: cc.paddingTop, cardGap: cc.gap,
        composerTop: Math.round(nr.top), cardTop: Math.round(cr.top),
        delta: Math.round(nr.top - cr.top) };
    })()`);
    say(`  内边距诊断：${JSON.stringify(pad)}`);

    // ── 判据 3c：不压对话正文 ──
    const overText = await c.evaluate(`(() => {
      const h = document.querySelector('[data-suggest-ghost-keyhint]');
      if (h == null) return { step: 'absent' };
      const hr = h.getBoundingClientRect();
      const inter = (a, b) => { const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const hh = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return w > 0 && hh > 0 ? Math.round(w * hh) : 0; };
      const hits = [];
      for (const el of document.querySelectorAll('[class*=markdown] p, [class*=viewArea] p, main p')) {
        if (el === h || h.contains(el) || el.contains(h)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const a = inter(hr, r);
        if (a > 0) hits.push({ area: a, text: (el.textContent ?? '').trim().slice(0, 18) });
      }
      return { step: 'ok', hits: hits.slice(0, 3) };
    })()`);
    check('③c 提示行不压住对话正文（面积交 = 0）',
      overText?.step === 'ok' && overText.hits.length === 0, JSON.stringify(overText?.hits));

    // ── 诊断：卡片顶部 → 草稿文字首行 之间**真实可用**的空白高度 ──
    //
    // 之前我把 `card padding-top:8px` 当成"可用高度"就下了"放不下"的结论，那是量错了层：
    // 卡片里还有 `gap:12px`、编辑器自带 padding、行高余量。用户圈的位置明显更宽。
    // 这里直接量几何：卡片顶 → 编辑器**文字首行**的顶部（用 Range 取首字符的 rect）。
    const space = await c.evaluate(`(() => {
      const n = window.__k.composer();
      const card = n?.closest('[data-input-scroll]')?.parentElement ?? n?.parentElement;
      if (n == null || card == null) return null;
      const cr = card.getBoundingClientRect();
      // 取编辑器内第一个文本节点的首字符矩形 = 草稿文字真正起始位置
      let textTop = null;
      const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t != null; t = walker.nextNode()) {
        if ((t.nodeValue ?? '').trim() === '') continue;
        const rng = document.createRange();
        rng.setStart(t, 0); rng.setEnd(t, 1);
        const rr = rng.getBoundingClientRect();
        if (rr.height > 0) { textTop = Math.round(rr.top); break; }
      }
      const cs = getComputedStyle(n);
      return { cardTop: Math.round(cr.top), textTop,
        spaceAboveText: textTop === null ? null : textTop - Math.round(cr.top),
        cardPadTop: getComputedStyle(card).paddingTop,
        composerPadTop: cs.paddingTop, composerLineHeight: cs.lineHeight };
    })()`);
    say(`  卡片顶到草稿首行的空隙：${JSON.stringify(space)}`);

    // ── 判据 ③d：提示行**不许盖住任何兄弟层**（方向被自己搞反过一次）──
    //
    // 踩过的坑：上一版写「谁盖住了提示行」（elementFromPoint 命中不是自己就红），
    // 结果提示行 z-index 更高、它盖在排队卡片上 ⇒ 命中自己 ⇒ **全绿**，
    // 而用户截图明显是重叠。方向错了：要紧的是「提示行有没有压到别人」。
    // ⇒ 遍历所有可见兄弟元素，算与提示行的面积交；非零就是遮挡。
    //    （跳过自己的祖先链与 pointer-events:none 的纯装饰层。）
    const occl = await c.evaluate(`(() => {
      const h = document.querySelector('[data-suggest-ghost-keyhint]');
      if (h == null) return { step: 'absent' };
      const hr = h.getBoundingClientRect();
      const anc = new Set(); let a = h.parentElement;
      while (a != null) { anc.add(a); a = a.parentElement; }
      const hits = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el === h || h.contains(el) || anc.has(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
        // 只关心「有点像容器/卡片」的层：背景透明且无边框的纯 wrapper 不算
        const hasSurface = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.boxShadow !== 'none'
          || parseFloat(cs.borderTopWidth) > 0;
        if (!hasSurface) continue;
        const w = Math.min(hr.right, r.right) - Math.max(hr.left, r.left);
        const hh = Math.min(hr.bottom, r.bottom) - Math.max(hr.top, r.top);
        if (w <= 0 || hh <= 0) continue;
        hits.push({ who: el.tagName + '.' + String(el.className ?? '').slice(0, 22),
          area: Math.round(w * hh), text: (el.textContent ?? '').trim().slice(0, 14) });
      }
      // 面积最小的先看（同一次重叠会被祖先链重复计入，取最内层）
      hits.sort((x, y) => x.area - y.area);
      return { step: 'ok', hits: hits.slice(0, 4), total: hits.length };
    })()`);
    check('③d 提示行未压住任何兄弟层（与所有有底色的可见元素面积交 = 0）',
      occl?.step === 'ok' && occl.total === 0,
      `hits=${JSON.stringify(occl?.hits)} total=${occl?.total}`);

    // ── 现场截图（物证，不参与判定） ──
    if (SHOT_DIR !== '') {
      const out = join(SHOT_DIR, 'key-hint-ghost.png');
      await c.shot(out);
      say(`  已存截图：${out}`);
      // 局部细节图：整屏图里 11px 提示行看不清，裁「输入卡片上沿 + 提示行 + 卡片首行」一条带。
      const gg = await c.evaluate('window.__k.geom()');
      if (gg?.composer != null) {
        const pad = 20;
        const left = Math.max(0, gg.composer.left - pad);
        const top = Math.max(0, (present.rect?.top ?? gg.composer.top) - pad * 2);
        const clip = {
          x: left,
          y: top,
          width: Math.min(1280 - left, (gg.composer.right - left) + pad),
          height: Math.min(800 - top, (gg.composer.bottom - top) + pad * 2),
          scale: 2,
        };
        const r = await c.send('Page.captureScreenshot', { format: 'png', clip });
        const detail = join(SHOT_DIR, 'key-hint-ghost-detail.png');
        writeFileSync(detail, Buffer.from(r.data, 'base64'));
        say(`  已存细节图：${detail}（clip=${JSON.stringify(clip)}）`);
      }
    }

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
    const hintGone = await c.evaluate(`(() => document.querySelector('[data-suggest-ghost-keyhint]') == null)()`);
    check('⑤ 草稿清空后幽灵与提示行**成对消失**（槽位组件返回 null，节点不存在）',
      (g3.overlayShown !== '1' && hintGone) || (g3.overlayShown === '1' && hintGone === false),
      `cleared=${JSON.stringify(cleared)}\n      overlayShown=${g3.overlayShown} hintGone=${hintGone}`);
  }
  // ── 判据 ⑥：**没有幽灵时提示行必须不在**（用户实测的 bug 回归闸）──
  //
  // 现场：草稿为空、幽灵不在屏上，提示行却还挂着。根因见 index.ts 的修复注释
  // （清空散落在带 `shown !== null` 守卫的早退分支里）。
  // 这里把草稿彻底清空、等幽灵消失，然后断言：
  //   a) 幽灵确实不在（`shown !== '1'`）—— 否则本条 NOT-COVERED，不能算过；
  //   b) 提示行节点**不存在**（槽位组件返回 null，不是 display:none）。
  if (c != null) {
    try {
      await c.evaluate('window.__k.clearDraft()');
      for (let k = 0; k < 3; k += 1) {
        await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      }
      await sleep(2500);
      const idle = await c.evaluate(`(() => {
        const ov = document.getElementById('dsh-suggest-ghost-overlay');
        return { ghostShown: ov?.dataset.shown ?? null,
          ghostDisplay: ov == null ? null : getComputedStyle(ov).display,
          draftChars: (window.__k.composer()?.textContent ?? '').length,
          hintExists: document.querySelector('[data-suggest-ghost-keyhint]') != null };
      })()`);
      const noGhost = idle.ghostShown !== '1' || idle.ghostDisplay === 'none';
      if (!noGhost || idle.draftChars > 0) {
        skip('⑥ 无幽灵时提示行不在', `前置不成立：ghost=${idle.ghostShown}/${idle.ghostDisplay} draftChars=${idle.draftChars}`);
      } else {
        check('⑥ 没有幽灵文本时，提示行**完全不渲染**（节点不存在，不是隐藏）',
          idle.hintExists === false, JSON.stringify(idle));
      }
    } catch (e) {
      skip('⑥ 无幽灵时提示行不在', `清理步骤异常：${String(e).slice(0, 60)}`);
    }
  }
  if (tally.notCovered > 0) say('（NOT-COVERED 不是通过：缺的前置写在上面对应行里）');
} catch (e) {
  if (e !== NOT_COVERED) { tally.fail += 1; say(`✗ 脚本异常：${e.message}`); }
} finally {
  if (c != null) c.close();
  if (pids.length > 0) {
    // 只停实例，不删沙箱（删要 --cleanup，走沙箱自己的三处枚举）
    for (const pid of pids) { try { process.kill(Number(pid), 'SIGTERM'); } catch { /* noop */ } }
  }
  say(`\n== 汇总：PASS ${tally.pass} / FAIL ${tally.fail} / NOT-COVERED ${tally.notCovered} ==`);

  process.exit(tally.fail === 0 && tally.notCovered === 0 ? 0 : tally.fail > 0 ? 1 : 2);
}
