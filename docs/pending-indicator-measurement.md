# 实测记录：生成中指示的真实时序（2026-11-10）

> 这份文件是本轮 CHANGELOG 引用的「0.5s → 4.5s」样本的**出处**。
> 采集者：`diag-runtime`（Playwright 网络层抓包 + 页面采样），复核者：lead。
> 采集对象：真实 GUI（`http://127.0.0.1:3080`，真内核、真模型），**不是复刻页面**。

## 采集方法（如实记录，含失败尝试）

- **够不到 `remote.settings.mutate` 对象**：插件通过 cordis 的 `ctx.get('remote').settings` 访问它，
  浏览器里没有暴露模块表，`window` 上只有 `__DSH_*` 配置项 ⇒ 退到**网络层抓包**。
- 用 `page.route` 拦 `/api/settings/mutate`，取**完整请求体与响应体**。
  ⚠️ 这步是必需的：HTTP 状态码一直是 **200**，成败只在响应体的 `result.ok` 里。
- 输入走**真实键盘**（`page.keyboard.type`）。**`document.execCommand` 在这条链路上不可用**——
  Lexical 编辑器不认它，清空与插入都会静默失败（本轮实测：`selectAll`+`delete` 后 `textContent` 仍是原文本）。
- 清空：点输入框 → `Control+a` → `Backspace` → **验证 `textContent.length === 0`** 才继续。

## 读数一：mutate 调用（证明 complete 送达）

| 时间（输入后） | op | expectedRevision | 响应 `result.ok` | 视图 revision | 错误码 |
|---|---|---|---|---|---|
| ~1.1 s | `set _ops` | 1745 | **true** | 1747 | 无 |
| ~1.1 s | `set _ops`（第二轮） | 1746 | **true** | 1747 | 无 |

两轮**各只有一条** mutate：无 reject、无 conflict 重试、无 `_ops write …` 告警。
返回视图形如 `{ok:true, value:{ns:'suggest-ghost', …, revision:1747, value:{_ops:<发送值>}}}`，
`_opsAfter === sent` ⇒ 判定 `landed`。

**对照探针**：另发一条手工 mutate（写 `{"op":"probe"}`），revision 1745→1746，读回 `_ops` 正是那串 ⇒ CAS 通道本身正常。

⇒ **`complete` op 成功送达宿主并落盘。**

## 读数二：指示与幽灵的时序（干净样本）

```
t=0~0.4s   {shown:"0"}                              幽灵空
t≈0.5s     {shown:"0", caretGlow:"1"}
           getComputedStyle(editor).animationName === "sg-caret-glow"   ← 点亮
t≈4.5s     {shown:"1"}                              ← 幽灵出现，caretGlow 被清除
           幽灵文本："，毕竟新增了兼容性修复，用户在升级前最好能提前知道影响范围。"
t=4.5s~55s 稳定
```

**本环境一次续写约 4 秒**。注意这与 CHANGELOG 里 10 月记录的「19~28 秒」不同——
那是当时的路由/网络条件，**不要拿老数字当当前预期**。

## 读数三：反例（同一轮抓到的，解释「亮灯但没字」之一）

第二轮 51 秒全程 `shown:"0"`，末了：

```
[ops-trace] completion not shown: reason=draft-mismatch
            draftChars=1 payloadDraftChars=15 completionChars=30
```

**不是送达失败**，是测试顺序造成的：刚打完字时 `_push` 里还残留上一轮的 completion（旧句子）。
这条触发了本轮的 `payload-superseded` 分档修复（见 CHANGELOG）。
第一轮才是干净样本。

## 已知的记录缺口

- 上述时序**只有一轮干净样本**（第二轮的对照被自己的测试顺序污染）。要更强的结论需要多跑几轮。
- 抓包只覆盖 `/api/settings/mutate`，未覆盖宿主 → 客户端的 `_push` 通道（那条走 settings 文档读取）。
