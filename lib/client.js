// dsh-workspace-files — browser half（本地插件）
//
// 需求（对标 zcode）：鼠标移到左侧边栏的**工作区标题行**上 → 出现一个图标 →
// 点击 → 该工作区下面的**会话列表**切换成**文件列表**；再点切回。
//
// 实现要点：
//   1. 挂载点：`sidebar.workspaces` slot 里注册一个 **renderless 探针组件**，
//      只为白拿宿主注入的 `useWorkspaces` / `useSessions` keyed hook（官方
//      WorkspaceBrowser 就是这么拿数据的），把 workspace→session 映射缓存到
//      模块状态，供 DOM 层使用。
//   2. DOM 定位**不硬编码 CSS Module 的 hash 前缀**：用属性子串选择器
//      `[class*="_projectRow"]` / `[class*="_sessionRow"]` —— hash 会随版本变，
//      但 `_projectRow` 这个后缀名不会（官方 Rows.module.css 的类名）。
//   3. 工作区与会话的归属关系用 **TreeWalker 按文档顺序**推断（遇到下一个
//      projectRow 之前的所有 sessionRow 都归它），不依赖具体嵌套层级 ——
//      因为拿不到真实 DOM，这样最抗结构变化。
//   4. 文件数据走官方 Remote：`remote.workspaceFiles.list(sessionId, path, signal)`
//      → `{ ok, value: { entries: [{ name, type }], truncated } }`，path 是
//      **工作区相对路径**（根目录传空串），与官方右侧文件树同一套契约。
//   5. 展开状态存 localStorage 并跨刷新恢复；目录列表带 1.2s TTL 缓存 + 3s 静默热更新。
//
// 改本文件后**刷新页面即生效** —— 宿主对 client bundle 做 stat-poll 并按内容算 rev；
// 只有「新增/删除 client 半边、改 host 半边」才需要重启应用。
// 离线回归：`node tests/client-regression.mjs`（24 项）。

window.__ModuleLoader__.load({
	id: "@jipika/dsh-workspace-files",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const ReactDOMClient = require("react-dom/client");
		/**
		 * 官方 primitives 的 `Menu`：门户渲染（portal 到 body，不被侧栏 overflow 裁）、
		 * 任意锚点矩形（`getAnchorRect` → 右键坐标）、子菜单（打开方式 ▸）、
		 * 危险行（danger → 错误色 + 红底 hover）、键盘走查与焦点归还全由官方组件实现。
		 * 自绘 ul 的话这些都要重做一遍，且样式会与官方菜单漂移。
		 */
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		/**
		 * 取不到就降级成「不弹菜单」（并在界面上说明），绝不因为一个组件缺失把整棵树带崩 ——
		 * 宿主对 client 模块的导出面随版本变化过（旧的 icon 改名就是一例）。
		 */
		const Menu = typeof primitives.Menu === "function" ? primitives.Menu : null;
		const h = React.createElement;

		/* ───────────────────────── 常量 ───────────────────────── */
		const STYLE_ID = "dsh-workspace-files-style";
		const OPEN_KEY = "dsh-workspace-files:open"; // 当前展开文件树的工作区 key
		const ROW_SEL = '[class*="_projectRow"]'; // 工作区标题行
		const SESSION_SEL = '[class*="_sessionRow"]'; // 会话行
		const BTN_MARK = "data-wsf-btn";
		const OVERLAY_MARK = "data-wsf-overlay"; // 文件模式覆盖层标记
		const PARKED_MARK = "data-wsf-parked"; // 文件模式下被滑出的列表滚动容器
		const SHELL_MARK = "data-wsf-shell"; // 覆盖层挂载点（需要 position:relative + overflow:hidden）
		const ROOT_PATH = ""; // 工作区相对路径的根
		/** 本插件 host 半边的路由（删除/重命名/新建/在终端打开 —— 官方 workspaceFiles 是只读的）。 */
		const FS_ROUTE = "/dsh-workspace-files/fs";
		/** 菜单挂载行的类名：`display:contents` 让官方 Menu 的 anchor 外壳不参与 flex 布局。 */
		const MENU_ANCHOR_CLASS = "dsh-wsf-menu-anchor";
		/** 「打开方式」子菜单的应用列表查询超时（拿不到就只留「用默认应用打开」）。 */
		const APPS_TIMEOUT_MS = 6000;
		/** 操作结果提示的停留时长。 */
		const NOTICE_MS = 2600;
		/** 列目录超时：Remote 挂着不返回时，宁可报错也别永远停在「载入中」。 */
		const LIST_TIMEOUT_MS = 8000;
		/** 目录缓存有效期：过期即重取（保证「热更新」不会永远吃旧数据）。 */
		const DIR_CACHE_TTL_MS = 1200;
		/** 文件模式下的静默轮询间隔（只刷已展开的目录，标签页不可见时暂停）。 */
		const REFRESH_INTERVAL_MS = 3000;
		/** 同一目录连续失败几次后，本轮轮询跳过它（避免坏路径每 3 秒打一次网关）。 */
		const REFRESH_FAIL_LIMIT = 3;
		/** 探针开关：只在 localStorage 置 "1" 的那一次刷新里跑一遍背景采样（一次性）。 */
		const PROBE_KEY = "dsh-workspace-files:probe";
		/** 刷新后「记住的工作区行还没渲染出来」的容忍窗口：超过它才认定工作区真的没了。 */
		const OPEN_MISS_GRACE_MS = 8000;
		/** 「还没解析出会话根」时的重试节奏与上限（刷新后服务常晚于插件就绪）。 */
		const RESOLVE_RETRY_BASE_MS = 1500;
		const RESOLVE_RETRY_MAX_MS = 8000;
		const RESOLVE_RETRY_LIMIT = 40;
		const ICON_DIR =
			'M3.5 5.5h4l1.5 2h7.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z';
		const ICON_CHEVRON = "M6 4.5 10 8.5 6 12.5";
		/**
		 * 返回箭头 = 目录行 chevron 的**水平镜像，且保持墨迹区间同为 x∈[6,10]** ——
		 * 两者同一 viewBox/同一尺寸时，墨迹在盒内落点完全一致，于是在头部与行里
		 * 天然同列。早先用 `M11.5 4.5 7 9l4.5 4.5`（墨迹 x∈[7,11.5]）配 15px 盒，
		 * 墨迹中心比 chevron 偏右 ~2.4px，肉眼看得出"没对齐"（2026-10-08 用户截图）。
		 */
		const ICON_CHEVRON_LEFT = "M10 4.5 6 8.5 10 12.5";
		/**
		 * 「会话 ⇄ 文件」两态切换按钮的图标：**文件树**样式（一条主干 + 两个节点分支）。
		 * 用它而不是文件夹，是因为这里切换的是整个列表的视图，不是"打开某个目录"。
		 */
		const ICON_PANEL =
			'<path d="M4.6 3.6v12.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
			'<path d="M4.6 7.1h3.2M4.6 14.2h3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
			'<rect x="8.4" y="5.3" width="7.4" height="3.6" rx="1.1" stroke="currentColor" stroke-width="1.3"/>' +
			'<rect x="8.4" y="12.4" width="7.4" height="3.6" rx="1.1" stroke="currentColor" stroke-width="1.3"/>';

		/* ───────────────────────── 模块状态 ───────────────────────── */
		let ctxRef = null;
		let workspaces = []; // workspaces 服务的 items
		let sessionsById = {}; // sessions store 的 id → 记录
		let currentSessionId = null; // sessions store 里的当前会话 id（最后兜底）
		let openKey = readOpen();

		/**
		 * 运行期诊断写进 localStorage —— Electron 的 localStorage 是**明文 leveldb**，
		 * agent 可以直接从磁盘读它，不必让用户开 DevTools 拷日志。
		 * 键：`dsh-workspace-files:diag`
		 */
		let diagSeq = 0;
		function writeDiag(patch) {
			try {
				const key = "dsh-workspace-files:diag";
				const prev = JSON.parse(window.localStorage.getItem(key) || "{}");
				window.localStorage.setItem(key, JSON.stringify(Object.assign({}, prev, patch, { seq: ++diagSeq, at: new Date().toISOString() })));
			} catch {}
		}
		/** `${sessionId}\0${path}` → `{ value:{entries,truncated}, at }`（带时间戳，供 TTL 判活）。 */
		const dirCache = new Map();
		/** 同上 key → 连续失败次数（达到 REFRESH_FAIL_LIMIT 后本轮轮询跳过）。 */
		const dirFail = new Map();
		/**
		 * key → sessionId 的解析结果缓存。
		 * 关键：DOM 挖掘（扫会话行属性里的长数字）**每次可能给出不同的值**，
		 * 不缓存的话 openPanel 每轮 decorate 都会带着新 sessionId 重新 render，
		 * FileTree 的 effect 就会反复重跑 + abort，永远停在「载入中」。
		 */
		const sessionIdCache = new Map();
		/**
		 * 文件模式覆盖层（单例）：`{ sc, shell, el, root, key, sessionId, renderedKey, renderedSessionId }`。
		 * `sc` = 列表滚动容器（文件模式下整体滑出），`shell` = 覆盖层挂载点（sc 的父级）。
		 * 与 zcode 的双视图叠放同款：覆盖层 absolute inset-0 盖住列表区域，滑动切换。
		 */
		let overlay = null;
		/** 刷新后找不到「记住的工作区」的起始时间戳（0 = 当前能找到）；见 applyOpenState。 */
		let openMissSince = 0;
		/** 「还没解析出会话根」的重试计数与定时器（见 scheduleResolveRetry）。 */
		let resolveAttempts = 0;
		let resolveTimer = 0;
		/** 最近一次右键菜单动作与结果 —— 诊断用（`__dshWorkspaceFiles()` 会回显）。 */
		let lastMenuAction = null;

		/* ───────────────────────── 小工具 ───────────────────────── */
		function readOpen() {
			try {
				return window.localStorage.getItem(OPEN_KEY);
			} catch {
				return null;
			}
		}
		function writeOpen(value) {
			try {
				if (value === null) window.localStorage.removeItem(OPEN_KEY);
				else window.localStorage.setItem(OPEN_KEY, value);
			} catch {}
		}
		/**
		 * 取 Remote 载体。官方 `dsh-client-ui-sidebar-files` / `dsh-client-ui-workspace`
		 * 都是**直接读 `ctx.remote`**，所以这里也优先走属性访问；`ctx.get()` 只作回退
		 * （属性访问在服务未就绪时可能抛错，因此包了 try）。
		 */
		function remote() {
			const ctx = ctxRef;
			if (ctx === null || ctx === undefined) return null;
			try {
				if (ctx.remote !== undefined && ctx.remote !== null) return ctx.remote;
			} catch {}
			try {
				return typeof ctx.get === "function" ? ctx.get("remote") ?? null : null;
			} catch {
				return null;
			}
		}
		function isDir(entry) {
			return entry.type === "directory" || entry.type === "dir" || entry.isDirectory === true;
		}
		function keyOf(row) {
			// 工作区标题文本就是稳定 key（同一侧边栏里不会重名）
			return (row.textContent || "").replace(/\s+/g, " ").trim();
		}
		function waitFrames(n) {
			return new Promise((resolve) => {
				const step = (i) => (i <= 0 ? resolve() : requestAnimationFrame(() => step(i - 1)));
				step(n);
			});
		}

		/* ───────────────────── 右键菜单：路径与宿主通道 ───────────────────── */
		/**
		 * 把工作区根与相对路径拼成**宿主绝对路径**。
		 * 官方 `session.openWorkspacePath` 走 `resolve(path)` 后与 fs 映射核对，
		 * 只接受绝对路径；而树里的每个节点存的是相对路径。
		 * 根里有反斜杠（Windows）时按 `\` 拼 —— macOS 上恒为 `/`。
		 */
		function joinPath(root, rel) {
			const base = String(root === null || root === undefined ? "" : root).replace(/[/\\]+$/, "");
			const tail = String(rel === null || rel === undefined ? "" : rel).replace(/^[/\\]+/, "");
			if (base === "") return tail;
			if (tail === "") return base;
			const sep = base.indexOf("\\") >= 0 && base.indexOf("/") < 0 ? "\\" : "/";
			return base + sep + tail;
		}

		/** 文件/目录的「所在目录」相对路径（根下的条目 → 空串）。 */
		function parentPathOf(rel) {
			const text = String(rel === null || rel === undefined ? "" : rel).replace(/[/\\]+$/, "");
			const cut = text.lastIndexOf("/");
			return cut < 0 ? "" : text.slice(0, cut);
		}

		/** 写剪贴板：Clipboard API 优先，失败退到 textarea + execCommand（旧内核兜底）。 */
		async function copyText(text) {
			const value = String(text);
			try {
				if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
					await navigator.clipboard.writeText(value);
					return true;
				}
			} catch {}
			try {
				const area = document.createElement("textarea");
				area.value = value;
				area.setAttribute("readonly", "");
				area.style.position = "fixed";
				area.style.top = "-1000px";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				const ok = document.execCommand("copy");
				area.remove();
				return ok === true;
			} catch {
				return false;
			}
		}

		/** 从 RemoteResult 里取 value，失败时抛带可读消息的 Error。 */
		function valueOf(result, fallback) {
			if (result && result.ok === true) return result.value;
			const message =
				(result && result.error && (result.error.message || result.error.code)) || fallback || "宿主拒绝了这次操作";
			throw new Error(String(message));
		}

		/** 官方 session Remote 命名空间（`inject` 里声明了 `remote.session`，缺声明会被 cordis 拦截）。 */
		function sessionRemote() {
			const r = remote();
			const ns = r === null || r === undefined ? null : r.session;
			if (ns === null || ns === undefined) throw new Error("宿主未提供 remote.session（该 profile 打不开本地文件）");
			return ns;
		}

		/**
		 * 用系统默认应用打开 / 指定应用打开 / 在文件管理器里显示（官方通道，path 必须是绝对路径）。
		 * `action === "reveal"` 时忽略 `application`（官方语义：`application` 在 reveal 下被忽略）。
		 */
		async function openWorkspacePath(absPath, action, application) {
			const ns = sessionRemote();
			const request =
				action === "reveal"
					? { path: absPath, action: "reveal" }
					: application === undefined || application === ""
						? { path: absPath }
						: { path: absPath, application: String(application) };
			return valueOf(await ns.openWorkspacePath(request), action === "reveal" ? "在访达中显示失败" : "打开失败");
		}

		/** 该文件当前注册的打开方式（拿不到就返回空表 —— 菜单只少一段，不影响其它动作）。 */
		async function fileApplications(absPath) {
			try {
				const ns = sessionRemote();
				const result = await ns.workspacePathApplications({ path: absPath });
				const list = result && result.ok === true ? result.value : null;
				return Array.isArray(list) ? list : [];
			} catch {
				return [];
			}
		}

		/**
		 * 本插件 host 路由：删除/重命名/新建/在终端打开。
		 * 走同源 fetch（本地 GUI 无鉴权网关，与 dsh-memguard / dsh-preset-hotswap 同一手法）。
		 */
		async function fsCall(payload) {
			let response;
			try {
				response = await fetch(FS_ROUTE, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload)
				});
			} catch (error) {
				throw new Error("连不上插件 host 路由（host 半边需重启应用后才生效）：" + String((error && error.message) || error));
			}
			let data = null;
			try {
				data = await response.json();
			} catch {}
			// 宿主对未注册路径回的是 405（不是 404）—— 实测 2026-10-08。两条都当「host 半边没加载」处理，
			// 否则用户看到的只是一句「非 JSON 响应」，查不出真因。
			if (response.status === 404 || response.status === 405) {
				throw new Error("插件 host 路由还没生效（HTTP " + response.status + "）—— 改过 host 半边后要**完全重启** DSH 应用，刷新页面不够");
			}
			if (data === null || typeof data !== "object") throw new Error("host 路由返回了非 JSON 响应（HTTP " + response.status + "）");
			if (data.ok !== true) throw new Error(String(data.error || "操作失败（HTTP " + response.status + "）"));
			return data;
		}

		/* ───────────────────────── 智能排序 ───────────────────────── */
		// 目标：`第三章` / `第3章` / `第二十一章` 这类文件名按**章号数值**排序，
		// 而不是按字符码位（否则「第三十章」会永远排在「第三章」前面）。
		// 规则（同一层级内）：
		//   ① `序章/楔子/引子/前言…` 开头 → 排最前；`番外/终章/尾声/后记…` → 排最后；
		//   ② `第X章|节|回|卷|话|集|部|篇|幕|场` 且 X 是中文/阿拉伯数字 → 按数值排；
		//   ③ 其余普通文件排在章节文件之前，互相之间走 numeric 自然序（file2 < file10）。
		const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
		const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };
		const CHAPTER_RE = /第\s*([0-9]+|[〇零一二两三四五六七八九十百千万]+)\s*[章节回卷幕话集部篇场]/;
		const CHAPTER_BEFORE_RE = /^(序章|楔子|引子|序|前言|开篇|自序)/;
		const CHAPTER_AFTER_RE = /^(终章|尾声|后记|大结局|完结|番外|外传|特别篇)/;
		// 同章号的余文若恰是「上/中/下」「前/后」这类单字（含全半角括号包裹），按习惯顺序排
		// —— 默认 collation 是拼音序（上 shàng < 下 xià < 中 zhōng），不符合直觉。
		const TAIL_ORDER = { 上: 1, 前: 1, 中: 2, 下: 3, 后: 3, 末: 4 };
		function tailKey(text) {
			const t = String(text).replace(/^[（(【\[]+|[）)】\]]+$/g, "").trim();
			return t.length === 1 && t in TAIL_ORDER ? TAIL_ORDER[t] : null;
		}

		/** 中文数字串（可混阿拉伯数字）→ 数值；解析不了返回 null。 */
		function parseCnNumber(text) {
			const s = String(text).trim();
			if (s === "") return null;
			if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
			if (!/^[〇零一二两三四五六七八九十百千万]+$/.test(s)) return null;
			let total = 0; // 已封口的整组（万/亿 结算）
			let current = 0; // 当前组内已乘单位的累计
			let digit = null; // 最近一个待乘单位的数字；null = 没有
			for (const ch of s) {
				if (ch >= "0" && ch <= "9") {
					digit = (digit === null ? 0 : digit) * 10 + (ch.charCodeAt(0) - 48);
					continue;
				}
				if (ch in CN_DIGITS) {
					digit = CN_DIGITS[ch];
					continue;
				}
				if (ch in CN_UNITS) {
					current += (digit === null ? 1 : digit) * CN_UNITS[ch];
					digit = null;
					continue;
				}
				if (ch === "万" || ch === "亿") {
					total = (total + current + (digit === null ? 0 : digit)) * (ch === "万" ? 10000 : 100000000);
					current = 0;
					digit = null;
					continue;
				}
				return null;
			}
			return total + current + (digit === null ? 0 : digit);
		}

		/**
		 * 文件名 → 排序键。
		 * `group: -1` 序章类（最前）、`1` 番外类（最后）、`0` 正常；
		 * `kind: "chapter"` 表示解析出了章号（num），否则按普通名处理。
		 */
		function chapterKeyOf(name) {
			const stem = String(name).replace(/\.[^.\\/]*$/, ""); // 展示名去掉扩展名再解析
			if (CHAPTER_BEFORE_RE.test(stem)) return { group: -1, kind: "plain", stem };
			if (CHAPTER_AFTER_RE.test(stem)) return { group: 1, kind: "plain", stem };
			const m = CHAPTER_RE.exec(stem);
			if (m !== null) {
				const num = parseCnNumber(m[1]);
				if (num !== null) return { group: 0, kind: "chapter", num, numText: m[1], rest: stem.slice(m.index + m[0].length), stem };
			}
			return { group: 0, kind: "plain", stem };
		}

		/** 智能比较两个文件名（不含目录/文件分层，那层由 sortEntries 处理）。 */
		function smartCompareNames(a, b) {
			const ka = chapterKeyOf(a);
			const kb = chapterKeyOf(b);
			if (ka.group !== kb.group) return ka.group - kb.group;
			if (ka.kind === "chapter" && kb.kind === "chapter") {
				if (ka.num !== kb.num) return ka.num - kb.num;
				// 同一章号：先比写法（"3" vs "03" vs "三"），再比章号后的余文（上/中/下…）
				if (ka.numText !== kb.numText) return String(ka.numText).localeCompare(String(kb.numText), undefined, { numeric: true });
				if (ka.rest !== kb.rest) {
					const ta = tailKey(ka.rest);
					const tb = tailKey(kb.rest);
					if (ta !== null && tb !== null && ta !== tb) return ta - tb;
					return String(ka.rest).localeCompare(String(kb.rest), undefined, { numeric: true });
				}
				return 0;
			}
			// 章节 vs 普通：普通在前；普通 vs 普通：numeric 自然序
			if (ka.kind !== kb.kind) return ka.kind === "chapter" ? 1 : -1;
			return String(ka.stem).localeCompare(String(kb.stem), undefined, { numeric: true });
		}

		/** 目录优先，同层内走智能排序。 */
		function sortEntries(entries) {
			return entries.slice().sort((a, b) => (isDir(b) ? 1 : 0) - (isDir(a) ? 1 : 0) || smartCompareNames(a.name, b.name));
		}

		/* ───────────────────────── 数据层 ───────────────────────── */
		/**
		 * 列目录。
		 * `opts.force === true` 时**绕过缓存**（热更新轮询走这条）；否则命中 1.2s 内的缓存直接返回。
		 * 失败会计入 `dirFail`（供轮询退避），成功即清零。
		 */
		async function listDir(sessionId, path, signal, opts) {
			const force = !!(opts && opts.force);
			const cacheKey = sessionId + "\u0000" + path;
			if (!force) {
				const hit = dirCache.get(cacheKey);
				if (hit !== undefined && Date.now() - hit.at < DIR_CACHE_TTL_MS) return hit.value;
			}
			if (force && (dirFail.get(cacheKey) ?? 0) >= REFRESH_FAIL_LIMIT) throw new Error("该目录连续列取失败，本轮跳过（下一次刷新会重试）");
			let r = null;
			let ws = null;
			try {
				r = remote();
				ws = r === null ? null : r.workspaceFiles;
			} catch (error) {
				// 访问 ctx.remote / ctx.remote.workspaceFiles 本身抛错（cordis 的 inject 拦截）——
				// 这条路径以前不写诊断，所以「没调用 list」时看不出原因。
				writeDiag({ listGuardThrow: String((error && error.message) || error).slice(0, 140) });
				throw error;
			}
			if (ws === null || ws === undefined || typeof ws.list !== "function") {
				writeDiag({
					listGuardFail: {
						hasRemote: r !== null,
						remoteKeys: r === null ? null : Object.keys(r).slice(0, 10),
						wsType: typeof ws
					}
				});
				throw new Error("宿主未提供 remote.workspaceFiles（该 profile 可能没装 workspace-files 能力）");
			}
			const tag = String(sessionId).slice(0, 12);
			console.info("[dsh-workspace-files] list →", { sessionId: tag, path: JSON.stringify(path), force });
			let timer = null;
			const timeout = new Promise((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("列目录超时（" + LIST_TIMEOUT_MS + "ms 无响应）—— sessionId=" + tag + " path=" + JSON.stringify(path))),
					LIST_TIMEOUT_MS
				);
			});
			const noteFail = () => {
				const next = (dirFail.get(cacheKey) ?? 0) + 1;
				dirFail.set(cacheKey, next);
				return next;
			};
			try {
				const res = await Promise.race([ws.list(sessionId, path, signal), timeout]);
				if (!res || res.ok !== true) {
					const message = (res && res.error && res.error.message) || "列目录失败：" + JSON.stringify(res && res.error);
					console.warn("[dsh-workspace-files] list ← 失败", res);
					writeDiag({ listFail: { sessionId: tag, path, error: (res && res.error) || String(res) } });
					throw new Error(message);
				}
				const value = {
					entries: (res.value && res.value.entries) || [],
					truncated: !!(res.value && res.value.truncated)
				};
				console.info("[dsh-workspace-files] list ← 成功:", value.entries.length, "条" + (value.truncated ? "（已截断）" : ""));
				dirFail.delete(cacheKey);
				dirCache.set(cacheKey, { value, at: Date.now() });
				return value;
			} catch (error) {
				// 失败计数：连续 REFRESH_FAIL_LIMIT 次后，轮询会跳过这个目录（避免持续打网关）
				noteFail();
				throw error;
			} finally {
				if (timer !== null) clearTimeout(timer);
			}
		}

		/** 丢掉某个会话的全部缓存（只影响它，别的会话不受牵连）。 */
		function invalidateSession(sessionId) {
			const prefix = sessionId + "\u0000";
			for (const key of [...dirCache.keys()]) if (key.startsWith(prefix)) dirCache.delete(key);
			for (const key of [...dirFail.keys()]) if (key.startsWith(prefix)) dirFail.delete(key);
		}

		/**
		 * 目录内容是否**实质未变**（只看名字与类型，顺序无关）——
		 * 轮询拿到的数据一样时就不 setState，避免整棵树每 3 秒重渲染/闪一下。
		 */
		function sameEntries(a, b) {
			if (a === b) return true;
			if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
			const keyOf = (list) =>
				list
					.map((entry) => (isDir(entry) ? "d:" : "f:") + String(entry && entry.name))
					.sort()
					.join("\u0001");
			return keyOf(a) === keyOf(b);
		}

		/** 从一个 workspace 记录里挖出 session id 候选。 */
		function sessionCandidatesOf(item) {
			if (!item || typeof item !== "object") return [];
			const buckets = [item.sessions, item.sessionIds, item.children, item.sessionList];
			const out = [];
			for (const bucket of buckets) {
				if (!Array.isArray(bucket)) continue;
				for (const entry of bucket) {
					if (typeof entry === "string") out.push(entry);
					else if (entry && typeof entry === "object") {
						if (typeof entry.id === "string") out.push(entry.id);
						else if (typeof entry.sessionId === "string") out.push(entry.sessionId);
					}
				}
			}
			return out;
		}

		/** 按工作区标题找它的 session id；找不到就全局兜底。 */
		/**
		 * 确保模块变量里有数据 —— **用之前即时补一次**。
		 * 实测：`adopt` 那次取数发生在数据就绪之前，而 sessions/workspaces 这两个服务
		 * 没有可用的 subscribe（订阅回调从不触发），所以模块变量会一直是空的；
		 * 但同一条取数逻辑在"用的时候"跑就能拿到（面板上的「实时服务: 18 工作区 / 933 会话」
		 * 就是证据）。所以这里改成惰性补取，不再依赖首次 assign 的时序。
		 */
		/**
		 * `sessionsById` 里是否**至少有一条带工作目录**的记录。
		 * 实测（2026-10-08 刷新后）：会话 store 是**分批落地**的 —— 先到 12 条只有
		 * `id/displayTitle/parentId/origin/running/blank/updatedAt/retainedBy` 的"壳"，
		 * 过一会儿才是 848 条含 `cwd` 的完整记录。只看"表非空"会把那一批壳当成就绪，
		 * 于是再也取不到 cwd（「拿不到该会话的工作目录」的第三种成因）。
		 */
		function hasCwdRecord() {
			for (const record of Object.values(sessionsById)) {
				if (record === null || typeof record !== "object") continue;
				for (const key of ["cwd", "workspacePath", "workspaceRoot", "root", "path", "directory"]) {
					const value = record[key];
					if (typeof value === "string" && value !== "") return true;
				}
			}
			return false;
		}

		function ensureData(force) {
			if (workspaces.length > 0 && Object.keys(sessionsById).length > 0 && hasCwdRecord() && force !== true) return;
			try {
				const wsService = ctxRef && typeof ctxRef.get === "function" ? ctxRef.get("workspaces") : undefined;
				const ssService = ctxRef && typeof ctxRef.get === "function" ? ctxRef.get("sessions") : undefined;
				if (workspaces.length === 0 || force === true) {
					const items = itemsOf(snapshotOf(wsService && wsService.list));
					if (items.length > 0) workspaces = items;
				}
				if (Object.keys(sessionsById).length === 0 || !hasCwdRecord() || force === true) {
					const records = sessionRecordsOf(snapshotOf(ssService && ssService.list));
					// 只在**拿到东西**时才覆盖：分批加载的早期快照可能比手里这份更小
					if (Object.keys(records).length > Object.keys(sessionsById).length || Object.keys(sessionsById).length === 0) sessionsById = records;
				}
				const current = currentIdOf(snapshotOf(ssService));
				if (current !== null) currentSessionId = current;
				writeDiag({ ensureData: { workspaces: workspaces.length, sessions: Object.keys(sessionsById).length, hasCwd: hasCwdRecord(), force: force === true } });
			} catch (error) {
				writeDiag({ ensureDataError: String((error && error.message) || error).slice(0, 100) });
			}
		}
		function sessionIdForKey(key, row) {
			ensureData();
			// ① 先从 sessions store 反向匹配：session 记录里往往带着 workspace 归属，
			//    这比从 workspace 记录里猜 session 列表字段可靠得多。
			for (const [id, record] of Object.entries(sessionsById)) {
				if (!record || typeof record !== "object") continue;
				const ref = record.workspaceId ?? record.workspace ?? record.projectId ?? record.project ?? record.workspaceName;
				const name =
					typeof ref === "string" ? ref : ref && typeof ref === "object" ? ref.name ?? ref.id ?? ref.path ?? ref.root : undefined;
				if (typeof name !== "string") continue;
				const normalized = name.replace(/\\/g, "/");
				if (normalized === key || normalized.endsWith("/" + key) || normalized.split("/").pop() === key) return id;
			}
			const namesOf = (item) =>
				[item.name, item.title, item.label, item.path, item.root, item.cwd, item.id]
					.filter((v) => typeof v === "string")
					.map((v) => v.replace(/\\/g, "/"));
			for (const item of workspaces) {
				const names = namesOf(item);
				const hit = names.some((n) => n === key || n.endsWith("/" + key) || n.split("/").pop() === key);
				if (!hit) continue;
				const candidates = sessionCandidatesOf(item);
				if (candidates.length > 0) return candidates[0];
			}
			// ③ workspaces 记录里再找一遍候选（不限名字匹配）
			for (const item of workspaces) {
				const candidates = sessionCandidatesOf(item);
				if (candidates.length > 0) return candidates[0];
			}
			// ④ sessions store 里任意一条
			const first = Object.keys(sessionsById)[0];
			if (typeof first === "string") return first;
			// ④′ 从 DOM 挖：官方会话行是 React 渲的、没有稳定的 data 属性保证，
			//     所以扫会话行（及一层后代）的属性值，找 UUID / 长十六进制串。
			const fromDom = sessionIdFromDom();
			if (typeof fromDom === "string" && fromDom !== "") {
				writeDiag({ sessionFromDom: fromDom });
				return fromDom;
			}
			// ④″ 从 sessions 服务的操作面挖（它的数据面不在服务对象本身）
			try {
				const service = ctxRef && ctxRef.get ? ctxRef.get("sessions") : undefined;
				const ids = collectSessionIds(service);
				writeDiag({ sessionIdsFromService: ids.slice(0, 3), sessionIdCount: ids.length });
				if (ids.length > 0) return ids[0];
			} catch (error) {
				writeDiag({ sessionFromServiceError: String((error && error.message) || error).slice(0, 100) });
			}
			// ⑤ 最后兜底：当前会话 —— 可能不属于这个工作区，但至少让面板可用
			writeDiag({
				sessionMissingForKey: key,
				workspacesSeen: workspaces.length,
				sessionsSeen: Object.keys(sessionsById).length,
				currentSessionId,
				workspaceSample: workspaces.slice(0, 2),
				firstSessionKeys: (() => {
					const rec = Object.values(sessionsById)[0];
					return rec && typeof rec === "object" ? Object.keys(rec).slice(0, 24) : null;
				})()
			});
			return currentSessionId;
		}

		/**
		 * 面板用的诊断串 —— 直接画在界面上，用户截一张图就能把断点定位到具体环节，
		 * 不必去开 DevTools 拷日志。
		 */
		function diagnose() {
			const lines = ["拿不到该工作区的 session（无法确定目录根）"];
			try {
				const r = remote();
				const ns = r === null ? null : r.workspaceFiles;
				lines.push("remote: " + (r === null ? "缺失" : ns === undefined || ns === null ? "无 workspaceFiles" : "list=" + typeof ns.list));
			} catch (error) {
				lines.push("remote: 异常 " + String(error && error.message));
			}
			lines.push("workspaces: " + workspaces.length + " | sessions: " + Object.keys(sessionsById).length);
			// ↓ 实时探测：绕开模块变量，直接问服务此刻有什么。
			//   模块变量为空但这里非空 ⇒ 是取数回调没把数据写进来（时序/订阅）。
			//   这里也为空 ⇒ 服务此刻真的没数据（或 .list 那一层不是我以为的形状）。
			try {
				const wsSvc = ctxRef && typeof ctxRef.get === "function" ? ctxRef.get("workspaces") : undefined;
				const ssSvc = ctxRef && typeof ctxRef.get === "function" ? ctxRef.get("sessions") : undefined;
				const liveWs = itemsOf(snapshotOf(wsSvc && wsSvc.list)).length;
				const liveSs = Object.keys(sessionRecordsOf(snapshotOf(ssSvc && ssSvc.list))).length;
				lines.push("实时服务: " + liveWs + " 工作区 / " + liveSs + " 会话" + (wsSvc === undefined ? " · workspaces 服务缺失" : "") + (ssSvc === undefined ? " · sessions 服务缺失" : ""));
			} catch (error) {
				lines.push("实时服务: 探测异常 " + String((error && error.message) || error).slice(0, 70));
			}
			lines.push("current: " + (currentSessionId === null ? "—" : String(currentSessionId).slice(0, 12)));
			try {
				const service = ctxRef && ctxRef.get ? ctxRef.get("sessions") : undefined;
				if (service === undefined) lines.push("sessions 服务: 缺失");
				else {
					const snap = snapshotOf(service);
					lines.push("sessions 服务: " + (snap && typeof snap === "object" ? Object.keys(snap).slice(0, 8).join(",") : typeof snap));
				}
			} catch (error) {
				lines.push("sessions 服务: 异常");
			}
			const firstSession = Object.values(sessionsById)[0];
			if (firstSession && typeof firstSession === "object") lines.push("session 字段: " + Object.keys(firstSession).slice(0, 12).join(","));
			if (workspaces[0] && typeof workspaces[0] === "object") lines.push("workspace 字段: " + Object.keys(workspaces[0]).slice(0, 12).join(","));
			if (Object.keys(sessionsById).length === 0 && workspaces.length === 0) {
				lines.push("→ 两个服务都没数据：插件可能是在服务注册之前 apply 的，或服务名变了");
			}
			return lines.join("\n");
		}

		/**
		 * 取某个 session 的工作目录（cwd）。
		 * **关键**：官方注释写明 `workspaceFiles.list(sessionId, parent)` 的 parent 是
		 * 「被列目录的**绝对路径**」（`childPath(parent, name)` 就是 `parent + "/" + name`），
		 * 传空串会被网关判为 `gateway/bad-request`。
		 */
		function rootFor(sessionId) {
			const pickCwd = (record) => {
				if (!record || typeof record !== "object") return null;
				for (const key of ["cwd", "workspacePath", "workspaceRoot", "root", "path", "directory"]) {
					const value = record[key];
					if (typeof value === "string" && value !== "") return value;
				}
				return null;
			};
			// ⚠️ sessionId 与 cwd 必须**成对**取自同一条记录 —— 用 A 会话的 id 配 B 会话的路径，
			// 网关同样会判 bad-request（甚至越权读别的目录）。
			const own = pickCwd(sessionsById[sessionId]);
			if (own !== null) return { sessionId, root: own };
			for (const [id, record] of Object.entries(sessionsById)) {
				const cwd = pickCwd(record);
				if (cwd !== null) {
					writeDiag({ rootFallback: { asked: sessionId, using: id, root: cwd } });
					return { sessionId: id, root: cwd };
				}
			}
			return { sessionId, root: null };
		}
		function collectSessionIds(service) {
			if (service === null || service === undefined || typeof service !== "object") return [];
			const ids = [];
			const take = (value) => {
				if (typeof value === "string" && value !== "") ids.push(value);
				else if (value && typeof value === "object") {
					const id = value.id ?? value.sessionId ?? value.key ?? value.value;
					if (typeof id === "string" && id !== "") ids.push(id);
				}
			};
			for (const name of ["list", "manager", "selection", "sessions", "store", "state", "current"]) {
				let value;
				try {
					value = service[name];
				} catch {
					continue;
				}
				if (value === null || value === undefined) continue;
				if (Array.isArray(value)) {
					for (const item of value) take(item);
					continue;
				}
				if (typeof value !== "object") {
					take(value);
					continue;
				}
				// 一层子对象：先试"当前/选中"这类标量，再试容器
				for (const key of ["current", "currentId", "currentSessionId", "selected", "selectedId", "active", "activeId", "value"]) {
					try {
						take(value[key]);
					} catch {}
				}
				for (const key of ["list", "items", "ids", "byId", "sessions", "records", "entries"]) {
					try {
						const child = value[key];
						if (Array.isArray(child)) for (const item of child) take(item);
						else if (child && typeof child === "object") for (const k of Object.keys(child).slice(0, 300)) take(k);
					} catch {}
				}
			}
			return [...new Set(ids)];
		}

		/**
		 * 完全脱离 client 服务的兜底：从 DOM 里挖 session id。
		 * 官方会话行由 React 渲染，属性名不保证（data-* / id / href 都试），
		 * 所以直接扫属性**值**里像 session id 的东西。
		 * 文件模式下整个列表都可能被滑出，不再按「属于哪个工作区」分组，
		 * 直接扫全部会话行（这条路径本来就是最后兜底，误配风险可接受）。
		 */
		function sessionIdFromDom() {
			const ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}/i;
			const scan = (element) => {
				if (element === null || element === undefined || element.attributes === undefined) return null;
				for (const attribute of element.attributes) {
					const match = ID_RE.exec(String(attribute.value));
					if (match !== null) return match[0];
				}
				return null;
			};
			for (const sessionRow of document.querySelectorAll(SESSION_SEL)) {
				const hit = scan(sessionRow);
				if (hit !== null) return hit;
				// 一层后代：React 常把标识放在内层节点上
				const descendants = sessionRow.querySelectorAll ? sessionRow.querySelectorAll("*") : [];
				for (const descendant of descendants) {
					const nested = scan(descendant);
					if (nested !== null) return nested;
				}
			}
			return null;
		}

		/* ───────────────────── 数据源：client 服务（不注册 slot）───────────────────── */
		// 官方 ui-workspace 自己就是这么取的：`const workspaces = ctx.get("workspaces")`。
		// **刻意不注册 `sidebar.workspaces` slot**：官方 sidebar 的源码注释写明那块
		// 区域是 "the registrant's"，且官方注册时没声明 kind —— 再注册一个条目有
		// 挤掉官方工作区列表的风险。
		// 宿主实现可能是 store（getSnapshot/subscribe）、带 items 的对象、或就是数组，
		// 这里统一适配；形状对不上时只降级、不抛错。
		/**
		 * 把一个 client 服务"解剖"成可读的画像：每个自有属性 + 原型 getter 的名字与类型
		 * （数组记长度、抛错的记异常）。写进 localStorage 后 agent 能从磁盘读到，
		 * 不用用户开 DevTools。
		 */
		function describeService(service) {
			if (service === null || service === undefined) return null;
			const out = {};
			const names = [];
			try {
				for (const key of Object.keys(service)) names.push(key);
			} catch {}
			try {
				const proto = Object.getPrototypeOf(service);
				if (proto !== null && proto !== undefined) {
					for (const name of Object.getOwnPropertyNames(proto)) {
						if (name === "constructor") continue;
						names.push("~" + name);
					}
				}
			} catch {}
			for (const name of names.slice(0, 48)) {
				const isProto = name.startsWith("~");
				const key = isProto ? name.slice(1) : name;
				try {
					const value = service[key];
					out[name] = Array.isArray(value) ? "array(" + value.length + ")" : typeof value;
				} catch (error) {
					out[name] = "throw:" + String((error && error.message) || error).slice(0, 40);
				}
			}
			return out;
		}

		function snapshotOf(service) {
			if (service === null || service === undefined) return null;
			try {
				if (typeof service.getSnapshot === "function") {
					const snap = service.getSnapshot();
					if (snap !== null && snap !== undefined && typeof snap === "object") return snap;
				}
			} catch {}
			try {
				if (typeof service.getState === "function") {
					const snap = service.getState();
					if (snap !== null && snap !== undefined && typeof snap === "object") return snap;
				}
			} catch {}
			// 两个都读不到（不存在或抛错）时，把**服务自己**当快照 —— 它的属性很可能就是 getter
			return service;
		}
		function itemsOf(snapshot) {
			if (snapshot === null || snapshot === undefined) return [];
			if (Array.isArray(snapshot)) return snapshot;
			for (const key of ["items", "workspaces", "list", "records"]) {
				if (Array.isArray(snapshot[key])) return snapshot[key];
			}
			return [];
		}
		/**
		 * 从 sessions 的 snapshot 里挖出「id → 会话记录」。宿主实现可能是
		 * `{ byId }`、`{ sessions }`、数组，或带 items/list/records 的对象 —— 全都认；
		 * 认不出就返回空表（调用方走别的兜底）。
		 */
		function sessionRecordsOf(snapshot) {
			if (snapshot === null || snapshot === undefined || typeof snapshot !== "object") return {};
			if (snapshot.byId && typeof snapshot.byId === "object") return snapshot.byId;
			if (snapshot.sessions && typeof snapshot.sessions === "object" && !Array.isArray(snapshot.sessions)) return snapshot.sessions;
			// 只有 id 列表也有用（记录本身可能要经 binding() 才拿得到）
			if (Array.isArray(snapshot.ids) && snapshot.ids.length > 0) {
				const fromIds = {};
				for (const id of snapshot.ids) if (typeof id === "string") fromIds[id] = { id };
				return fromIds;
			}
			const array = Array.isArray(snapshot)
				? snapshot
				: Array.isArray(snapshot.items)
					? snapshot.items
					: Array.isArray(snapshot.list)
						? snapshot.list
						: Array.isArray(snapshot.records)
							? snapshot.records
							: null;
			if (array === null) return {};
			const out = {};
			for (const record of array) {
				if (!record || typeof record !== "object") continue;
				const id = record.id ?? record.sessionId;
				if (typeof id === "string") out[id] = record;
			}
			return out;
		}

		/** sessions snapshot 里的「当前会话 id」。 */
		function currentIdOf(snapshot) {
			if (snapshot === null || snapshot === undefined || typeof snapshot !== "object") return null;
			const candidate = snapshot.current ?? snapshot.currentId ?? snapshot.currentSessionId;
			return typeof candidate === "string" && candidate !== "" ? candidate : null;
		}

		/** 取一个 client 服务并订阅；拿不到回 `{ ok:false }`，交给重试层。 */
		function adopt(name, assign) {
			const service = ctxRef && typeof ctxRef.get === "function" ? ctxRef.get(name) : undefined;
			if (service === null || service === undefined) return { ok: false, dispose: () => {} };
			try {
				assign(snapshotOf(service));
			} catch (error) {
				console.warn("[dsh-workspace-files] `" + name + "` 首次取数失败", error);
			}
			if (typeof service.subscribe === "function") {
				try {
					const dispose = service.subscribe(() => {
						try {
							assign(snapshotOf(service));
						} catch {}
					});
					return { ok: true, dispose: typeof dispose === "function" ? dispose : () => {} };
				} catch {}
			}
			return { ok: true, dispose: () => {} };
		}

		/**
		 * 服务可能**晚于本插件就绪**（cordis 允许异步注册），所以不能只试一次：
		 * 立刻试一遍，没拿到就按退避节奏重试（200ms 起、最多 12 次 ≈ 12s），
		 * 成功时回调 onReady，让调用方重新装饰一次。
		 */
		function adoptWithRetry(name, assign, onReady) {
			let stopped = false;
			let attempt = 0;
			let currentDispose = () => {};
			const attemptOnce = () => {
				if (stopped) return;
				const result = adopt(name, assign);
				if (result.ok) {
					currentDispose = result.dispose;
					console.info("[dsh-workspace-files] 已接上服务 `" + name + "`（第 " + (attempt + 1) + " 次尝试）");
					let shape = null;
					try {
						shape = describeService(ctxRef.get(name));
					} catch {}
					writeDiag(
						Object.assign({ serviceOk: name, attempts: attempt + 1 }, shape === null ? {} : { [name + "Shape"]: shape })
					);
					if (onReady) onReady();
					return;
				}
				attempt += 1;
				if (attempt >= 12) {
					console.warn("[dsh-workspace-files] 重试 12 次仍拿不到服务 `" + name + "`");
					writeDiag({ serviceFail: name, attempts: 12 });
					return;
				}
				setTimeout(attemptOnce, Math.min(200 * attempt, 2000));
			};
			attemptOnce();
			return () => {
				stopped = true;
				currentDispose();
			};
		}

		/** 菜单锚点矩形：鼠标坐标 → 官方 Menu 认的 DOMRect（零尺寸即可）。 */
		function anchorRectAt(x, y) {
			try {
				return new DOMRect(x, y, 0, 0);
			} catch {
				return { x, y, left: x, top: y, right: x, bottom: y, width: 0, height: 0 };
			}
		}

		/* ───────────────────────── 右键菜单：条目表 ───────────────────────── */
		/**
		 * 右键菜单的条目表（纯函数，便于离线回归）。
		 * `target.kind`：`file` 文件行 / `dir` 目录行 / `blank` 树的空白处（= 工作区根）。
		 * `apps.state`：`idle` 还没查 / `loading` 查询中 / `ready` 拿到了列表。
		 * 菜单项 id 就是动作名；「打开方式」的子项前缀 `apps:` + 应用 id。
		 */
		function buildMenuItems(target, apps) {
			const kind = target && target.kind ? target.kind : "file";
			const items = [];
			const sep = (id) => items.push({ type: "separator", id });
			if (kind === "file") {
				items.push({ id: "preview", label: "在右侧栏预览" });
				items.push({ id: "openDefault", label: "用默认应用打开" });
				items.push({ id: "openWith", label: "打开方式", submenu: openWithSubmenu(apps) });
				sep("s1");
				items.push({ id: "reveal", label: "在访达中显示" });
				items.push({ id: "terminal", label: "在终端中打开（所在目录）" });
			} else if (kind === "dir") {
				items.push({ id: "reveal", label: "在访达中打开" });
				items.push({ id: "terminal", label: "在终端中打开" });
				sep("s1");
				items.push({ id: "newFile", label: "新建文件…" });
				items.push({ id: "newDir", label: "新建文件夹…" });
			} else {
				items.push({ id: "reveal", label: "在访达中显示工作区" });
				items.push({ id: "terminal", label: "在终端中打开" });
				sep("s1");
				items.push({ id: "newFile", label: "新建文件…" });
				items.push({ id: "newDir", label: "新建文件夹…" });
			}
			sep("s2");
			if (kind === "file") {
				items.push({ id: "copyAbs", label: "复制绝对路径" });
				items.push({ id: "copyRel", label: "复制相对路径" });
				items.push({ id: "copyName", label: "复制文件名" });
			} else if (kind === "dir") {
				items.push({ id: "copyAbs", label: "复制绝对路径" });
				items.push({ id: "copyRel", label: "复制相对路径" });
				items.push({ id: "copyName", label: "复制名称" });
			} else {
				items.push({ id: "copyAbs", label: "复制工作区绝对路径" });
				items.push({ id: "copyName", label: "复制工作区名" });
			}
			if (kind !== "blank") {
				sep("s3");
				items.push({ id: "rename", label: "重命名…" });
				items.push({ id: "trash", label: "移到废纸篓", danger: true });
			}
			return items;
		}

		/** 「打开方式」子菜单：随查询状态给「载入中 / 没有可用应用 / 应用列表」三态。 */
		function openWithSubmenu(apps) {
			const state = apps && apps.state ? apps.state : "idle";
			if (state !== "ready") return [{ id: "apps:__pending", label: state === "loading" ? "载入中…" : "展开以载入…", disabled: true }];
			const list = Array.isArray(apps.list) ? apps.list : [];
			if (list.length === 0) return [{ id: "apps:__empty", label: "（系统没有返回可用应用）", disabled: true }];
			return list.slice(0, 24).map((app) => {
				const icon = typeof app.icon === "string" && app.icon !== "" ? h("img", { className: "dsh-wsf-menu-icon", src: app.icon, width: 14, height: 14, alt: "" }) : undefined;
				return { id: "apps:" + app.id, label: app.name + (app.default === true ? "（默认）" : ""), icon };
			});
		}

		/** 该地址是否落在工作区之外（用来在菜单里把「复制相对路径」标出来时做提示，不拦截）。 */
		function isOutsideRoot(root, rel) {
			if (typeof root !== "string" || root === "") return false;
			if (typeof rel !== "string" || rel === "") return false;
			return rel.startsWith("../");
		}

		/* ───────────────────────── 文件树 ───────────────────────── */
		/**
		 * 目录节点。
		 * 数据刷新由父级 `FileTree` 的 `tick` 驱动：tick 每 3 秒 +1（标签页可见时），
		 * 本组件的 effect 依赖 tick → 重新列目录（force，绕过 TTL 缓存）；
		 * **展开状态与已加载的列表都留在组件自己的 state 里**，刷新期间不回到「载入中」，
		 * 内容没变时 `sameEntries` 直接跳过 setState —— 不闪、不跳、不丢展开。
		 */
		/**
		 * 行内重命名的输入框。
		 * 编辑态的行会从 `<button>` 换成 `<div>`：**`button` 里嵌 `input` 是非法 HTML**，
		 * 浏览器会吃掉键盘/焦点事件（回车提交与 Esc 取消都收不到），必须在编辑时换掉行元素。
		 */
		function renameInput(edit) {
			return h("input", {
				className: "dsh-wsf-rename-input",
				value: edit.value,
				spellCheck: false,
				"aria-label": "重命名",
				onClick: (event) => event.stopPropagation(),
				onChange: (event) => edit.onChange(event.target.value),
				onKeyDown: (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						edit.onCommit();
					} else if (event.key === "Escape") {
						event.preventDefault();
						edit.onCancel();
					}
				},
				onBlur: () => edit.onCommit(),
				ref: (el) => {
					if (el === null || el.dataset.wsfFocused === "1") return;
					el.dataset.wsfFocused = "1";
					el.focus();
					el.select();
				}
			});
		}

		function DirNode({ sessionId, path, name, depth, onOpenFile, onMenu, edit, tick }) {
			const [expanded, setExpanded] = React.useState(false);
			const [entries, setEntries] = React.useState(null); // null = 还没拿到过数据
			const [truncated, setTruncated] = React.useState(false);
			const [error, setError] = React.useState(null);
			// 卸载后到来的响应不再 setState（fetch 的 abort 只管请求，不代替这个闸）
			const alive = React.useRef(true);
			React.useEffect(() => () => { alive.current = false; }, []);

			/** 本次展开是否已经发过第一次请求（收起时重置）；决定「载入中」与错误块的显隐时机。 */
			const triedThisOpen = React.useRef(false);

			React.useEffect(() => {
				if (!expanded) {
					triedThisOpen.current = false;
					return undefined;
				}
				const controller = new AbortController();
				// 只有本次展开的**第一次**才清错误 / 显示「载入中」：旧写法把条件写成
				// `entries === null || error !== null`，于是坏目录每个 tick 都会先清错误显示
				// 「载入中…」、失败后再弹回错误块 —— 每 3 秒闪一次（2026-10-10 修）。
				const first = !triedThisOpen.current;
				triedThisOpen.current = true;
				if (first) setError(null);
				// 首次（或手里还没有列表）绕缓存取最新；有列表后的 tick 刷新走 1.2s TTL 缓存
				listDir(sessionId, path, controller.signal, { force: first || entries === null }).then(
					(value) => {
						if (!alive.current || controller.signal.aborted) return;
						setTruncated(value.truncated);
						setError(null);
						setEntries((prev) => (sameEntries(prev, value.entries) ? prev : value.entries));
					},
					(error_) => {
						if (!alive.current || controller.signal.aborted) return;
						// 刷新失败而手里已有列表 → 保持旧列表（目录可能只是暂时读不到），不弹错误块
						if (entries === null) setError(String((error_ && error_.message) || error_));
					}
				);
				return () => controller.abort();
			}, [expanded, sessionId, path, tick]);

			const children = [];
			if (expanded) {
				// 子级状态行的缩进锚点：**必须写在这一行自己身上** —— 它和目录行是兄弟节点，
				// 继承不到行上那个 `--wsf-depth`，只靠 CSS 里的 var() 会一律取 0（全停在同一列）。
				const subNote = (key, className, text) =>
					h("div", { key, className: "dsh-wsf-note " + className + " dsh-wsf-sub-note", style: { "--wsf-depth": depth } }, text);
				if (error !== null) children.push(subNote("er", "dsh-wsf-note-error", error));
				else if (entries === null) children.push(subNote("ld", "", "载入中…"));
				else {
					const sorted = sortEntries(entries);
					if (sorted.length === 0) children.push(subNote("em", "", "（空目录）"));
					for (const entry of sorted) {
						const childPath = path.replace(/[/\\]+$/, "") + "/" + entry.name;
						children.push(
							isDir(entry)
								? h(DirNode, { key: childPath, sessionId, path: childPath, name: entry.name, depth: depth + 1, onOpenFile, onMenu, edit, tick })
								: h(FileNode, { key: childPath, path: childPath, name: entry.name, depth: depth + 1, onOpenFile, onMenu, edit })
						);
					}
					if (truncated) children.push(subNote("tr", "", "（已截断，仅显示部分条目）"));
				}
			}

			const editing = edit !== null && edit !== undefined && edit.rel === path;
			const rowProps = {
				className: "dsh-wsf-row" + (editing ? " dsh-wsf-row-editing" : ""),
				"data-depth": depth,
				"data-open": expanded ? "1" : "0",
				style: { "--wsf-depth": depth },
				title: path,
				onContextMenu: (event) => onMenu(event, { kind: "dir", rel: path, name })
			};
			const cells = [
				h(
					"span",
					{ key: "chev", className: "dsh-wsf-ico", "data-kind": "dir", "aria-hidden": true },
					h("svg", { width: 14, height: 14, viewBox: "0 0 20 20", fill: "none" }, h("path", { d: ICON_CHEVRON, stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }))
				),
				h(
					"span",
					{ key: "folder", className: "dsh-wsf-ico", "data-kind": "folder", "aria-hidden": true },
					h("svg", { width: 14, height: 14, viewBox: "0 0 20 20", fill: "none" }, h("path", { d: ICON_DIR, stroke: "currentColor", strokeWidth: 1.4, strokeLinejoin: "round" }))
				),
				editing ? renameInput(edit) : h("span", { key: "name", className: "dsh-wsf-name" }, name)
			];

			return h(
				"div",
				{ className: "dsh-wsf-group" },
				editing
					? h("div", rowProps, cells)
					: h("button", Object.assign({ type: "button", onClick: () => setExpanded((v) => !v) }, rowProps), cells),
				children.length > 0 ? h("div", { className: "dsh-wsf-children" }, children) : null
			);
		}

		/**
		 * 文件节点。
		 * 第一列放一个**空占位**（与目录行的 chevron 同宽）—— 这样文件名的起点与目录名完全一致，
		 * 否则文件行会比目录行左移 20px（图标列宽 + gap），整棵树看起来是歪的。
		 */
		function FileNode({ path, name, depth, onOpenFile, onMenu, edit }) {
			const editing = edit !== null && edit !== undefined && edit.rel === path;
			const rowProps = {
				className: "dsh-wsf-row dsh-wsf-file" + (editing ? " dsh-wsf-row-editing" : ""),
				"data-depth": depth,
				style: { "--wsf-depth": depth },
				title: path,
				onContextMenu: (event) => onMenu(event, { kind: "file", rel: path, name })
			};
			const cells = [
				h("span", { key: "spacer", className: "dsh-wsf-ico dsh-wsf-ico-empty", "data-kind": "spacer", "aria-hidden": true }),
				h(
					"span",
					{ key: "file", className: "dsh-wsf-ico", "data-kind": "file", "aria-hidden": true },
					h("svg", { width: 14, height: 14, viewBox: "0 0 20 20", fill: "none" }, h("path", { d: "M5.5 3.5h6l3 3v10h-9Z", stroke: "currentColor", strokeWidth: 1.4, strokeLinejoin: "round" }))
				),
				editing ? renameInput(edit) : h("span", { key: "name", className: "dsh-wsf-name" }, name)
			];
			return editing
				? h("div", rowProps, cells)
				: h("button", Object.assign({ type: "button", onClick: () => onOpenFile(path) }, rowProps), cells);
		}

		function FileTree(props) {
			const { sessionId, root, onBack, title, onRetry } = props;
			const [entries, setEntries] = React.useState(null);
			const [truncated, setTruncated] = React.useState(false);
			const [error, setError] = React.useState(null);
			/** 轮询节拍：+1 即让整棵已展开的树重新列目录（force）。 */
			const [tick, setTick] = React.useState(0);
			/** 「重新载入」按钮的一次性强制刷新（与轮询共用 tick 通道）。 */
			const [manual, setManual] = React.useState(0);
			/** 右键菜单：`{ x, y, kind, rel, name }`；null = 关着。 */
			const [menu, setMenu] = React.useState(null);
			/** 「打开方式」的应用列表：`{ rel, state, list }`（按 rel 缓存，避免每次右键都问宿主）。 */
			const [apps, setApps] = React.useState(null);
			/** 行内重命名：`{ rel, value }`。 */
			const [edit, setEdit] = React.useState(null);
			/** 顶部新建输入条：`{ parentRel, kind, value }`。 */
			const [create, setCreate] = React.useState(null);
			/** 操作结果提示：`{ kind: "ok" | "error", text }`。 */
			const [notice, setNotice] = React.useState(null);
			/** 正在编辑的**最新**值（Enter 提交与 blur 提交共用，保证只提交一次）。 */
			const editActive = React.useRef(null);
			/** 应用列表缓存：rel → 列表。 */
			const appsCache = React.useRef(new Map());
			const noticeTimer = React.useRef(0);
			/** 本次挂载是否已经发过根列表的第一次请求（决定错误块什么时候清）。 */
			const rootTried = React.useRef(false);
			const alive = React.useRef(true);
			React.useEffect(() => () => { alive.current = false; window.clearTimeout(noticeTimer.current); }, []);

			// ── 热更新：可见时每 REFRESH_INTERVAL_MS 推进一次 tick；切回前台立即刷一次 ──
			React.useEffect(() => {
				let timer = null;
				const bump = () => setTick((v) => v + 1);
				const start = () => {
					if (timer !== null) return;
					timer = setInterval(() => {
						if (document.visibilityState === "visible") bump();
					}, REFRESH_INTERVAL_MS);
				};
				const stop = () => {
					if (timer === null) return;
					clearInterval(timer);
					timer = null;
				};
				const onVisibility = () => {
					if (document.visibilityState === "visible") {
						bump();
						start();
					} else stop();
				};
				const onFocus = () => bump();
				if (document.visibilityState === "visible") start();
				document.addEventListener("visibilitychange", onVisibility);
				window.addEventListener("focus", onFocus);
				return () => {
					stop();
					document.removeEventListener("visibilitychange", onVisibility);
					window.removeEventListener("focus", onFocus);
				};
			}, []);

			React.useEffect(() => {
				if (root === null || root === undefined || root === "") {
					setError("拿不到该会话的工作目录（cwd）—— list 的 path 必须是绝对路径。\n" + diagnose());
					return undefined;
				}
				if (sessionId === null || sessionId === undefined || sessionId === "") {
					setError(diagnose());
					return undefined;
				}
				const controller = new AbortController();
				// 同 DirNode：只有**本次挂载的第一次**才清错误，否则持续失败的会话每个 tick
				// 都会「清错误 → 显示载入中 → 再报错」地闪（2026-10-10 与子级一起修）。
				const first = !rootTried.current;
				rootTried.current = true;
				if (first) setError(null);
				listDir(sessionId, root, controller.signal, { force: true }).then(
					(value) => {
						if (!alive.current || controller.signal.aborted) return;
						setTruncated(value.truncated);
						setError(null);
						setEntries((prev) => (sameEntries(prev, value.entries) ? prev : value.entries));
					},
					(error_) => {
						if (!alive.current || controller.signal.aborted) return;
						const message = String((error_ && error_.message) || error_);
						if (entries === null) {
							console.warn("[dsh-workspace-files] 文件树加载失败:", message);
							setError(message);
						}
					}
				);
				return () => controller.abort();
			}, [sessionId, root, tick, manual]);

			const openFile = (path) => {
				try {
					const address = `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
					const svc = ctxRef && (ctxRef.get ? ctxRef.get("sidebarRight") : ctxRef.sidebarRight);
					if (svc && typeof svc.openResource === "function") svc.openResource(address);
					else if (ctxRef && ctxRef.resources && typeof ctxRef.resources.open === "function") ctxRef.resources.open(address);
					else console.info("[dsh-workspace-files] 打开文件：", address);
				} catch (error) {
					console.warn("[dsh-workspace-files] 打开文件失败", error);
				}
			};

			/* ── 右键菜单：动作 ── */
			/** 立刻刷新整棵已展开的树（写操作后不等 3 秒轮询）。 */
			const refreshNow = () => {
				if (typeof sessionId === "string" && sessionId !== "") invalidateSession(sessionId);
				setTick((v) => v + 1);
			};
			/**
			 * 操作结果提示。`fallbackText` 只在「自动复制被系统拒绝」时传：
			 * 提示条会附一个只读输入框（自动选中），用户 ⌘C 就能拿走 —— 
			 * 剪贴板权限在部分环境（非前台窗口 / 受限内核）里确实拿不到。
			 */
			const flash = (kind, text, fallbackText) => {
				setNotice({ kind, text: String(text), copyText: fallbackText === undefined ? null : String(fallbackText) });
				writeDiag({ lastNotice: { kind, text: String(text).slice(0, 200) } });
				window.clearTimeout(noticeTimer.current);
				noticeTimer.current = window.setTimeout(() => setNotice(null), fallbackText === undefined ? NOTICE_MS : NOTICE_MS * 4);
			};
			/** 相对路径 → 宿主绝对路径（root 为空时退化为相对路径，让宿主报纸面错误）。 */
			const absFor = (rel) => (root === null || root === undefined || root === "" ? String(rel || "") : joinPath(root, rel));

			const beginRename = (rel, value) => {
				editActive.current = { rel, value };
				setEdit({ rel, value });
			};
			/** 结束重命名：`commit` false（Esc）丢弃；Enter 与 blur 都走这里，靠 ref 保证只提交一次。 */
			const finishRename = (commit) => {
				const state = editActive.current;
				editActive.current = null;
				setEdit(null);
				if (!commit || state === null) return;
				const name = String(state.value).trim();
				const before = String(state.rel).split("/").pop();
				if (name === "" || name === before) return;
				void fsCall({ action: "rename", path: absFor(state.rel), name }).then(
					() => {
						flash("ok", "已重命名为 " + name);
						refreshNow();
					},
					(error) => flash("error", String((error && error.message) || error))
				);
			};

			const submitCreate = () => {
				const state = create;
				if (state === null) return;
				const name = String(state.value).trim();
				if (name === "") {
					setCreate(null);
					return;
				}
				void fsCall({ action: state.kind === "file" ? "newFile" : "newDir", dir: absFor(state.parentRel), name }).then(
					() => {
						setCreate(null);
						flash("ok", (state.kind === "file" ? "已新建文件 " : "已新建文件夹 ") + name);
						refreshNow();
					},
					(error) => flash("error", String((error && error.message) || error))
				);
			};

			/** 菜单动作分发（id 见 buildMenuItems；`apps:` 前缀 = 用某个应用打开）。 */
			const runAction = (id, target) => {
				const fail = (error) => flash("error", String((error && error.message) || error));
				lastMenuAction = { id, kind: target.kind, rel: target.rel, at: new Date().toISOString() };
				if (id === "preview") {
					openFile(target.rel);
					return;
				}
				if (id === "reveal") {
					void openWorkspacePath(absFor(target.rel), "reveal").catch(fail);
					return;
				}
				if (id === "openDefault") {
					void openWorkspacePath(absFor(target.rel)).catch(fail);
					return;
				}
				if (id.indexOf("apps:") === 0) {
					void openWorkspacePath(absFor(target.rel), undefined, id.slice("apps:".length)).catch(fail);
					return;
				}
				if (id === "terminal") {
					// 文件行 → 打开它**所在目录**；目录行 / 空白 → 打开该目录本身
					const dir = target.kind === "file" ? parentPathOf(target.rel) : target.rel;
					void fsCall({ action: "openTerminal", path: absFor(dir) }).catch(fail);
					return;
				}
				if (id === "copyAbs" || id === "copyRel" || id === "copyName") {
					const text = id === "copyAbs" ? absFor(target.rel) : id === "copyRel" ? target.rel : target.name;
					void copyText(text).then((ok) => {
						const shown = String(text).length > 60 ? String(text).slice(0, 57) + "…" : String(text);
						if (ok) flash("ok", "已复制：" + shown);
						else flash("error", "剪贴板被系统拒绝，请手动复制下面这行（已选中）", text);
					});
					return;
				}
				if (id === "rename") {
					beginRename(target.rel, target.name);
					return;
				}
				if (id === "newFile" || id === "newDir") {
					setCreate({ parentRel: target.kind === "dir" ? target.rel : "", kind: id === "newFile" ? "file" : "dir", value: "" });
					return;
				}
				if (id === "trash") {
					void fsCall({ action: "trash", path: absFor(target.rel) }).then(
						() => {
							flash("ok", "已移到废纸篓：" + target.name);
							refreshNow();
						},
						fail
					);
				}
			};

			/** 行 / 空白处右键：记录鼠标坐标；文件行顺带预取「打开方式」列表。 */
			const openMenuAt = (event, target) => {
				event.preventDefault();
				event.stopPropagation();
				setMenu({ x: event.clientX, y: event.clientY, kind: target.kind, rel: target.rel, name: target.name });
				if (target.kind !== "file") return;
				const cached = appsCache.current.get(target.rel);
				if (cached !== undefined) {
					setApps({ rel: target.rel, state: "ready", list: cached });
					return;
				}
				setApps({ rel: target.rel, state: "loading", list: [] });
				void fileApplications(absFor(target.rel)).then((list) => {
					appsCache.current.set(target.rel, list);
					if (!alive.current) return;
					setApps({ rel: target.rel, state: "ready", list });
				});
			};
			/** 树的空白处右键 = 以工作区根为目标的菜单（行与按钮自己已经拦过右键）。 */
			const onBlankContextMenu = (event) => {
				const target = event.target;
				if (target !== null && target !== undefined && typeof target.closest === "function") {
					if (target.closest(".dsh-wsf-row") !== null || target.closest("button") !== null || target.closest("input") !== null) return;
				}
				openMenuAt(event, { kind: "blank", rel: "", name: title || "工作区" });
			};

			const head = h(
				"div",
				{ className: "dsh-wsf-head" },
				// 文件模式（全工作区覆盖层）下才有返回按钮 —— 与 zcode 的 WorkspaceFileTree 头部同款
				onBack
					? h(
							"button",
							{ type: "button", className: "dsh-wsf-back", title: "返回会话列表", "aria-label": "返回会话列表", onClick: onBack },
							h("svg", { width: 14, height: 14, viewBox: "0 0 20 20", fill: "none" }, h("path", { d: ICON_CHEVRON_LEFT, stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }))
						)
					: null,
				/**
				 * 头部只有两格：**返回箭头 + 标题**，标题左边缘落在 `2 + 22 + 2 = 26px`。
				 * 中间那块曾经补过一个「当前工作区」标记（先文件夹、后圆点），用户最终要求整个去掉
				 * ——「直接去掉圆点吧标题往左边去吧」；那就让它回到最简，别再用装饰去填位。
				 */
				h("span", { className: "dsh-wsf-head-title" + (onBack ? " dsh-wsf-head-title-ws" : "") }, title || "文件"),
				h("button", { type: "button", className: "dsh-wsf-reload", title: "立即刷新（其余时间会自动热更新）", onClick: () => { if (typeof sessionId === "string" && sessionId !== "") invalidateSession(sessionId); sessionIdCache.clear(); rootTried.current = false; setManual((v) => v + 1); } }, "刷新")
			);

			/** 行内重命名的 props 包；节点自己判断「是不是我在编辑」。 */
			const editProps =
				edit === null
					? null
					: {
							rel: edit.rel,
							value: edit.value,
							onChange: (value) => {
								if (editActive.current !== null) editActive.current = { rel: editActive.current.rel, value };
								setEdit({ rel: edit.rel, value });
							},
							onCommit: () => finishRename(true),
							onCancel: () => finishRename(false)
						};

			/** 顶部新建输入条：不依赖目标目录是否已展开，写完 force 重列即可看到。 */
			const editBar =
				create === null
					? null
					: h(
							"div",
							{ className: "dsh-wsf-edit" },
							h("span", { className: "dsh-wsf-edit-label" }, (create.kind === "file" ? "新建文件于 " : "新建文件夹于 ") + (create.parentRel === "" ? title || "工作区" : create.parentRel) + "/"),
							h("input", {
								className: "dsh-wsf-edit-input",
								value: create.value,
								autoFocus: true,
								spellCheck: false,
								placeholder: create.kind === "file" ? "文件名（含扩展名），回车创建" : "文件夹名，回车创建",
								onChange: (event) => setCreate({ parentRel: create.parentRel, kind: create.kind, value: event.target.value }),
								onKeyDown: (event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										submitCreate();
									} else if (event.key === "Escape") {
										event.preventDefault();
										setCreate(null);
									}
								},
								onBlur: () => setCreate(null)
							}),
							h(
								"button",
								{
									type: "button",
									className: "dsh-wsf-edit-ok",
									// 按下时阻止默认：否则按钮先因 blur 被卸载，点击落不到 onClick
									onMouseDown: (event) => event.preventDefault(),
									onClick: () => submitCreate()
								},
								"创建"
							)
						);

			let body;
			if (error !== null) {
				// 错误态给一个「重试」：刷新后服务晚到、或工作区刚被改名时，点一下就能重新解析
				body = h(
					"div",
					{ className: "dsh-wsf-note dsh-wsf-note-error" },
					h("div", { key: "t", className: "dsh-wsf-note-text" }, error),
					typeof onRetry === "function" ? h("button", { key: "r", type: "button", className: "dsh-wsf-retry", onClick: () => onRetry() }, "重试") : null
				);
			} else if (entries === null) body = h("div", { className: "dsh-wsf-note" }, "载入中…");
			else {
				const sorted = sortEntries(entries);
				body =
					sorted.length === 0
						? h("div", { className: "dsh-wsf-note" }, "（空工作区）")
						: h(
								"div",
								{ className: "dsh-wsf-tree" },
								sorted.map((entry) =>
									isDir(entry)
										? h(DirNode, { key: entry.name, sessionId, path: entry.name, name: entry.name, depth: 0, onOpenFile: openFile, onMenu: openMenuAt, edit: editProps, tick })
										: h(FileNode, { key: entry.name, path: entry.name, name: entry.name, depth: 0, onOpenFile: openFile, onMenu: openMenuAt, edit: editProps })
								)
							);
			}

			/** 右键菜单（官方 Menu）：门户到 body、从鼠标坐标弹出 —— 不会被侧栏的 overflow 裁掉。 */
			const menuNode = h(Menu, {
				open: menu !== null,
				anchor: null,
				className: MENU_ANCHOR_CLASS,
				portal: true,
				align: "start",
				side: "bottom",
				items: menu === null ? [] : buildMenuItems(menu, apps !== null && apps.rel === menu.rel ? apps : null),
				getAnchorRect: () => (menu === null ? null : anchorRectAt(menu.x, menu.y)),
				onClose: () => setMenu(null),
				onSelect: (id) => {
					const target = menu;
					setMenu(null);
					if (target !== null) runAction(id, target);
				}
			});

			return h(
				"div",
				{ className: "dsh-wsf-body", onContextMenu: onBlankContextMenu },
				head,
				editBar,
				notice === null
					? null
					: h(
							"div",
							{ className: "dsh-wsf-notice", "data-kind": notice.kind },
							h("span", { className: "dsh-wsf-notice-text" }, notice.text),
							notice.copyText === null || notice.copyText === undefined
								? null
								: h("input", {
										className: "dsh-wsf-copy-fallback",
										readOnly: true,
										spellCheck: false,
										value: notice.copyText,
										"aria-label": "手动复制",
										title: notice.copyText,
										onClick: (event) => event.target.select(),
										ref: (el) => {
											if (el === null || el.dataset.wsfSelected === "1") return;
											el.dataset.wsfSelected = "1";
											try {
												el.focus();
												el.select();
												// select() 会把只读输入框滚到**末尾**，看起来像只有半截路径；拨回开头
												const toStart = () => {
													try {
														el.scrollLeft = 0;
													} catch {}
												};
												toStart();
												requestAnimationFrame(toStart);
											} catch {}
										}
									})
						),
				body,
				menuNode
			);
		}

		/* ───────────────────────── DOM 注入 ───────────────────────── */
		function injectStyle() {
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		/**
		 * 定位侧边栏列表的「外壳」（参考 zcode WorkspaceSidebar 的双视图结构）：
		 *   sc    = 行所在的滚动容器（overflow-y: auto/scroll，文件模式下整体滑出）
		 *   shell = 滚动容器的父级（覆盖层挂载点，等价 zcode 的 `relative flex-1 overflow-hidden`）
		 * 不硬编码类名：从 projectRow 向上找「包含全部行」的共同祖先，再向上找第一个滚动容器。
		 */
		function listShellOf() {
			const rows = [...document.querySelectorAll(ROW_SEL)];
			if (rows.length === 0) return null;
			let node = rows[0].parentElement;
			while (node !== null && node !== document.body) {
				let containsAll = true;
				for (const row of rows) {
					if (!node.contains(row)) {
						containsAll = false;
						break;
					}
				}
				if (containsAll) break;
				node = node.parentElement;
			}
			if (node === null || node === document.body) return null;
			let sc = node;
			while (sc.parentElement !== null && sc.parentElement !== document.body) {
				let overflowY = "";
				try {
					overflowY = getComputedStyle(sc).overflowY;
				} catch {}
				if (overflowY === "auto" || overflowY === "scroll") break;
				sc = sc.parentElement;
			}
			const shell = sc.parentElement;
			if (shell === null || shell === document.body) return null;
			return { sc, shell };
		}

		/** 切换动画参数（与 CSS @keyframes 里的时长/缓动保持一致）。 */
		const SWITCH_ANIM_MS = 180;
		const SWITCH_EASE = "cubic-bezier(.22,.61,.36,1)";
		/** 正在播「退出」动画、等待卸载的覆盖层（用户在这 200ms 内又点开时先把它收掉）。 */
		let pendingExit = null;
		function prefersReducedMotion() {
			try {
				return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			} catch {
				return false;
			}
		}
		/** 重启动画：先清空再设置，保证连续切换时也能重新播放。 */
		function playAnim(el, name) {
			if (el === null || el === undefined || prefersReducedMotion()) return;
			try {
				el.style.animation = "none";
				void el.offsetWidth; // 强制 reflow：让同名动画从头开始
				el.style.animation = name + " " + SWITCH_ANIM_MS + "ms " + SWITCH_EASE + " both";
			} catch {}
		}
		/** 真正拆掉一个覆盖层：卸载 React 树 + 移除元素 + 复位标记与内联动画。 */
		function disposeOverlay(ov) {
			try {
				ov.root.unmount();
			} catch {}
			try {
				ov.el.remove();
			} catch {}
			try {
				ov.el.style.animation = "";
				ov.sc.style.animation = "";
			} catch {}
			if (ov.sc.isConnected) ov.sc.removeAttribute(PARKED_MARK);
			if (ov.shell.isConnected) ov.shell.removeAttribute(SHELL_MARK);
		}
		/** 立刻收掉上一轮「正在退出」的覆盖层（不等它的延时器）。 */
		function reapPending() {
			if (pendingExit === null) return;
			const p = pendingExit;
			pendingExit = null;
			try {
				clearTimeout(p.timer);
			} catch {}
			disposeOverlay(p.ov);
		}

		function teardownOverlay() {
			reapPending();
			if (overlay === null) return;
			const ov = overlay;
			overlay = null;
			disposeOverlay(ov);
		}

		function ensureOverlay() {
			if (overlay !== null && overlay.el.isConnected) return overlay;
			teardownOverlay(); // 官方重渲染可能把旧 sc/shell 换掉了 → 重建
			const found = listShellOf();
			if (found === null) return null;
			const el = document.createElement("div");
			el.className = "dsh-wsf-overlay";
			el.setAttribute(OVERLAY_MARK, "1");
			// 背景保持透明：文件模式下列表是 visibility:hidden（原地隐藏，不是位移到别处），
			// 覆盖层透出的就是侧边栏原生底色 —— 不猜任何主题 token，暗/亮色都不会出现「莫名色块」。
			found.sc.insertAdjacentElement("afterend", el);
			overlay = {
				sc: found.sc,
				shell: found.shell,
				el,
				root: ReactDOMClient.createRoot(el),
				key: null,
				sessionId: null,
				renderedKey: undefined,
				renderedSessionId: undefined
			};
			return overlay;
		}

		/** 进入文件模式：整个列表区域滑出，覆盖层滑入（zcode 的双视图切换）。 */
		function enterFileMode(row) {
			const ov = ensureOverlay();
			if (ov === null) {
				console.warn("[dsh-workspace-files] 找不到列表容器，无法进入文件模式");
				return;
			}
			const key = keyOf(row);
			// 上一次打开同一个工作区的话复用已解析的 sessionId，避免重复走探测链
			let sessionId = ov.key === key && ov.sessionId !== null ? ov.sessionId : sessionIdCache.get(key);
			if (sessionId === undefined || sessionId === null) {
				sessionId = sessionIdForKey(key, row);
				if (typeof sessionId === "string" && sessionId !== "") sessionIdCache.set(key, sessionId);
			}
			ov.key = key;
			ov.sessionId = sessionId === undefined || sessionId === null ? null : sessionId;
			ov.el.setAttribute("data-wsf-key", key);
			ov.sc.setAttribute(PARKED_MARK, "1");
			ov.shell.setAttribute(SHELL_MARK, "1");
			// 同 key + 同 sessionId 且已展开 → 不重渲染（React 相同 props 不重跑 effect，
			// 这是「永远载入中」的根治点；decorate 每轮都会走到这里）
			if (ov.renderedKey === key && ov.renderedSessionId === ov.sessionId && ov.el.getAttribute("data-wsf-open") === "1") {
				openKey = key;
				writeOpen(key);
				syncRows();
				return;
			}
			const resolved = ov.sessionId === null ? { sessionId: null, root: null } : rootFor(ov.sessionId);
			/**
			 * 解析不出「会话 + 工作目录」时**不锁定**这次渲染。
			 * 刷新页面/重启后，插件常比 `sessions` / `workspaces` 服务先就绪 ——
			 * 锁定的话覆盖层会永远停在「拿不到该会话的工作目录」上（官方 UI 一直在变，
			 * 但插件不一定再被叫醒重画）。这里改成「先渲染错误态 + 排一次重试」，
			 * 数据到位后同一 key 会自然换成真正的文件树。
			 * 实测 2026-10-08：刷新后自动恢复文件模式时必现，手动点开时（服务已就绪）不现。
			 */
			const unresolved = resolved.sessionId === null || resolved.sessionId === undefined || resolved.root === null || resolved.root === undefined;
			if (unresolved) {
				ov.renderedKey = undefined;
				ov.renderedSessionId = undefined;
				/**
				 * **两处缓存都要清**：`ov.sessionId` 是覆盖层对象上的，`sessionIdCache` 是模块级的。
				 * 只清 Map 没用 —— `enterFileMode` 的取值顺序是「ov.sessionId 优先、Map 其次」，
				 * 覆盖层上那个旧值会把失败结果钉死，重试永远不重新解析（实测 2026-10-08）。
				 */
				ov.sessionId = null;
				sessionIdCache.delete(key);
			} else {
				ov.renderedKey = key;
				ov.renderedSessionId = ov.sessionId;
				resolveAttempts = 0;
			}
			ov.root.render(h(FileTree, { key, sessionId: resolved.sessionId, root: resolved.root, onBack: () => exitFileMode(), onRetry: () => retryResolve(key), title: key }));
			ov.el.setAttribute("data-wsf-open", "1");
			// 覆盖层从右侧轻推入、被盖住的列表向左滑出（比纯 crossfade 更能表达「换了一屏」）
			playAnim(ov.el, "dsh-wsf-overlay-in");
			playAnim(ov.sc, "dsh-wsf-list-out");
			openKey = key;
			writeOpen(key);
			syncRows();
			if (unresolved) scheduleResolveRetry(key);
		}

		/**
		 * 「还没解析出会话根」时的重试排期。
		 * 为什么必须有它：`sessions` / `workspaces` 的订阅回调在本机**从不触发**（取数靠 ensureData 的
		 * 惰性补取），没有这个排期，刷新后「插件比服务先就绪」就会永远停在「拿不到 cwd」的报错上。
		 * 退避 1.5s → 3s → 6s → 8s（封顶）；**一次重试里抛错也要继续排下一次** ——
		 * 断链正是上一版停住的原因（catch 里没有续排，异常一次就再也不重试了）。
		 */
		function scheduleResolveRetry(key) {
			if (resolveTimer !== 0 || resolveAttempts >= RESOLVE_RETRY_LIMIT) return;
			const delay = Math.min(RESOLVE_RETRY_BASE_MS * Math.pow(2, Math.min(resolveAttempts, 3)), RESOLVE_RETRY_MAX_MS);
			resolveAttempts += 1;
			resolveTimer = setTimeout(() => {
				resolveTimer = 0;
				if (openKey !== key) {
					resolveAttempts = 0;
					return;
				}
				try {
					// 强制重取一次：分批加载的会话 store 可能刚补齐含 cwd 的那一批
					ensureData(true);
					applyOpenState();
				} catch (error) {
					console.warn("[dsh-workspace-files] 重试解析失败", error);
					writeDiag({ resolveRetryError: String((error && error.message) || error).slice(0, 160) });
					scheduleResolveRetry(key);
				}
			}, delay);
		}

		/** 错误态里的「重试」：清掉解析缓存后重新走进文件模式（比等自动重试更直接）。 */
		function retryResolve(key) {
			sessionIdCache.clear();
			ensureData(true);
			resolveAttempts = 0;
			if (resolveTimer !== 0) {
				clearTimeout(resolveTimer);
				resolveTimer = 0;
			}
			const row = [...document.querySelectorAll(ROW_SEL)].find((candidate) => keyOf(candidate) === key);
			if (row === undefined) return;
			if (overlay !== null) {
				overlay.renderedKey = undefined;
				overlay.renderedSessionId = undefined;
				overlay.sessionId = null;
			}
			enterFileMode(row);
		}

		/** 退出文件模式：覆盖层滑出 + 列表滑回，动画结束后再拆 React 树和 DOM（立即拆会闪半程画面）。 */
		function exitFileMode() {
			openKey = null;
			writeOpen(null);
			resolveAttempts = 0;
			reapPending();
			if (overlay !== null) {
				const ov = overlay;
				overlay = null;
				// 播动画时**不能**先撤 data-wsf-open（那会让覆盖层立刻 visibility:hidden，动画就看不到了），
				// 也不能先撤 parked（列表会先蹦出来再播动画）—— 都留到 disposeOverlay 里一起复位。
				playAnim(ov.el, "dsh-wsf-overlay-out");
				playAnim(ov.sc, "dsh-wsf-list-in");
				const timer = setTimeout(() => {
					if (pendingExit !== null && pendingExit.ov === ov) pendingExit = null;
					disposeOverlay(ov);
				}, SWITCH_ANIM_MS + 20);
				pendingExit = { ov, timer };
			}
			syncRows();
		}

		/**
		 * 数据面变了（workspaces/sessions 订阅回调清了 sessionIdCache）：
		 * 覆盖层开着的话强制重建 —— React 收到相同 props 不会重跑 effect，
		 * 只改缓存不清渲染的话，面板会一直停在旧数据/旧错误上。
		 */
		function remountOverlay() {
			if (overlay === null) return;
			const key = overlay.key;
			teardownOverlay();
			if (key === null) return;
			const row = [...document.querySelectorAll(ROW_SEL)].find((candidate) => keyOf(candidate) === key);
			if (row !== undefined) enterFileMode(row);
		}

		function applyOpenState() {
			if (openKey === null) {
				// openKey 为空但覆盖层还挂着（异常态）→ 收掉
				if (overlay !== null) exitFileMode();
				return;
			}
			const rows = [...document.querySelectorAll(ROW_SEL)];
			const row = rows.find((candidate) => keyOf(candidate) === openKey);
			if (row === undefined) {
				/**
				 * 找不到记住的那个工作区行。**不能立刻复位**：刷新页面时插件往往先于官方
				 * 侧边栏渲染完成，这一轮只是「还没画出来」—— 早先在这里直接 exitFileMode()，
				 * 会把 localStorage 里记住的展开态一并清掉（刷新后文件模式丢失的根因）。
				 * 所以：一行都没有 ⇒ 明确是初始化阶段，静默跳过；有行但一直找不到 ⇒ 8 秒后
				 * 才认为工作区真的没了，复位。
				 */
				if (rows.length === 0) return;
				if (openMissSince === 0) {
					openMissSince = Date.now();
					return;
				}
				if (Date.now() - openMissSince < OPEN_MISS_GRACE_MS) return;
				openMissSince = 0;
				exitFileMode();
				return;
			}
			openMissSince = 0;
			enterFileMode(row);
		}

		/**
		 * 同步全部工作区行的按钮状态：激活属性 + 文案。
		 * 文件模式下当前行保持高亮，再点同一个按钮（或覆盖层里的返回）都能回到会话列表。
		 */
		function syncRows() {
			for (const row of document.querySelectorAll(ROW_SEL)) {
				const active = openKey !== null && keyOf(row) === openKey;
				row.setAttribute("data-wsf-active", active ? "1" : "0");
				const button = row.querySelector(":scope > .dsh-wsf-toggle");
				if (button === null) continue;
				const label = active ? "返回会话列表" : "查看文件列表";
				button.title = label;
				button.setAttribute("aria-label", label);
				button.setAttribute("aria-pressed", active ? "true" : "false");
			}
		}

		function decorate() {
			const rows = document.querySelectorAll(ROW_SEL);
			for (const row of rows) {
				if (row.getAttribute(BTN_MARK) !== "1") {
					row.setAttribute(BTN_MARK, "1");
					const button = document.createElement("button");
					button.type = "button";
					button.className = "dsh-wsf-toggle";
					button.innerHTML = '<svg width="14" height="14" viewBox="0 0 20 20" fill="none">' + ICON_PANEL + "</svg>";
					button.addEventListener("click", (event) => {
						event.preventDefault();
						event.stopPropagation();
						const key = keyOf(row);
						if (openKey === key) exitFileMode();
						else enterFileMode(row);
					});
					row.appendChild(button);
				}
			}
			syncRows();
			applyOpenState();
		}

		/* ───────────────────────── 样式 ───────────────────────── */
		const CSS = [
			// 按钮：默认隐形，hover 工作区行时出现（与官方 chevron 同样的时机）
			".dsh-wsf-toggle{display:none;flex:none;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:5px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
			ROW_SEL + ":hover .dsh-wsf-toggle{display:inline-flex}",
			".dsh-wsf-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			ROW_SEL + '[data-wsf-active="1"] .dsh-wsf-toggle{display:inline-flex;color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}',
			// 文件模式覆盖层：淡入 + 轻微上移（不做整屏大平移 —— 官方滚动容器自带
			// transition/裁剪时大位移会被打断出怪动画；克制的 crossfade 最稳）。
			// 背景透明：列表隐藏后透出的就是侧边栏原生底色，不猜主题 token。
			".dsh-wsf-overlay{position:absolute;inset:0;z-index:40;display:flex;flex-direction:column;background:transparent;opacity:0;visibility:hidden;pointer-events:none}",
			// 五段 keyframes（由 playAnim() 设成 inline animation 播放）：覆盖层右推入/右滑出、
			// 被盖住的列表左滑出/左滑回、子目录展开时的轻微下落淡入。
			"@keyframes dsh-wsf-overlay-in{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}",
			"@keyframes dsh-wsf-overlay-out{from{opacity:1;transform:none}to{opacity:0;transform:translateX(10px)}}",
			"@keyframes dsh-wsf-list-out{from{opacity:1;transform:none}to{opacity:0;transform:translateX(-10px)}}",
			"@keyframes dsh-wsf-list-in{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:none}}",
			"@keyframes dsh-wsf-grow{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}",
			'.dsh-wsf-overlay[data-wsf-open="1"]{opacity:1;visibility:visible;pointer-events:auto}',
			// 文件模式下：列表淡出并原地隐藏（visibility 延迟到淡出结束，之后即使官方重渲染也不可见）
			'[data-wsf-parked="1"]{opacity:0;visibility:hidden;pointer-events:none;transform:translateX(-10px)}',
			'[data-wsf-shell="1"]{position:relative !important;overflow:hidden !important}',
			".dsh-wsf-body{display:flex;flex-direction:column;gap:1px;max-height:min(60vh,520px);overflow-y:auto;overscroll-behavior:contain}",
			".dsh-wsf-overlay .dsh-wsf-body{flex:1;min-height:0;max-height:none}",
			// 覆盖层头部：返回按钮贴最左（视觉与下方行的图标列对齐），标题随后
			// 返回按钮：整块 40px 宽（左边缘落在行的左内边距上、右边缘正好是名称列），
			// 图标在块内**靠左**对齐 —— 于是它的视觉中心与下方目录行的 chevron 列同心。
			// 返回按钮：**22×22 的轻量圆角块**（早先是 40×24，hover 一悬停就是一大块灰底，
			// 比右侧的「刷新」重得多）。水平位置由 head 的左内边距 2px 决定 → 按钮 2..24，
			// 中心 13 恰好是下方目录行 chevron 列（6..20）的中心；图标本身 14px、与 chevron 同几何，
			// 所以两者墨迹完全同列。右侧留 2px，标题紧跟着从 **26px** 起 ——
			// 中间那个「当前工作区」标记（先文件夹、后圆点）已按用户要求整个去掉，不再填料。
			".dsh-wsf-back{flex:none;display:grid;place-items:center;width:22px;height:22px;margin:0 2px 0 0;padding:0;border:none;border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".dsh-wsf-back:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			// 头部只有两格：左内边距 2 + 按钮 22 + 间距 2 = **26**（标题左边缘），
			// 于是标题紧贴在返回箭头右边（不再有中间那一格）。
			".dsh-wsf-head{flex:none;display:flex;align-items:center;gap:0;min-height:28px;padding:0 8px 0 2px}",
			".dsh-wsf-head-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;line-height:18px;letter-spacing:0;text-transform:none;color:var(--dsw-alias-label-primary)}",
			".dsh-wsf-head-title-ws{font-size:13px}",
			".dsh-wsf-reload{flex:none;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l1);border-radius:5px;background:0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;cursor:pointer}",
			".dsh-wsf-reload:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-wsf-tree,.dsh-wsf-children{display:flex;flex-direction:column;gap:1px}",
			".dsh-wsf-children{animation:dsh-wsf-grow .14s cubic-bezier(.22,.61,.36,1) both}",
			".dsh-wsf-row{display:flex;align-items:center;gap:6px;width:100%;min-height:26px;padding:0 8px 0 calc(6px + var(--wsf-depth,0) * 20px);border:none;border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;text-align:left;cursor:pointer;transition:background .12s ease,color .12s ease}",
			".dsh-wsf-row:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			'.dsh-wsf-ico{display:grid;place-items:center;flex:none;width:14px;height:14px;color:var(--dsw-alias-label-tertiary)}',
			"/* 文件行的第一列占位：占住 chevron 的宽度但不可见，让文件名与目录名同列 */",
			'.dsh-wsf-ico-empty{visibility:hidden}',
			'.dsh-wsf-ico[data-kind="folder"]{color:var(--dsw-alias-state-business-primary)}',
			'.dsh-wsf-row[data-open="0"] .dsh-wsf-ico[data-kind="dir"]{transform:rotate(0deg)}',
			'.dsh-wsf-row[data-open="1"] .dsh-wsf-ico[data-kind="dir"]{transform:rotate(90deg)}',
			".dsh-wsf-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-wsf-file .dsh-wsf-name{color:var(--dsw-alias-label-secondary)}",
			".dsh-wsf-note{padding:2px 10px;color:var(--dsw-alias-label-tertiary);font-size:12px}",
			// 子级状态行（载入中 / 空目录 / 已截断 / 错误）：左边缘对齐到**子项的名字列** ——
			// `6 + (depth+1)*20 + 图标14 + 间距6 + 图标14 + 间距6 = 66 + depth*20`。
			// 早先是固定 10px，于是在深层目录下「（空目录）」会跑到整棵树的最左边（2026-10-10 用户指出）。
			".dsh-wsf-sub-note{padding:2px 10px 2px calc(66px + var(--wsf-depth,0) * 20px)}",
			".dsh-wsf-note-error{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-tertiary));line-height:1.6}",
			".dsh-wsf-note-text{white-space:pre-line}",
			// 错误态里的「重试」：与头部「刷新」同款轻量按钮
			".dsh-wsf-retry{align-self:flex-start;margin:4px 0 0;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:5px;background:0 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer}",
			".dsh-wsf-retry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			"@media (prefers-reduced-motion:reduce){.dsh-wsf-ico{transition:none}.dsh-wsf-overlay,.dsh-wsf-children,[data-wsf-parked=\"1\"]{animation:none !important}}",
			".dsh-wsf-ico{transition:transform .14s cubic-bezier(.22,.61,.36,1)}",
			// ── 右键菜单（v0.5.0）──
			// 官方 Menu 的外壳是 `span.root{position:relative;display:inline-flex}`；挂进文件树前
			// 用 display:contents 把它从 flex 布局里摘出去（定位走 portal + getAnchorRect，不靠它）。
			".dsh-wsf-menu-anchor{display:contents}",
			".dsh-wsf-menu-icon{border-radius:3px;object-fit:contain}",
			// 行内重命名：输入框顶掉名字列，字号/行高与 .dsh-wsf-name 一致，避免跳动
			".dsh-wsf-row-editing{cursor:default}",
			".dsh-wsf-row-editing:hover{background:0 0}",
			".dsh-wsf-rename-input{flex:1;min-width:0;height:20px;padding:0 5px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:5px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04));color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;outline:none}",
			// 顶部新建输入条：说明 + 输入 + 创建
			".dsh-wsf-edit{flex:none;display:flex;align-items:center;gap:6px;padding:2px 8px 4px;min-height:26px}",
			".dsh-wsf-edit-label{flex:none;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".dsh-wsf-edit-input{flex:1;min-width:0;height:22px;padding:0 6px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;outline:none}",
			".dsh-wsf-edit-input::placeholder{color:var(--dsw-alias-label-quaternary,var(--dsw-alias-label-tertiary))}",
			".dsh-wsf-edit-ok{flex:none;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l1);border-radius:5px;background:0 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;cursor:pointer}",
			".dsh-wsf-edit-ok:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			// 操作结果提示（成功/失败）：不占位、不推挤列表；复制被拒时附一个可手动复制的只读输入框
			".dsh-wsf-notice{display:flex;flex-direction:column;gap:3px;margin:0 8px 4px;padding:3px 7px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}",
			".dsh-wsf-notice-text{word-break:break-all}",
			".dsh-wsf-copy-fallback{width:100%;box-sizing:border-box;height:20px;padding:0 5px;border:1px solid var(--dsw-alias-border-l1);border-radius:5px;background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:18px;outline:none}",
			'.dsh-wsf-notice[data-kind="error"]{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-state-warn-primary));background:var(--dsw-alias-state-error-tertiary,rgba(200,60,60,.12))}'
		].join("");

		/* ─────────────── 背景/几何探针（一次性，只读诊断）─────────────── */
		/**
		 * 采样「侧栏底色到底来自哪一层」与「文件树的列对齐」两组事实，分片写进
		 *
		 * 2026-10-08 的实测结论（本机 desktop，macOS）：侧栏色差**不是插件造成的** ——
		 * 官方 `@deepseek-ai/dsh-client-ui-layout/AppFrame.module.css` 给
		 * `[data-platform="darwin"] ._sidebarCol` 单独写了 macOS 材质：
		 * `linear-gradient(to bottom, #7a9bf01a, #7a9bf000 35%, #8f89b800 68%, #8f89b817),
		 *  color-mix(in srgb, color-mix(in srgb, var(--dsw-specific-sidebar-fill) 97%, #7a9bf0) 40%, transparent)`，
		 * 也就是「40% 不透明的混色 + 上下两段蓝紫渐变」——上偏蓝、下偏紫，中间近中性。
		 * 只在 darwin 平台生效，所以 CLI/web 实例里看不到。
		 * localStorage —— agent 直接从 Electron 的 localStorage leveldb（明文 .log）
		 * 里读回，不需要用户开 DevTools。
		 * 只在 `localStorage["dsh-workspace-files:probe"] === "1"` 的那一次刷新里跑，跑完自毁开关。
		 */
		function probeSurfaces() {
			const parts = [];
			const add = (value) => {
				let text;
				try {
					text = typeof value === "string" ? value : JSON.stringify(value);
				} catch {
					return;
				}
				for (let i = 0; i < text.length; i += 600) parts.push(text.slice(i, i + 600));
			};
			const classNameOf = (el) => (typeof el.className === "string" ? el.className.slice(0, 60) : "");
			/** 从该元素向上收集所有「有铺色」的祖先（背景色或背景图），带 rect。 */
			const layersOf = (el, limit) => {
				const out = [];
				let node = el;
				let n = 0;
				while (node !== null && node !== undefined && node !== document.documentElement && n < (limit || 10)) {
					const cs = getComputedStyle(node);
					const hasBg = (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") || (cs.backgroundImage && cs.backgroundImage !== "none");
					if (hasBg) {
						const r = node.getBoundingClientRect();
						out.push({
							cls: classNameOf(node),
							slot: node.getAttribute("data-slot") || "",
							bg: cs.backgroundColor,
							img: cs.backgroundImage === "none" ? "" : cs.backgroundImage.slice(0, 70),
							opacity: cs.opacity,
							top: Math.round(r.top),
							h: Math.round(r.height),
							w: Math.round(r.width),
							pos: cs.position,
							z: cs.zIndex
						});
					}
					node = node.parentElement;
					n += 1;
				}
				return out;
			};
			try {
				add({ probe: "start", at: new Date().toISOString(), href: location.href, dpr: window.devicePixelRatio });
				try {
					add({ palette: window.localStorage.getItem("dsh-theme-manager:palette.v1") });
				} catch (error) {
					add({ palette: "读取失败" });
				}
				add({
					styleTags: [...document.querySelectorAll("style[id], style[data-plugin-css], style[data-plugin]")].map((el) => {
						const text = el.textContent || "";
						return {
							id: el.id || "",
							plugin: el.getAttribute("data-plugin-css") || el.getAttribute("data-plugin") || "",
							len: text.length,
							bg: /background|backdrop|filter/i.test(text)
						};
					})
				});
				const paletteStyle = document.getElementById("dsh-theme-manager-palette");
				add({ paletteCss: paletteStyle === null ? null : paletteStyle.textContent.slice(0, 1200) });

				// 谁给侧栏列写了背景？把「能匹配到它的规则」与「含 _sidebarCol 的样式标签」都列出来
				// —— 这一条决定各区域底色差异该归给谁。
				const colEl = document.querySelector('[class*="_sidebarCol"]');
				const ruleHits = [];
				for (const sheet of [...document.styleSheets]) {
					let rules = null;
					try {
						rules = sheet.cssRules;
					} catch {
						continue;
					}
					if (rules === null || rules === undefined) continue;
					const owner = sheet.ownerNode;
					const ownerTag =
						owner === null || owner === undefined
							? "?"
							: owner.id || owner.getAttribute("data-plugin-css") || owner.getAttribute("data-plugin") || owner.tagName;
					for (const rule of [...rules]) {
						const text = rule.cssText || "";
						if (text.indexOf("sidebarCol") < 0) continue;
						if (!/background|filter|backdrop/i.test(text)) continue;
						if (rule.selectorText && colEl !== null && colEl !== undefined) {
							let matched = null;
							try {
								matched = colEl.matches(rule.selectorText);
							} catch {
								matched = "选择器无法求值";
							}
							if (matched === false) continue;
						}
						ruleHits.push({ owner: ownerTag, sel: (rule.selectorText || "").slice(0, 140), css: text.slice(0, 300) });
					}
				}
				add({ sidebarRules: ruleHits.slice(0, 12) });
				add({
					sidebarStyleTags: [...document.querySelectorAll("style")]
						.filter((el) => (el.textContent || "").indexOf("sidebarCol") >= 0)
						.map((el) => ({
							id: el.id || "",
							plugin: el.getAttribute("data-plugin-css") || el.getAttribute("data-plugin") || "",
							len: el.textContent.length,
							sample: el.textContent.slice(0, 240)
						}))
				});

				// ① 侧栏：纵向扫描给定点的「铺色栈」+ 子树里所有铺色元素
				const col = document.querySelector('[class*="_sidebarCol"]');
				if (col !== null) {
					const base = col.getBoundingClientRect();
					const x = Math.round(base.left + 10);
					const scan = [];
					let last = "";
					for (let y = Math.round(base.top) + 2; y < Math.round(base.bottom) - 2; y += 24) {
						const el = document.elementFromPoint(x, y);
						const stack = el === null ? [] : layersOf(el, 6);
						const key = JSON.stringify(stack);
						if (key !== last) {
							scan.push({ y: y - Math.round(base.top), stack });
							last = key;
						}
					}
					add({ sidebarScan: scan.slice(0, 24) });
					const painted = [];
					const walk = (el, d) => {
						if (el === null || d > 12) return;
						const cs = getComputedStyle(el);
						const r = el.getBoundingClientRect();
						const hasBg = (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") || (cs.backgroundImage && cs.backgroundImage !== "none");
						if (hasBg && r.width > 30) {
							painted.push({
								d,
								tag: el.tagName,
								cls: classNameOf(el),
								slot: el.getAttribute("data-slot") || "",
								bg: cs.backgroundColor,
								img: cs.backgroundImage === "none" ? "" : cs.backgroundImage.slice(0, 60),
								top: Math.round(r.top - base.top),
								h: Math.round(r.height),
								opacity: cs.opacity
							});
						}
						for (const child of el.children) walk(child, d + 1);
					};
					walk(col, 0);
					add({ sidebarPainted: painted.slice(0, 40) });
				}

				// ② 侧栏底部（footer）单独看一眼：这一段的底色历来和列表区不同
				const foot = document.querySelector('[class$="_footArea"]');
				if (foot !== null) {
					const fr = foot.getBoundingClientRect();
					add({
						footArea: {
							top: Math.round(fr.top),
							h: Math.round(fr.height),
							layers: layersOf(foot, 4),
							children: [...foot.children].map((el) => {
								const r = el.getBoundingClientRect();
								return { cls: classNameOf(el), slot: el.getAttribute("data-slot") || "", top: Math.round(r.top), h: Math.round(r.height) };
							}),
							aaRows: [...foot.querySelectorAll("[data-aa-row]")].map((el) => ({ row: el.getAttribute("data-aa-row"), label: (el.textContent || "").trim().slice(0, 14) }))
						}
					});
				}

				// ③ 覆盖层自身 + 几何核对（目录名/文件名/标题是否同列）
				const overlayEl = document.querySelector(".dsh-wsf-overlay");
				if (overlayEl !== null) {
					const cs = getComputedStyle(overlayEl);
					const r = overlayEl.getBoundingClientRect();
					add({ overlay: { bg: cs.backgroundColor, img: cs.backgroundImage.slice(0, 60), top: Math.round(r.top), h: Math.round(r.height), open: overlayEl.getAttribute("data-wsf-open") } });
					const geometry = { head: null, rows: [] };
					const titleEl = overlayEl.querySelector(".dsh-wsf-head-title");
					if (titleEl !== null) {
						const tr = titleEl.getBoundingClientRect();
						const tcs = getComputedStyle(titleEl);
						geometry.head = { x: Math.round(tr.left), h: Math.round(tr.height), fs: tcs.fontSize, fw: tcs.fontWeight, text: (titleEl.textContent || "").slice(0, 12) };
					}
					for (const row of [...overlayEl.querySelectorAll(".dsh-wsf-row")].slice(0, 8)) {
						const nameEl = row.querySelector(".dsh-wsf-name");
						geometry.rows.push({
							depth: row.getAttribute("data-depth"),
							kind: row.classList.contains("dsh-wsf-file") ? "file" : "dir",
							pad: getComputedStyle(row).paddingLeft,
							name: nameEl === null ? null : Math.round(nameEl.getBoundingClientRect().left),
							icos: [...row.querySelectorAll(".dsh-wsf-ico")].map((icon) => Math.round(icon.getBoundingClientRect().left))
						});
					}
					add({ geometry });
				}

				try {
					window.localStorage.setItem("dsh-workspace-files:probeMeta", JSON.stringify({ n: parts.length, at: new Date().toISOString(), keys: parts.length }));
				} catch {}
				parts.forEach((text, index) => {
					try {
						window.localStorage.setItem("dsh-workspace-files:probe" + (index + 1), text);
					} catch {}
				});
				writeDiag({ probeParts: parts.length });
			} catch (error) {
				writeDiag({ probeError: String((error && error.message) || error).slice(0, 200) });
			}
		}

		/* ───────────────────────── apply ───────────────────────── */
		function apply(ctx) {
			ctxRef = ctx;
			injectStyle();

			// 一次性背景探针：开关为 "1" 的那次刷新里采一遍（侧栏铺色栈 / footer / 几何），
			// 采完立刻自毁开关，正常使用不会再跑。
			let probeArmed = false;
			try {
				probeArmed = window.localStorage.getItem(PROBE_KEY) === "1";
			} catch {}
			if (probeArmed) {
				try {
					window.localStorage.removeItem(PROBE_KEY);
				} catch {}
				setTimeout(() => {
					try {
						probeSurfaces();
						console.info("[dsh-workspace-files] 背景探针已写入 localStorage（dsh-workspace-files:probe*）");
					} catch (error) {
						console.warn("[dsh-workspace-files] 探针失败", error);
					}
				}, 1800);
			}

			// 取数：直接读 client 服务，**不注册任何 slot**（见上面 adopt 的注释）。
			// 服务可能晚于本插件就绪，所以走带退避重试的 adoptWithRetry；
			// 接上后立刻重新装饰一次 —— 那时 sessionIdForKey 才可能算得出来。
			const disposers = [];
			try {
				disposers.push(
					adoptWithRetry(
						"workspaces",
						(snapshot) => {
							// 实测 `workspaces.list` 是 object 而非数组 —— 先对 .list 再取一层 snapshot
							// （它若有 getSnapshot/getState 就是 store），拿到东西才用它，否则退回整体。
							const nested = snapshotOf(snapshot && snapshot.list);
							const fromNested = itemsOf(nested);
							const items = fromNested.length > 0 ? fromNested : itemsOf(snapshot);
							writeDiag({ workspacesProbe: { listType: typeof (snapshot && snapshot.list), nestedKeys: nested && typeof nested === "object" ? Object.keys(nested).slice(0, 10) : null, got: items.length } });
							// 订阅回调可能先于数据到达，别用空数组覆盖已有的
							const beforeCount = workspaces.length;
							if (items.length > 0 || workspaces.length === 0) workspaces = items;
							// 数据真的变了 → 清 sessionId 缓存 + 重建覆盖层（否则永远停在旧状态）
							if (workspaces.length !== beforeCount) {
								sessionIdCache.clear();
								remountOverlay();
								decorate();
							}
						},
						() => decorate()
					)
				);
				disposers.push(
					adoptWithRetry(
						"sessions",
						(snapshot) => {
							// 同上：sessions.list 也是 object，先深挖一层
							const nestedSessions = snapshotOf(snapshot && snapshot.list);
							const fromNestedSessions = sessionRecordsOf(nestedSessions);
							const records = Object.keys(fromNestedSessions).length > 0 ? fromNestedSessions : sessionRecordsOf(snapshot);
							writeDiag({ sessionsProbe: { listType: typeof (snapshot && snapshot.list), nestedKeys: nestedSessions && typeof nestedSessions === "object" ? Object.keys(nestedSessions).slice(0, 10) : null, got: Object.keys(records).length } });
							const beforeSessions = Object.keys(sessionsById).length;
							if (Object.keys(records).length > 0 || beforeSessions === 0) sessionsById = records;
							if (Object.keys(sessionsById).length !== beforeSessions) {
								sessionIdCache.clear();
								remountOverlay();
								decorate();
							}
							const current = currentIdOf(snapshot);
							if (current !== null) currentSessionId = current;
						},
						() => decorate()
					)
				);
			} catch (error) {
				console.warn("[dsh-workspace-files] 取数失败", error);
			}
			ctx.effect(() => () => {
				for (const dispose of disposers) dispose();
			});

			// DOM 变化（会话增删、工作区切换）后重新装饰；批处理避免抖动
			let scheduled = false;
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				requestAnimationFrame(() => {
					scheduled = false;
					try {
						decorate();
					} catch (error) {
						console.warn("[dsh-workspace-files] decorate 失败", error);
					}
				});
			};

			const observer = new MutationObserver(schedule);
			observer.observe(document.body, { childList: true, subtree: true });
			ctx.effect(() => () => observer.disconnect());

			// 等宿主把 hook 灌进来后再第一次装饰
			waitFrames(3).then(schedule);
			schedule();

			// 自诊断入口：控制台里 `__dshWorkspaceFiles()` 看插件看到了什么
			try {
				window.__dshWorkspaceFiles = () => ({
					openKey,
					lastMenuAction,
					hostRoute: FS_ROUTE,
					resolveAttempts,
					retryPending: resolveTimer !== 0,
					workspacesSeen: workspaces.length,
					sessionsSeen: Object.keys(sessionsById).length,
					projectRows: document.querySelectorAll(ROW_SEL).length,
					sessionRows: document.querySelectorAll(SESSION_SEL).length,
					overlay: overlay === null ? null : { key: overlay.key, sessionId: overlay.sessionId, open: overlay.el.getAttribute("data-wsf-open") === "1", attached: overlay.el.isConnected },
					services: {
						workspaces: (() => {
							try {
								const s = ctxRef && ctxRef.get ? ctxRef.get("workspaces") : undefined;
								return s === undefined ? "缺失" : Object.keys(s).slice(0, 12).join(",") || typeof s;
							} catch {
								return "取数异常";
							}
						})(),
						sessions: (() => {
							try {
								const s = ctxRef && ctxRef.get ? ctxRef.get("sessions") : undefined;
								return s === undefined ? "缺失" : Object.keys(s).slice(0, 12).join(",") || typeof s;
							} catch {
								return "取数异常";
							}
						})()
					},
					remote: (() => {
						try {
							const r = remote();
							if (r === null) return "缺失（ctx.remote 与 ctx.get(\"remote\") 都拿不到）";
							const ns = r.workspaceFiles;
							return ns === undefined || ns === null
								? "拿到了 remote，但没有 workspaceFiles 命名空间"
								: { list: typeof ns.list, keys: Object.keys(ns).slice(0, 8) };
						} catch (error) {
							return "取数异常: " + String(error && error.message);
						}
					})(),
					sample: workspaces.slice(0, 2),
					sessionSample: Object.keys(sessionsById).slice(0, 3),
					currentSessionId,
					sessionsShape: (() => {
						try {
							const s = ctxRef && ctxRef.get ? ctxRef.get("sessions") : undefined;
							if (s === undefined) return "服务缺失";
							const snap = snapshotOf(s);
							return snap && typeof snap === "object" ? Object.keys(snap).slice(0, 16) : typeof snap;
						} catch (error) {
							return "取数异常: " + String(error && error.message);
						}
					})(),
					firstSessionKeys: (() => {
						const first = Object.values(sessionsById)[0];
						return first && typeof first === "object" ? Object.keys(first).slice(0, 24) : null;
					})(),
				});
			} catch {}
		}

		exports.name = "dsh-workspace-files";
		// **必须**声明 remote.workspaceFiles：cordis 会拦截对未声明服务的属性访问，
		// 实测报错 `cannot get property "remote.workspaceFiles" without inject` ——
		// 缺这一项连文件接口都碰不到（这是"所有工作区都看不到文件"的直接原因）。
		// 官方 dsh-api-workspace-files 的 client 半边同样是
		// `inject = ['resources', 'remote', 'remote.workspaceFiles']`。
		// `remote.session` 是右键菜单用的第二个命名空间（openWorkspacePath /
		// workspacePathApplications —— 在访达中显示、打开方式列表），
		// 官方 `dsh-client-ui-open-in-app` 同样在 inject 里声明它。
		exports.inject = ["remote.workspaceFiles", "remote.session"];
		exports.apply = apply;
		return module.exports;
	}
});
