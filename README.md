<div align="center">
  <img src="assets/icon.svg" width="72" alt="dsh-workspace-files icon">
</div>

# dsh-workspace-files

> **拥有**：左侧边栏工作区行右侧的文件夹图标、覆盖在会话列表上的文件树（DOM 层）、
> 以及树上的**右键菜单**与其 host 路由（`/dsh-workspace-files/fs`）。
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
- 目录**懒加载**（点开才请求）+ **热更新**：文件模式下每 3 秒静默重列「已展开的目录」，
  新建 / 删除 / 改名最长 3 秒就会出现在树里；标签页不可见时暂停，回到前台立即刷一次；
  头部「刷新」按钮 = 立刻重取（只清这个会话的缓存，别的会话不受牵连）
- 点文件 → 拼 `dsh-resource://file/session/<id>/<path>` 交给右侧栏打开

### 文件模式（v0.3.0 双视图叠放；v0.4.0 热更新 + 视觉打磨）

- 覆盖层 `absolute inset-0` 挂在**列表滚动容器的父级**上，与 zcode 的两视图叠放同构；
  切换动画 = **180ms 轻推入/轻滑出**（覆盖层从右 10px 推入，被盖住的列表向左滑出；退出反向，
  动画播完才拆 DOM），`prefers-reduced-motion: reduce` 时全部瞬时。
- 列表隐藏用 `visibility:hidden`（延迟到动画结束），覆盖层**背景透明** —— 透出的永远是
  侧边栏原生底色，不猜任何主题 token，暗/亮主题都不会出现色块。
- 容器定位**不硬编码类名**：从 projectRow 向上找「包含全部行」的共同祖先，再向上找第一个
  `overflow-y: auto/scroll` 的滚动容器；挂载点运行时补 `position:relative + overflow:hidden`。
- 会话行不再逐行隐藏（旧做法 `data-wsf-hidden` 已删）—— 整个列表让位即可，对官方 React 重渲染的干扰更小。
- 列出该工作区文件需要它名下会话的 `cwd`；探测链（sessions store → workspaces store → DOM 挖 id → 当前会话兜底）不变。

#### 列对齐（v0.4.0，实测口径）

行的三列由 CSS 变量驱动，不再写死层级：`padding-left = calc(6px + var(--wsf-depth) * 20px)`，
其中 **20px = 图标宽 14 + 列间距 6**，于是第 N 级的 chevron 正好落在第 N-1 级 folder 的那一列。
**文件行第一列补一个不可见的占位图标**（`.dsh-wsf-ico-empty`）—— 没有它时文件名比目录名左移 20px。

头部：**三格与行结构同构** —— `左内边距 2 + 返回按钮 22 + 间距 2 + 工作区文件夹图标 14 + 间距 6 = 46`，
标题因此仍落在名称列上。中间那个**工作区文件夹图标是 2026-10-08 补的**：早先这里只留空 22px（纯粹为了
让标题对齐名称列），但下面每个目录在该列都有个蓝色文件夹图标、头部却是空的 —— 看上去就是
「返回箭头离标题莫名其妙很远」。补上图标后：返回箭头 ↔ chevron、文件夹图标 ↔ folder、标题 ↔ 名字。
返回箭头用的是 **chevron 的水平镜像 path**（墨迹区间同为 `x∈[6,10]`）—— 早先它是另一条 path
（`M11.5 4.5 7 9l4.5 4.5`）配 15px 盒，墨迹中心比 chevron 偏右约 2.4px，肉眼就是"没对齐"。
实测（相对覆盖层左边缘）：返回按钮 `2–24`、头部文件夹图标 `26–40`、标题 `46`；
行内 chevron `6–20`、folder `26–40`、名字 `46` —— 三列差值全为 0。
返回按钮也从 40×24 收到 22×22 —— hover 时不再是一大块灰底。

#### 热更新（v0.4.0）

- `listDir(sessionId, path, signal, { force })`：缓存带 1.2s TTL，`force` 绕过缓存；
  文件模式下 `tick` 每 3 秒 +1，驱动**整棵已展开的树**重新列目录。
- 内容没实质变化（同名同类型）时不 `setState` —— 不闪、不跳、不丢展开状态与滚动位置。
- 连续失败 3 次的目录会在本轮轮询里跳过（坏路径不会每 3 秒打一次网关）；
  `visibilitychange` / 窗口 focus 时立即刷一次。

### 右键菜单（v0.5.0）

树里每一行、以及树的空白处都能右键。菜单是**官方 primitives 的 `Menu`**（门户渲染到 `body`、
跟随鼠标坐标弹出、子菜单与危险行走官方样式），不是自绘列表 —— 顺带白拿键盘走查与焦点归还。

| 目标 | 菜单项 |
| --- | --- |
| 文件行 | 在右侧栏预览 · 用默认应用打开 · **打开方式 ▸**（系统已注册应用，带图标与默认标记）· 在访达中显示 · 在终端中打开（所在目录）· 复制绝对路径 / 相对路径 / 文件名 · 重命名… · 移到废纸篓 |
| 目录行 | 在访达中打开 · 在终端中打开 · **新建文件… / 新建文件夹…** · 复制绝对路径 / 相对路径 / 名称 · 重命名… · 移到废纸篓 |
| 空白处 | 在访达中显示工作区 · 在终端中打开 · 新建文件… / 新建文件夹… · 复制工作区绝对路径 / 名称 |

- **访达 / 默认应用 / 打开方式走官方 Remote**：`session.openWorkspacePath`（`{path}` 打开、`{path, action:"reveal"}` 在访达中显示、`{path, application}` 指定应用）+ `session.workspacePathApplications`。树里存的是相对路径，发出去前用会话 cwd 拼成**宿主绝对路径**。
- **删除 = 移到系统废纸篓**（`~/.Trash`，Finder 里可恢复），同名自动避让成 `name 2.ext`；跨卷时明确报错而不是悄悄退化成正删。
- **重命名是行内编辑**（Enter 提交 / Esc 取消 / 失焦提交）；编辑态的行会从 `<button>` 换成 `<div>` —— `button` 里嵌 `input` 是非法 HTML，键盘事件会被吞掉。
- **新建走顶部输入条**（回车创建、Esc 或失焦取消）：不依赖目标目录是否已展开，创建后 force 重列即可见。
- 写操作完成后**立刻**刷新整棵已展开的树（不等 3 秒轮询），并在树顶闪一条结果提示；**复制被系统拒绝时**，提示条里附一个只读输入框（自动选中），⌘C 就能手动拿走。
- `Escape` 关闭菜单、点击别处关闭、`prefers-reduced-motion` 下不额外做动效（菜单动画归官方组件）。

#### 删除 / 重命名 / 新建为什么需要 host 半边（v0.5.0 新增）

官方**没有**任何文件写能力，三条都核过源码：`workspaceFiles` 服务自述 “exposes no mutations”；
client 可见的 Remote 命名空间里没有 fs 写接口；Electron preload 只暴露 browser / keyboard /
shortcuts / updates，连 `shell.trashItem` 都没有。所以这三类动作由插件**自己的 host 路由**承担：

```
GET  /dsh-workspace-files/health   → { ok, actions, roots, trash }      （诊断用）
POST /dsh-workspace-files/fs       → { action, path?, dir?, name? }
     action = trash | rename | newFile | newDir | openTerminal
```

三层安全边界（都在离线回归里）：目标必须落在**某个已注册工作区**之下（两侧都做 realpath 归一，
符号链接不会误判）；根目录 / 主目录 / `~/.Trash` 自身与工作区根目录本身一律拒绝；
名字必须是纯名字（无分隔符、无 `..`、无 NUL、非空、≤255），且**已存在就拒绝，绝不覆盖**。

> ⚠️ **改 host 半边必须完全重启 DSH 应用**（刷新页面不够 —— client 半边走 stat-poll 热读，
> host 半边是启动时装配的）。重启后 `curl -s :19387/dsh-workspace-files/health` 返回 ok 即生效；
> 路由没活时点这些菜单项会明确提示「host 路由还没生效（HTTP 405）—— 要完全重启」。

### 智能排序（v0.2.0）

同一层级的条目按下面的规则排（目录始终在文件前面）：

1. `序章 / 楔子 / 引子 / 前言…` 开头的排最前；`番外 / 终章 / 尾声 / 后记…` 排最后
2. `第X章|节|回|卷|话|集|部|篇|幕|场` 且 X 为中文数字（一～九、十、百、千、万、两、〇）或阿拉伯数字 → **按章号数值排**：
   `第三章 → 第九章 → 第二十一章 → 第三百零五章`，不再按字符码位把「第三十章」插到「第三章」前面
3. 同章号先比写法（`第3章` < `第03章` < `第三章`），再比章号后的余文；余文恰为 `（上）/（中）/（下）` 等单字时按习惯顺序
4. 其余普通文件排在章节文件之前，互相之间走 numeric 自然序（`file2` < `file10`）

回归测试（都离线）：

```bash
node tests/client-regression.mjs   # 61 项：结构断言 + 截真实现跑排序/路径/菜单
node tests/host-actions.mjs        # 25 项：host 侧在临时目录里真建/改/移文件 + 拒绝矩阵
```

`host-actions.mjs` 用的是临时沙盒与**可注入的假 home**（`trashPath(target, home)`），
不会碰任何真实工作区，也不会往真实废纸篓里丢东西。

历史脚本手法（`/tmp/wsf-*.mjs`）已并进这两个文件，不必再依赖 /tmp。

### 「侧栏一块深一块浅」不是我干的（2026-10-08 实测结论）

侧栏各区域的底色差异来自**官方自己的 macOS 材质**，与任何插件无关：

```css
/* @deepseek-ai/dsh-client-ui-layout/AppFrame.module.css */
[data-platform="darwin"] ._sidebarCol {
  background:
    linear-gradient(to bottom, #7a9bf01a, #7a9bf000 35%, #8f89b800 68%, #8f89b817),
    color-mix(in srgb, color-mix(in srgb, var(--dsw-specific-sidebar-fill) 97%, #7a9bf0) 40%, transparent);
}
```

40% 不透明的混色 + 上下两段蓝/紫渐变 ⇒ 侧栏「上偏蓝、中近中性、下偏紫」，
只在 `data-platform="darwin"` 生效（CLI/web 实例看不到，容易误判成插件 bug）。
把「背景色」调成浅色（例如 `#F8F8F8`）会让这层差色更明显。
想拉平它：在系统里开「辅助功能 → 显示 → 减少透明度」（官方 `prefers-reduced-transparency`
分支会把侧栏改成 90% 纯色），或自行覆盖 `[data-platform="darwin"] ._sidebarCol` 的 background。

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
**改 `lib/client.js` 后刷新页面即生效**（宿住对 client bundle 做 stat-poll，按内容算 rev）——
只有「增删 client 半边 / 改 host 半边」才需要重启应用。

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
| 右键菜单 | 官方 `@deepseek-ai/dsh-client-ui-primitives` 的 `Menu`（`portal` + `getAnchorRect` 从鼠标坐标弹出）；访达 / 打开方式走 `remote.session.openWorkspacePath` / `workspacePathApplications` |
| 写操作 | 插件自己的 host 路由 `POST /dsh-workspace-files/fs`（官方零 fs 写能力，见上文）；host 侧用 `node:fs/promises`，删除走 `~/.Trash` |
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
{ openKey, lastMenuAction, hostRoute, workspacesSeen, sessionsSeen, projectRows, sessionRows, overlay, services, remote, sample, sessionSample }
```

- `projectRows` 为 0 → DOM 选择器没匹配上（官方类名规则变了）
- `workspacesSeen` 为 0 → `ctx.get("workspaces")` 没取到数据：看返回里的 `services.workspaces` 字段（`"缺失"` 表示服务名变了，否则列出的是取到的成员名）
- 面板里显示「拿不到该工作区的 session」→ workspace 记录里没有可用的 session id（`sample` 里能看到实际形状）
- `lastMenuAction` → 最近一次右键菜单动作（`{ id, kind, rel, at }`），右键没反应时先看它是否更新
- `hostRoute` → 写操作路由地址；配合 `curl -s :19387/dsh-workspace-files/health` 判断 host 半边有没有加载

插件还会在发生变化时写一条 `dsh-workspace-files:diag` 记录，便于回看。

## 已知限制

- 靠 DOM 挖掘与内部服务形状适配，官方侧边栏结构变化后需要跟改（自诊断函数就是为这个准备的）。
- 需要 `exports.inject = ["remote.workspaceFiles", "remote.session"]`：cordis 会拦截未声明的服务，
  少任何一个都会报 `cannot get property "remote.…" without inject`。
- 会话与工作目录必须成对取自同一条 session 记录 —— 用 A 会话的 id 配 B 会话的路径，
  网关会判 `bad-request`（甚至越权读别的目录），所以 `rootFor()` 里刻意不混用。
- **删除 / 重命名 / 新建 / 在终端中打开改的是 host 半边**，改完要**完全重启应用**；
  这些动作同样受「只允许在工作区内」的边界约束（想操作工作区外的文件请走 Finder）。
- 废纸篓只支持**同卷**（macOS 的系统限制）：目标与 `~/.Trash` 不同卷时直接报错并保持文件原样。
- 「在终端中打开」目前固定用系统自带的 `Terminal.app`（要换 iTerm/Warp 改 `lib/index.js` 的 `openTerminal`）。

## License

MIT © 2026 jipika
