# issue 草稿：overlay 在页面冷启动后未立即挂载（需等一次输入或会话事件才恢复）

> 状态：**待建 issue**，2026-11-10 在真实 GUI 中观察到，未修复。
> 本文件是草稿，不是 issue 正文的最终形态。

## 现象

打开 `http://127.0.0.1:3080`（全新页面加载，非刷新），等 composer 出现后：

| 探测 | 结果 |
|---|---|
| `[data-composer-input]` | ✅ 存在、可见、isConnected |
| `[data-composer-card]` | ✅ 存在 |
| `#dsh-suggest-ghost-overlay` | ❌ **null** |
| `style[data-plugin-css="dsh-suggest-ghost"]` | ✅ 存在 |
| `style[data-plugin-css="dsh-suggest-ghost-pending-css"]` | ❌ 不存在 |

**在有输入框、并且插件样式已注入的情况下，幽灵 overlay 节点不存在。**

在输入框里打一次字（触发 `input` 订阅 → `renderTraced('input')`）之后：

```
overlayRestored: true
pendingStyles: true   ← 惰性样式标签也补上了
```

即节点是**事后才被创建**的，不是页面加载时就位。

## 影响

- 页面刚打开、宿主推来建议（`_push` 里有 `suggestion`）时，**用户看不到幽灵**——因为没有 overlay 节点可挂。
- 同理，任何"初始化渲染那次没成功"的路径都会让插件在一个会话的早期完全失效，直到用户第一次输入。

## 可能的位置（未验证）

`src/client/index.ts` 的渲染 effect（`dsh-suggest-ghost: composer ghost render`）初始化时会调
`renderTraced('other')`，注释写的是"会话打开即检查幽灵"。但：

- `render()` 在 `bound === null` 时会提前 return（`ghostContent` 返回 `null`），此时
  overlay 从未被 `show()` 过 —— 这是**预期**，不是 bug；
- 真正可疑的是 **`GhostOverlay` 的构造与挂载时机**：`attach()` 由谁触发？
  如果只有 `show()` 路径才会挂载，那么"没有可显示的幽灵"就等于"节点不存在"，
  而节点的存在本身又是 `body:has(#overlay[data-shown])` 让位 placeholder 的前提。

  ⇒ 若 `attach()` 只在 `show()` 里发生，那么"首次有幽灵时临时挂载"在时序上是否能保证
  同一帧完成（先把占位让位、再绘制）？这一点需要读 `attach()` / `show()` 的调用链确认。

## 验证方法（建 issue 时附上）

```js
// 页面加载后立刻执行
document.querySelectorAll('[id*="suggest-ghost"]').length   // 期望 > 0，实测 0
document.querySelector('style[data-plugin-css="dsh-suggest-ghost"]') !== null  // true
```

然后在输入框打一个字，再跑一次，应当变成 1。

## ⚠️ 与 CHANGELOG 里"4.5s 出现幽灵"的关系（同轮发现，别以为是矛盾）

两条陈述**同时成立**，但适用条件不同：

| 观测 | 前置条件 |
|---|---|
| overlay 节点不存在 | 页面**刚加载**、用户**还没打过字** |
| 4.5s 出现幽灵（`shown:"1"`） | 已经打过一次字（触发过 `input` render） |

即：本 issue 描述的是「冷启动到首次输入之间」的窗口，不是"幽灵永远不出来"。
同一轮里既看到过节点缺失、也看到过幽灵正常出现，区别就在于中间有没有一次输入。

## 与本次修复的关系

**无关**。本次改动（生成中指示 + 对齐分档）不涉及 overlay 的挂载时机。
这条需要单独排查，因为它影响的是"幽灵能不能显示"，而不是"指示亮不亮"。
