# dsh-workspace-files

> Left-sidebar file switch: hover a workspace row, click the icon, and its session list
> becomes a lazy file tree.
>
> 左侧边栏的 **工作区行 → 文件列表** 切换（对标 zcode 的交互）。

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

- 鼠标移到某个**工作区标题行**上 → 行右侧浮出一个**切换图标**
- 点它 → **该工作区下面的会话列表收起来，换成这个工作区的文件树**
- 再点一次 → 切回会话列表
- 展开的工作区记在 `localStorage["dsh-workspace-files:open"]`，刷新/重启后自动恢复
- 目录**懒加载**（点开才请求，结果进内存缓存），面板头部有「重新载入」清缓存重取
- 点文件 → 拼 `dsh-resource://file/session/<id>/<path>` 交给右侧栏打开

只动左侧对话栏。

## 安装

```bash
dsh plugin --profile <profile> add github:jipika/dsh-workspace-files
```

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: workspace-files
      name: dsh-workspace-files
```

`desktop` profile 被 Electron 独占（CLI 子命令会被拒），需手改 `package.json` + `pnpm install`；
**改 `lib/client.js` 后必须重启 host 进程（或应用）**，刷新页面无效。

**卸载**：删掉那行 insert（或加 `disabled: true`）→ 重启：按钮、面板、隐藏都消失，会话列表恢复原样。

## 两态切换

- 按钮图标是「圆角方框 + 两行短横」的列表图标（**不用文件夹** —— 文件夹容易被误读成"打开目录"，而这里切换的是整个列表的视图）。
- 未激活（当前看会话）时按钮灰显、只在鼠标悬停工作区行时出现；激活（当前看文件）时变**强调色 + 浅底色块**。
- tooltip 与 `aria-pressed` 随状态在「查看文件列表」/「切换回会话列表」之间切换，点一下就是回另一态。
- 文件树**内部**的目录节点仍用文件夹图标 —— 那才是"这是一个目录"的语义。

官方右侧栏那个文件树 tab（`@deepseek-ai/dsh-client-ui-sidebar-files`）完全不碰。

## 原理（零源码补丁）

| 环节 | 做法 |
| --- | --- |
| 拿数据 | 直接读 client 服务 `ctx.get("workspaces")` / `ctx.get("sessions")`（官方 `dsh-client-ui-workspace` 自己就是这么取的），用 `getSnapshot`/`getState`/`subscribe` 多路适配服务形状。**刻意不注册 `sidebar.workspaces` slot** —— 官方 sidebar 源码注释写明那块区域是 "the registrant's"，且官方注册时没声明 kind，再注册一个条目有挤掉官方工作区列表的风险 |
| 找 DOM | **不硬编码 CSS Module 的 hash 前缀**，用属性子串选择器 `[class*="_projectRow"]` / `[class*="_sessionRow"]` —— hash 随版本变，`_projectRow` 这个后缀名不变 |
| 归属关系 | 用 `TreeWalker` 按**文档顺序**推断：遇到下一个 `_projectRow` 之前的所有 `_sessionRow` 都归它。不依赖具体嵌套层级 |
| 文件数据 | 走官方 Remote：`remote.workspaceFiles.list(sessionId, parent)` → `{ ok, value: { entries: [{name,type}], truncated } }`。`parent` 是**被列目录的绝对路径**（官方 `childPath(parent, name)` 就是 `parent + "/" + name`；传空串会被网关判 `gateway/bad-request`），实际取该会话记录的 `cwd` |
| 打开文件 | 拼 `dsh-resource://file/session/<id>/<path>` 地址，交给 `ctx.sidebarRight.openResource(...)`（没有该服务时退化为打印地址） |
| 目录懒加载 | 点开目录才请求，结果进内存缓存；8 秒超时保护；面板头部的「重新载入」清缓存重取 |

隐藏会话行用**属性标记 + CSS 规则**（`[data-wsf-hidden="1"]{display:none!important}`），不用内联 style
—— 内联 style 会被官方 React 重渲染覆盖。

## 自诊断

重启后在 DevTools 控制台执行：

```js
__dshWorkspaceFiles()
```

返回插件当前看到的东西：

```js
{ openKey, workspacesSeen, sessionsSeen, projectRows, sessionRows, panels, services, sample, sessionSample }
```

- `projectRows` 为 0 → DOM 选择器没匹配上（官方类名规则变了）
- `workspacesSeen` 为 0 → `ctx.get("workspaces")` 没取到数据：看返回里的 `services.workspaces` 字段（`"缺失"` 表示服务名变了，否则列出的是取到的成员名）
- 面板里显示「拿不到该工作区的 session」→ workspace 记录里没有可用的 session id（`sample` 里能看到实际形状）

插件还会在发生变化时写一条 `dsh-workspace-files:diag` 记录，便于回看。

## 已知限制

- 靠 DOM 挖掘与内部服务形状适配，官方侧边栏结构变化后需要跟改（自诊断函数就是为这个准备的）。
- 需要 `exports.inject = ["remote.workspaceFiles"]`：cordis 会拦截未声明的服务，
  缺了它会报 `cannot get property "remote.workspaceFiles" without inject`。
- 会话与工作目录必须成对取自同一条 session 记录 —— 用 A 会话的 id 配 B 会话的路径，
  网关会判 `bad-request`（甚至越权读别的目录），所以 `rootFor()` 里刻意不混用。

## License

MIT © 2026 jipika
