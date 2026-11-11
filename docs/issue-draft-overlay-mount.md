# overlay 挂载问题（原草稿，已按实测重写）

> **状态**：`2026-11-11` 由 `diag-overlay` 在真实 GUI 实测后重写。
> 原版草稿有三条**过虑**（见下「被证伪的」），已保留原文引用以便对照，不要拿旧版当依据。
> 修复见本轮的 PR（overlay attach 短路 + pending 钩子载体）。

## 一句话

`overlay.attach()` 用 **composer 引用**做短路判据，节点被摘走后**不会自愈**；
同时 pending 指示钩子写在 `overlay.el` 上，而该节点**只在有幽灵要显示时才挂载**。

## 已证实的（有实测读数）

### A｜节点被摘走后永久不重挂（主）

`src/client/index.ts:779`

```ts
private attach(composer: HTMLElement): void {
  if (this.composer === composer) return;   // ← 用 composer 引用短路
```

composer 引用没变 ⇒ `parent.appendChild(this.el)` 永不执行。

**实测**（Playwright，真实键盘）：attach 过之后人为摘掉 overlay 节点，
继续输入 `at`、清空、再输 `grep`，节点**再也没回来**：

```
{"afterTyping":{"exists":false,"shown":null,"text":null,"draft":"git lgit statowor"}}
```

**诚实边界**：摘节点是**人为构造**的。真实宿主在什么操作下会"保留 composer 引用但换掉
`.grow` 内容"**未定位**（切会话那条路径实测是健康的）。所以这条的性质是
「**一旦发生就永不自愈**」，不是「线上必现」。

### B｜pending 指示钩子挂在会消失的节点上（次）

`syncPendingStyle()` 在所有早退**之前**调用（`src/client/index.ts:1942`），
但它写的是 `this.el.dataset`（`:1227`），而 `el` 只在 `attach()` 里 append（`:789`）。

**实测**：构造游离 div 并写 `dataset.caretGlow='1'` ⇒ `inDom:false, byAttr:0`，
`body:has(...)` 规则 `ruleHits:false`。游离节点上的写入**零可观测**。

⇒ 冷启动未 attach 期间，即使两个指示开关都开着，生成中指示也不会亮，且 DOM 上无痕迹可取证。

### C｜测试盲区

`scripts/regen-pending-smoke.mjs:81-83` 只做**源码正则匹配**，从不运行 DOM。
这个维度**从未被覆盖**——正是 `CONTRIBUTING.md` 警告的「形状断言不配行为对照」。

## 被证伪的（原草稿写错，别再查）

| 原草稿的说法 | 实测结论 |
|---|---|
| 「让位规则受影响」（第 43 行写成"可疑"） | **过虑**。节点不存在时 `body:has(#overlay[data-shown="1"]…)` 自然不命中，placeholder 全程 `flow-root/visible` |
| 「首次显示会有额外延迟/错判」 | **证伪**。首次 attach 与首次 show **同一帧**（`firstSeenAfterMs=1705` = `firstShownAfterMs=1705`），首帧即完整内容，无"先挂空节点再补" |
| 「切会话 → detach → 重挂载会坏」 | **证伪**。`detach()` 只在 `dispose()`（effect 清理）里调；切会话后节点 ABSENT 是随父容器一起替换，**打一个字符即恢复** |

## 没测到的（不要当成已解决）

- **「冷启动漏掉真实建议」证不了**：干净冷启动 25s 内 overlay 确实一直 ABSENT，
  但缓存里那条建议属于会话 `d55b6f4c`、当前会话是 `12fad001`——**不同会话**，
  那段缺席是**正确的**。缺一次「本会话建议已就位 + 冷启动」的对照读数。
- 读设置面失败（RPC 形状未猜中），指示开关的真实取值未直接读到，B 条依赖代码路径推断。

## 修法

- **A**：attach 短路加存活判据（`composer === composer && this.el.isConnected` 才 return）。
- **B**：把"挂载"与"显示"解耦（首次 render 即挂 `display:none` 的常驻节点），
  或把 pending 状态写到不随幽灵内容消失的载体。
- **C**：`regen-pending-smoke` 升级成真的运行 DOM。
