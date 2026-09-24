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
//   5. 展开状态存 localStorage 并跨刷新恢复；目录列表带缓存。
//
// 改本文件后**必须重启 host 进程**（client bundle 在启动时读进内存，刷新页面无效）。

window.__ModuleLoader__.load({
	id: "dsh-workspace-files",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const ReactDOMClient = require("react-dom/client");
		const h = React.createElement;

		/* ───────────────────────── 常量 ───────────────────────── */
		const STYLE_ID = "dsh-workspace-files-style";
		const OPEN_KEY = "dsh-workspace-files:open"; // 当前展开文件树的工作区 key
		const ROW_SEL = '[class*="_projectRow"]'; // 工作区标题行
		const SESSION_SEL = '[class*="_sessionRow"]'; // 会话行
		const BTN_MARK = "data-wsf-btn";
		const PANEL_MARK = "data-wsf-panel";
		const HIDDEN_MARK = "data-wsf-hidden";
		const ROOT_PATH = ""; // 工作区相对路径的根
		/** 列目录超时：Remote 挂着不返回时，宁可报错也别永远停在「载入中」。 */
		const LIST_TIMEOUT_MS = 8000;
		const ICON_DIR =
			'M3.5 5.5h4l1.5 2h7.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z';
		const ICON_CHEVRON = "M6 4.5 10 8.5 6 12.5";
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
		const dirCache = new Map(); // `${sessionId}\0${path}` -> { entries, truncated }
		/**
		 * key → sessionId 的解析结果缓存。
		 * 关键：DOM 挖掘（扫会话行属性里的长数字）**每次可能给出不同的值**，
		 * 不缓存的话 openPanel 每轮 decorate 都会带着新 sessionId 重新 render，
		 * FileTree 的 effect 就会反复重跑 + abort，永远停在「载入中」。
		 */
		const sessionIdCache = new Map();
		const panels = new Map(); // projectRow 元素 -> { node, root }

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

		/* ───────────────────────── 数据层 ───────────────────────── */
		async function listDir(sessionId, path, signal) {
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
			const cacheKey = sessionId + "\u0000" + path;
			if (dirCache.has(cacheKey)) return dirCache.get(cacheKey);
			const tag = String(sessionId).slice(0, 12);
			console.info("[dsh-workspace-files] list →", { sessionId: tag, path: JSON.stringify(path) });
			let timer = null;
			const timeout = new Promise((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("列目录超时（" + LIST_TIMEOUT_MS + "ms 无响应）—— sessionId=" + tag + " path=" + JSON.stringify(path))),
					LIST_TIMEOUT_MS
				);
			});
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
				dirCache.set(cacheKey, value);
				return value;
			} finally {
				if (timer !== null) clearTimeout(timer);
			}
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
		function ensureData() {
			if (workspaces.length > 0 && Object.keys(sessionsById).length > 0) return;
			try {
				const wsService = ctxRef && typeof ctxRef.get === "function" ? ctxRef.get("workspaces") : undefined;
				const ssService = ctxRef && typeof ctxRef.get === "function" ? ctxRef.get("sessions") : undefined;
				if (workspaces.length === 0) {
					const items = itemsOf(snapshotOf(wsService && wsService.list));
					if (items.length > 0) workspaces = items;
				}
				if (Object.keys(sessionsById).length === 0) {
					const records = sessionRecordsOf(snapshotOf(ssService && ssService.list));
					if (Object.keys(records).length > 0) sessionsById = records;
				}
				const current = currentIdOf(snapshotOf(ssService));
				if (current !== null) currentSessionId = current;
				writeDiag({ ensureData: { workspaces: workspaces.length, sessions: Object.keys(sessionsById).length } });
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
			//     所以扫该工作区名下会话行（及一层后代）的属性值，找 UUID / 长十六进制串。
			const fromDom = sessionIdFromDom(row);
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
		 */
		function sessionIdFromDom(row) {
			if (row === null || row === undefined) return null;
			const ID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}/i;
			const scan = (element) => {
				if (element === null || element === undefined || element.attributes === undefined) return null;
				for (const attribute of element.attributes) {
					const match = ID_RE.exec(String(attribute.value));
					if (match !== null) return match[0];
				}
				return null;
			};
			const groups = groupSessionRows();
			const sessionRows = groups.get(row) ?? [];
			for (const sessionRow of sessionRows) {
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

		/* ───────────────────────── 文件树 ───────────────────────── */
		function DirNode({ sessionId, path, name, depth, onOpenFile }) {
			const [expanded, setExpanded] = React.useState(false);
			const [state, setState] = React.useState({ kind: "idle" });

			React.useEffect(() => {
				if (!expanded || state.kind === "ready") return undefined;
				const controller = new AbortController();
				setState({ kind: "loading" });
				listDir(sessionId, path, controller.signal).then(
					(value) => setState({ kind: "ready", entries: value.entries, truncated: value.truncated }),
					(error) => {
						if (controller.signal.aborted) return;
						setState({ kind: "failed", message: String((error && error.message) || error) });
					}
				);
				return () => controller.abort();
			}, [expanded, sessionId, path, state.kind]);

			const children = [];
			if (expanded) {
				if (state.kind === "loading") children.push(h("div", { key: "ld", className: "dsh-wsf-note" }, "载入中…"));
				else if (state.kind === "failed") children.push(h("div", { key: "er", className: "dsh-wsf-note dsh-wsf-note-error" }, state.message));
				else if (state.kind === "ready") {
					const entries = state.entries.slice().sort((a, b) => (isDir(b) ? 1 : 0) - (isDir(a) ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
					if (entries.length === 0) children.push(h("div", { key: "em", className: "dsh-wsf-note" }, "（空目录）"));
					for (const entry of entries) {
						const childPath = path.replace(/[/\\]+$/, "") + "/" + entry.name;
						children.push(
							isDir(entry)
								? h(DirNode, { key: childPath, sessionId, path: childPath, name: entry.name, depth: depth + 1, onOpenFile })
								: h(FileNode, { key: childPath, path: childPath, name: entry.name, depth: depth + 1, onOpenFile })
						);
					}
					if (state.truncated) children.push(h("div", { key: "tr", className: "dsh-wsf-note" }, "（已截断，仅显示部分条目）"));
				}
			}

			return h(
				"div",
				{ className: "dsh-wsf-group" },
				h(
					"button",
					{ type: "button", className: "dsh-wsf-row", "data-depth": depth, "data-open": expanded ? "1" : "0", onClick: () => setExpanded((v) => !v), title: path },
					h(
						"span",
						{ className: "dsh-wsf-ico", "data-kind": "dir", "aria-hidden": true },
						h("svg", { width: 14, height: 14, viewBox: "0 0 20 20", fill: "none" }, h("path", { d: ICON_CHEVRON, stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" }))
					),
					h(
						"span",
						{ className: "dsh-wsf-ico", "data-kind": "folder", "aria-hidden": true },
						h("svg", { width: 14, height: 14, viewBox: "0 0 20 20", fill: "none" }, h("path", { d: ICON_DIR, stroke: "currentColor", strokeWidth: 1.4, strokeLinejoin: "round" }))
					),
					h("span", { className: "dsh-wsf-name" }, name)
				),
				children.length > 0 ? h("div", { className: "dsh-wsf-children" }, children) : null
			);
		}

		function FileNode({ path, name, depth, onOpenFile }) {
			return h(
				"button",
				{ type: "button", className: "dsh-wsf-row dsh-wsf-file", "data-depth": depth, onClick: () => onOpenFile(path), title: path },
				h("span", { className: "dsh-wsf-ico", "data-kind": "file", "aria-hidden": true }, h("svg", { width: 14, height: 14, viewBox: "0 0 20 20", fill: "none" }, h("path", { d: "M5.5 3.5h6l3 3v10h-9Z", stroke: "currentColor", strokeWidth: 1.4, strokeLinejoin: "round" }))),
				h("span", { className: "dsh-wsf-name" }, name)
			);
		}

		function FileTree(props) {
			const { sessionId, root } = props;
			const [state, setState] = React.useState({ kind: "loading" });
			// 换一个值就能真正重跑下面的 effect（清缓存重载用）
			const [tick, setTick] = React.useState(0);

			React.useEffect(() => {
				if (root === null || root === undefined || root === "") {
					setState({ kind: "failed", message: "拿不到该会话的工作目录（cwd）—— list 的 path 必须是绝对路径。\n" + diagnose() });
					return undefined;
				}
				if (sessionId === null || sessionId === undefined || sessionId === "") {
					setState({ kind: "failed", message: diagnose() });
					return undefined;
				}
				const controller = new AbortController();
				setState({ kind: "loading" });
				listDir(sessionId, root, controller.signal).then(
					(value) => {
						if (controller.signal.aborted) return;
						setState({ kind: "ready", entries: value.entries, truncated: value.truncated });
					},
					(error) => {
						if (controller.signal.aborted) return;
						const message = String((error && error.message) || error);
						console.warn("[dsh-workspace-files] 文件树加载失败:", message);
						setState({ kind: "failed", message });
					}
				);
				return () => controller.abort();
			}, [sessionId, tick]);

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

			const head = h(
				"div",
				{ className: "dsh-wsf-head" },
				h("span", { className: "dsh-wsf-head-title" }, "文件"),
				h("button", { type: "button", className: "dsh-wsf-reload", title: "清缓存并重新载入", onClick: () => { dirCache.clear(); sessionIdCache.clear(); setTick((v) => v + 1); } }, "重新载入")
			);

			let body;
			if (state.kind === "loading") body = h("div", { className: "dsh-wsf-note" }, "载入中…");
			else if (state.kind === "failed") body = h("div", { className: "dsh-wsf-note dsh-wsf-note-error" }, state.message);
			else {
				const entries = state.entries.slice().sort((a, b) => (isDir(b) ? 1 : 0) - (isDir(a) ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
				body =
					entries.length === 0
						? h("div", { className: "dsh-wsf-note" }, "（空工作区）")
						: h(
								"div",
								{ className: "dsh-wsf-tree" },
								entries.map((entry) =>
									isDir(entry)
										? h(DirNode, { key: entry.name, sessionId, path: entry.name, name: entry.name, depth: 0, onOpenFile: openFile })
										: h(FileNode, { key: entry.name, path: entry.name, name: entry.name, depth: 0, onOpenFile: openFile })
								)
							);
			}

			return h("div", { className: "dsh-wsf-body" }, head, body);
		}

		/* ───────────────────────── DOM 注入 ───────────────────────── */
		function injectStyle() {
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		/** 按文档顺序把 sessionRow 归到它前面最近的 projectRow 名下。 */
		function groupSessionRows() {
			const groups = new Map();
			const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
			let current = null;
			let node = walker.nextNode();
			while (node !== null) {
				const cls = typeof node.className === "string" ? node.className : "";
				if (cls.indexOf("_projectRow") >= 0) {
					current = node;
					if (!groups.has(node)) groups.set(node, []);
				} else if (cls.indexOf("_sessionRow") >= 0 && current !== null) {
					groups.get(current).push(node);
				}
				node = walker.nextNode();
			}
			return groups;
		}

		function panelFor(row) {
			const existing = panels.get(row);
			if (existing !== undefined) return existing;
			let node = row.nextElementSibling;
			if (node === null || node.getAttribute(PANEL_MARK) !== "1") {
				node = document.createElement("div");
				node.setAttribute(PANEL_MARK, "1");
				node.className = "dsh-wsf-panel";
				row.insertAdjacentElement("afterend", node);
			}
			const root = ReactDOMClient.createRoot(node);
			const entry = { node, root };
			panels.set(row, entry);
			return entry;
		}

		function invalidateRenders() {
			for (const entry of panels.values()) {
				// 真正 unmount，而不是只清 renderedKey：
				// root.render() 传**相同 props** 时 React 不会重新执行 FileTree 的 effect，
				// 面板就会一直停在第一次那条「拿不到」的消息上（这次踩的正是这个坑）。
				try {
					entry.root.unmount();
				} catch {}
				entry.renderedKey = undefined;
				entry.renderedSessionId = undefined;
			}
		}
		function openPanel(row) {
			const key = keyOf(row);
			let sessionId = sessionIdCache.get(key);
			if (sessionId === undefined) {
				sessionId = sessionIdForKey(key, row);
				if (typeof sessionId === "string" && sessionId !== "") sessionIdCache.set(key, sessionId);
			}
			const entry = panelFor(row);
			entry.node.hidden = false;
			entry.node.setAttribute("data-wsf-key", key);
			// 同一个面板 + 同一个 sessionId 就不重渲染 —— 这是「永远载入中」的根治点：
			// 每次 decorate 都 render 一次会让 FileTree 反复 remount/abort。
			if (entry.renderedKey === key && entry.renderedSessionId === sessionId) return;
			entry.renderedKey = key;
			entry.renderedSessionId = sessionId;
			const resolved = sessionId === null || sessionId === undefined ? { sessionId: null, root: null } : rootFor(sessionId);
						entry.root.render(h(FileTree, { key, sessionId: resolved.sessionId, root: resolved.root }));
}

				function closePanel(row) {
					const entry = panels.get(row);
					if (entry === undefined) return;
					entry.root.unmount();
					entry.node.remove();
					panels.delete(row);
				}

		function applyOpenState() {
			const groups = groupSessionRows();
			for (const [row, sessionRows] of groups) {
				const key = keyOf(row);
				const isOpen = openKey !== null && key === openKey;
				// 该工作区下的会话行：展开文件树时隐藏
				for (const sessionRow of sessionRows) {
					// 只打属性标记，隐藏交给 CSS 规则（见上面的 data-wsf-hidden）
					if (isOpen) sessionRow.setAttribute(HIDDEN_MARK, "1");
					else if (sessionRow.getAttribute(HIDDEN_MARK) === "1") sessionRow.removeAttribute(HIDDEN_MARK);
				}
				if (isOpen) openPanel(row);
				else closePanel(row);
			}
		}

		/**
		 * 把一个工作区行的「当前视图状态」同步到 DOM：激活属性 + 按钮文案。
		 * 两种状态（会话列表 / 文件列表）在这一个按钮上切换，所以文案和 aria-pressed
		 * 要跟着变，用户才知道再点一次会回到哪边。
		 */
		function syncRow(row) {
			const active = openKey !== null && keyOf(row) === openKey;
			row.setAttribute("data-wsf-active", active ? "1" : "0");
			const button = row.querySelector(":scope > .dsh-wsf-toggle");
			if (button === null) return;
			const label = active ? "切换回会话列表" : "查看文件列表";
			button.title = label;
			button.setAttribute("aria-label", label);
			button.setAttribute("aria-pressed", active ? "true" : "false");
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
						openKey = openKey === key ? null : key;
						writeOpen(openKey);
						syncRow(row);
						applyOpenState();
					});
					row.appendChild(button);
				}
				syncRow(row);
			}
			applyOpenState();
		}

		/* ───────────────────────── 样式 ───────────────────────── */
		const CSS = [
			// 按钮：默认隐形，hover 工作区行时出现（与官方 chevron 同样的时机）
			".dsh-wsf-toggle{display:none;flex:none;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:none;border-radius:5px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
			ROW_SEL + ":hover .dsh-wsf-toggle{display:inline-flex}",
			".dsh-wsf-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			ROW_SEL + '[data-wsf-active="1"] .dsh-wsf-toggle{display:inline-flex;color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}',
			// 面板
			".dsh-wsf-panel{margin:2px 0 6px 0;padding:4px 0 2px;border-left:2px solid var(--dsw-alias-border-l1)}",
			".dsh-wsf-panel[hidden]{display:none}",
			// 会话行的隐藏只靠这条规则 + 属性标记：内联 style.display 会被官方
			// React 重渲染覆盖，属性标记则不会。
			'[data-wsf-hidden="1"]{display:none !important}',
			".dsh-wsf-body{display:flex;flex-direction:column;gap:1px;max-height:min(46vh,420px);overflow-y:auto;overscroll-behavior:contain}",
			".dsh-wsf-head{display:flex;align-items:center;gap:8px;padding:0 8px 4px 10px}",
			".dsh-wsf-head-title{flex:1;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}",
			".dsh-wsf-reload{flex:none;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l1);border-radius:5px;background:0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:pointer}",
			".dsh-wsf-reload:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-wsf-tree,.dsh-wsf-children{display:flex;flex-direction:column;gap:1px}",
			".dsh-wsf-row{display:flex;align-items:center;gap:6px;width:100%;min-height:26px;padding:0 8px 0 6px;border:none;border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;text-align:left;cursor:pointer}",
			".dsh-wsf-row:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-wsf-row[data-depth=\"1\"]{padding-left:18px}",
			".dsh-wsf-row[data-depth=\"2\"]{padding-left:30px}",
			".dsh-wsf-row[data-depth=\"3\"]{padding-left:42px}",
			".dsh-wsf-row[data-depth=\"4\"]{padding-left:54px}",
			'.dsh-wsf-ico{display:grid;place-items:center;flex:none;color:var(--dsw-alias-label-tertiary)}',
			'.dsh-wsf-ico[data-kind="folder"]{color:var(--dsw-alias-state-business-primary)}',
			'.dsh-wsf-row[data-open="0"] .dsh-wsf-ico[data-kind="dir"]{transform:rotate(0deg)}',
			'.dsh-wsf-row[data-open="1"] .dsh-wsf-ico[data-kind="dir"]{transform:rotate(90deg)}',
			".dsh-wsf-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-wsf-file .dsh-wsf-name{color:var(--dsw-alias-label-secondary)}",
			".dsh-wsf-note{padding:2px 10px;color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".dsh-wsf-note-error{color:var(--dsw-alias-state-warn-primary,var(--dsw-alias-label-tertiary));white-space:pre-line;line-height:1.6}",
			"@media (prefers-reduced-motion:reduce){.dsh-wsf-ico{transition:none}}",
			".dsh-wsf-ico{transition:transform .12s var(--ds-ease-in-out,ease)}"
		].join("");

		/* ───────────────────────── apply ───────────────────────── */
		function apply(ctx) {
			ctxRef = ctx;
			injectStyle();

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
							// 数据真的变了 → 清 sessionId 缓存 + 让面板重渲染（否则永远停在旧状态）
							if (workspaces.length !== beforeCount) {
								sessionIdCache.clear();
								invalidateRenders();
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
								invalidateRenders();
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
					workspacesSeen: workspaces.length,
					sessionsSeen: Object.keys(sessionsById).length,
					projectRows: document.querySelectorAll(ROW_SEL).length,
					sessionRows: document.querySelectorAll(SESSION_SEL).length,
					panels: panels.size,
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
		exports.inject = ["remote.workspaceFiles"];
		exports.apply = apply;
		return module.exports;
	}
});
