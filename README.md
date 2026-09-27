# dsh-workspace-files

> **拥有**：左侧边栏工作区行右侧的文件夹图标、以及覆盖在会话列表上的文件树（DOM 层）。
> **冲突时**：**刻意不注册 `sidebar.workspaces` slot**（官方源码声明该区域归其所有）；DOM 定位只用 `[class*="_projectRow"]` 这类属性子串，不碰 CSS Module hash 前缀。
> **回滚**：删 `dsh-workspace-files` insert + 重启应用。

> Left-sidebar file switch: hover a workspace row, click the icon, and its session list
> becomes a lazy file tree.
>
> 左侧边栏的 **工作区行 → 文件列表** 切换（对标 zcode 的交互）。

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

- 鼠标移到某个**工作区标题行**上 → 行右侧浮出一个**切换图标**
- 点它 → **整个列表区域切换成这个工作区的文件模式**（zcode 同款：会话列表滑出、文件树滑入），不再只是行下方塞一块面板
- 文件模式**顶部有返回按钮**（←），点击或再点行上的切换图标 → 滑回会话列表
- 展开的工作区记在 `localStorage["dsh-workspace-files:open"]`，刷新/重启后自动恢复
- 目录**懒加载**（点开才请求，结果进内存缓存），头部有「重新载入」清缓存重取
- 点文件 → 拼 `dsh-resource://file/session/<id>/<path>` 交给右侧栏打开

### 文件模式（v0.3.0，参考 zcode WorkspaceSidebar 的双视图设计）

- 覆盖层 `absolute inset-0` 挂在**列表滚动容器的父级**上，与 zcode 的两视图叠放同构；
  切换用克制的 **crossfade**（160ms 淡入淡出 + 4px 位移，`prefers-reduced-motion` 时无动画）
  —— 不做整屏大平移：官方滚动容器若自带 transition/裁剪，大位移会被打断出怪动画。
- 列表隐藏用 `visibility:hidden`（延迟到淡出结束），覆盖层**背景透明** —— 透出的永远是
  侧边栏原生底色，不猜任何主题 token，暗/亮主题都不会出现色块。
- 容器定位**不硬编码类名**：从 projectRow 向上找「包含全部行」的共同祖先，再向上找第一个
  `overflow-y: auto/scroll` 的滚动容器；挂载点运行时补 `position:relative + overflow:hidden`。
- 会话行不再逐行隐藏（旧做法 `data-wsf-hidden` 已删）—— 整个列表让位即可，对官方 React 重渲染的干扰更小。
- 列出该工作区文件需要它名下会话的 `cwd`；探测链（sessions store → workspaces store → DOM 挖 id → 当前会话兜底）不变。

### 智能排序（v0.2.0）

同一层级的条目按下面的规则排（目录始终在文件前面）：

1. `序章 / 楔子 / 引子 / 前言…` 开头的排最前；`番外 / 终章 / 尾声 / 后记…` 排最后
2. `第X章|节|回|卷|话|集|部|篇|幕|场` 且 X 为中文数字（一～九、十、百、千、万、两、〇）或阿拉伯数字 → **按章号数值排**：
   `第三章 → 第九章 → 第二十一章 → 第三百零五章`，不再按字符码位把「第三十章」插到「第三章」前面
3. 同章号先比写法（`第3章` < `第03章` < `第三章`），再比章号后的余文；余文恰为 `（上）/（中）/（下）` 等单字时按习惯顺序
4. 其余普通文件排在章节文件之前，互相之间走 numeric 自然序（`file2` < `file10`）

回归测试：`node /tmp/wsf-sort-test.mjs`（从 `lib/client.js` 截取真实实现跑 16 项断言）；
文件模式编排：`node /tmp/wsf-overlay-test.mjs`（stub DOM 跑真 client.js，11 项断言：注入/滑出标记/挂载位置/恢复/卸载）。

只动左侧对话栏。

## 安装

两种装法任选其一（都会往 profile 的 `dependencies` 加一项，再配一行 insert）：

```bash
# ① npm（快，走 registry）
dsh plugin --profile <profile> add @jipika/dsh-workspace-files

# ② GitHub（源码直装，跟随 main 分支）
dsh plugin --profile <profile> add github:jipika/dsh-workspace-files
```

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- insert:
    - id: workspace-files
      name: @jipika/dsh-workspace-files
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
