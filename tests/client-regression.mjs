#!/usr/bin/env node
// dsh-workspace-files 回归断言 —— 离线跑，不开浏览器、不启 DSH。
//
//   node tests/client-regression.mjs
//
// 两类断言：
//   A. 结构断言：把 lib/client.js 当文本，检查「热更新 / 对齐 / 动画」这些关键实现
//      没有被后续改动悄悄删掉（每一条都对应一次真实的返工）。
//   B. 行为断言：用括号匹配把源码里的**真实纯函数**截出来 eval（桩注入 isDir），
//      真跑一遍排序与「内容未变」判等。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// host 半边的纯函数（校验/避让名/边界）：直接 import —— 它没有顶层副作用。
import { nameProblem, pathProblem, protectedProblem, trashNameFor, withinRoot } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let pass = 0;
const failures = [];
function check(name, ok, detail) {
	if (ok) {
		pass += 1;
		return;
	}
	failures.push(detail === undefined ? name : `${name} —— ${detail}`);
}

/* ── A. 结构断言 ───────────────────────────────────────────── */
check("缩进步进 = 图标列周期（20px）", src.includes("calc(6px + var(--wsf-depth,0) * 20px)"));
check("文件行占位类存在且不可见", src.includes(".dsh-wsf-ico-empty{visibility:hidden}"));
check("旧的 depth 1–4 硬编码已删除", !src.includes('data-depth=\\"1\\"]{padding-left:18px'));
check("FileNode 挂了占位图标", src.includes('className: "dsh-wsf-ico dsh-wsf-ico-empty"'));
check(
	"切换/展开 keyframes 五段齐全",
	["overlay-in", "overlay-out", "list-out", "list-in", "grow"].every((n) => src.includes(`@keyframes dsh-wsf-${n}`))
);
check("减少动效时动画被强制关掉", src.includes("animation:none !important"));
check("标题 13px / 600（与工作区行同级）", src.includes("font-size:13px;font-weight:600;line-height:18px"));
check("返回按钮是 22×22 轻量块（不再是 40×24 大灰块）", src.includes("width:22px;height:22px;margin:0 2px 0 0"));
check("返回箭头与 chevron 同几何（墨迹区间都是 x∈[6,10]）", src.includes('ICON_CHEVRON_LEFT = "M10 4.5 6 8.5 10 12.5"'));
check(
	"头部第 2 格 = 工作区文件夹图标（填住目录行的 folder 列，头部因此不再有一段莫名空白）",
	src.includes('className: "dsh-wsf-head-ico"') &&
		src.includes(".dsh-wsf-head-ico{flex:none;display:grid;place-items:center;width:14px;height:14px;margin:0 6px 0 0")
);
check("头部三格与行结构同构（2 + 22 + 2 + 14 + 6 = 46，标题仍在名字列）", src.includes("min-height:28px;padding:0 8px 0 2px"));

check("listDir 支持 force 绕过缓存", src.includes("async function listDir(sessionId, path, signal, opts)") && src.includes("const force = !!(opts && opts.force);"));
check("缓存带 TTL", src.includes("DIR_CACHE_TTL_MS") && src.includes("Date.now() - hit.at < DIR_CACHE_TTL_MS"));
check("失败计数 + 退避上限", src.includes("REFRESH_FAIL_LIMIT") && src.includes("dirFail"));
check("轮询 tick 由可见性驱动", src.includes("setInterval(") && src.includes("REFRESH_INTERVAL_MS") && src.includes("visibilitychange"));
check("内容未变时不 setState", src.includes("sameEntries(prev, value.entries) ? prev : value.entries"));
check("「刷新」只清本会话缓存", src.includes("function invalidateSession(sessionId)") && src.includes("invalidateSession(sessionId);"));
check("刷新后不误清展开态（容忍窗口）", src.includes("OPEN_MISS_GRACE_MS") && src.includes("if (rows.length === 0) return;"));
check(
	"解析不出会话根时不锁定渲染（指数退避重试、异常也继续排）",
	src.includes("const unresolved = resolved.sessionId === null") &&
		src.includes("function scheduleResolveRetry(key)") &&
		src.includes("RESOLVE_RETRY_MAX_MS") &&
		/writeDiag\(\{ resolveRetryError:[\s\S]{0,160}scheduleResolveRetry\(key\)/.test(src)
);
check("错误态带「重试」按钮（走 retryResolve）", src.includes("function retryResolve(key)") && src.includes("onRetry: () => retryResolve(key)"));
check(
	"解析失败时两处缓存都清（ov.sessionId 与 sessionIdCache，缺一个就把失败钉死）",
	src.includes("sessionIdCache.delete(key);") && /unresolved[\s\S]{0,700}ov\.sessionId = null;[\s\S]{0,80}sessionIdCache\.delete\(key\);/.test(src)
);
check("退出动画播完才拆 DOM", src.includes("SWITCH_ANIM_MS + 20") && src.includes("disposeOverlay(ov)"));
check("探针默认关闭（PROBE_KEY 开关）", src.includes('probeArmed = window.localStorage.getItem(PROBE_KEY) === "1"'));

/* ── B. 行为断言：截取真实实现来跑 ─────────────────────────── */
/** 从源码里按大括号匹配截出 `function <name>(…) { … }` 的完整文本。 */
function extractFunction(text, name) {
	const head = text.indexOf(`function ${name}(`);
	if (head < 0) throw new Error(`找不到函数 ${name}`);
	const open = text.indexOf("{", head);
	let depth = 0;
	for (let i = open; i < text.length; i += 1) {
		const ch = text[i];
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(head, i + 1);
		}
	}
	throw new Error(`${name} 的大括号不闭合`);
}

const isDirStub = (entry) => entry.type === "directory" || entry.type === "dir" || entry.isDirectory === true;

// 截出来的函数会引用 client.js 里那几个模块级常量 —— 用 with 把它们塞进作用域。
// （new Function 的函数体是非严格模式，with 可用；ESM 本体的严格模式管不到它。）
const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };
const CHAPTER_RE = /第\s*([0-9]+|[〇零一二两三四五六七八九十百千万]+)\s*[章节回卷幕话集部篇场]/;
const CHAPTER_BEFORE_RE = /^(序章|楔子|引子|序|前言|开篇|自序)/;
const CHAPTER_AFTER_RE = /^(终章|尾声|后记|大结局|完结|番外|外传|特别篇)/;
const TAIL_ORDER = { 上: 1, 前: 1, 中: 2, 下: 3, 后: 3, 末: 4 };

const scope = { CN_DIGITS, CN_UNITS, CHAPTER_RE, CHAPTER_BEFORE_RE, CHAPTER_AFTER_RE, TAIL_ORDER, isDir: isDirStub };
const runner = new Function(
	"scope",
	`with (scope) {
		 ${extractFunction(src, "sameEntries")}
		 ${extractFunction(src, "parseCnNumber")}
		 ${extractFunction(src, "tailKey")}
		 ${extractFunction(src, "chapterKeyOf")}
		 ${extractFunction(src, "smartCompareNames")}
		 ${extractFunction(src, "sortEntries")}
		 return { sameEntries, sortEntries, smartCompareNames, parseCnNumber };
	 }`,
);
const fn = runner(scope);

// B1. sameEntries：顺序无关、增删敏感、目录/文件类型敏感
const dirEntry = (name) => ({ name, type: "directory" });
const fileEntry = (name) => ({ name, type: "file" });
check(
	"sameEntries：同集合不同顺序 = 未变",
	fn.sameEntries([dirEntry("a"), fileEntry("b.txt")], [fileEntry("b.txt"), dirEntry("a")]) === true
);
check("sameEntries：多一条 = 变了", fn.sameEntries([dirEntry("a")], [dirEntry("a"), dirEntry("b")]) === false);
check("sameEntries：同名但从目录变文件 = 变了", fn.sameEntries([dirEntry("x")], [fileEntry("x")]) === false);
check("sameEntries：null 首次 = 变了", fn.sameEntries(null, [dirEntry("a")]) === false);

// B2. sortEntries：目录优先 + 章号数值序（不因字符码位错排）
const sorted = fn.sortEntries([
	fileEntry("第三章.md"),
	dirEntry("chapters"),
	fileEntry("第十章.md"),
	fileEntry("第二章.md"),
]);
check(
	"sortEntries：目录在最前、章号按数值升序",
	JSON.stringify(sorted.map((e) => e.name)) === JSON.stringify(["chapters", "第二章.md", "第三章.md", "第十章.md"]),
	JSON.stringify(sorted.map((e) => e.name))
);

// B3. 中文数字解析（回归用）
check("parseCnNumber：二十一 = 21", fn.parseCnNumber("二十一") === 21);
check("parseCnNumber：一百零五 = 105", fn.parseCnNumber("一百零五") === 105);

/* ── C. 右键菜单（v0.5.0）结构断言 ─────────────────────────── */
check(
	"挂官方 primitives 的 Menu 组件（且组件缺失时降级不崩）",
	src.includes('require("@deepseek-ai/dsh-client-ui-primitives")') && src.includes('const Menu = typeof primitives.Menu === "function" ? primitives.Menu : null;')
);
check("菜单走 portal（不被侧栏 overflow 裁剪）", src.includes("portal: true") && src.includes("className: MENU_ANCHOR_CLASS"));
check("菜单锚点 = 鼠标坐标（getAnchorRect）", src.includes("getAnchorRect: () => (menu === null ? null : anchorRectAt(menu.x, menu.y))"));
check("右键入口同时挂在目录行与文件行", (src.match(/onContextMenu: \(event\) => onMenu\(event,/g) || []).length === 2);
check("编辑态的行从 button 换成 div（button 里不能嵌 input）", src.includes('? h("div", rowProps, cells)') && src.includes('return editing'));
check("重命名输入框：Enter 提交 / Escape 取消", src.includes("function renameInput(edit)") && src.includes('if (event.key === "Enter")'));
check("Enter 与 blur 只提交一次（editActive ref 去重）", src.includes("const editActive = React.useRef(null);") && src.includes("const finishRename = (commit) => {"));
check("新建按钮用 onMouseDown preventDefault 抢在 blur 卸载前提交", src.includes("onMouseDown: (event) => event.preventDefault()"));
check("Menu 外壳用 display:contents 摘出 flex 布局", src.includes(".dsh-wsf-menu-anchor{display:contents}"));
check("写操作走插件自己的 host 路由", src.includes('const FS_ROUTE = "/dsh-workspace-files/fs"') && src.includes("await fetch(FS_ROUTE"));
check("inject 同时声明 remote.workspaceFiles 与 remote.session", src.includes('exports.inject = ["remote.workspaceFiles", "remote.session"]'));
check("写操作成功后立刻刷新整棵树（不等 3 秒轮询）", src.includes("const refreshNow = () =>") && src.includes("refreshNow();"));
check("删除是危险行（danger）", src.includes('{ id: "trash", label: "移到废纸篓", danger: true }'));
check("空白处右键 = 工作区根菜单（不误触行与按钮）", src.includes("onBlankContextMenu") && src.includes('closest(".dsh-wsf-row")'));

/* ── D. 行为断言：右键菜单与 host 校验 ─────────────────────── */
const menuRunner = new Function(
	"scope",
	`with (scope) {
		 ${extractFunction(src, "joinPath")}
		 ${extractFunction(src, "parentPathOf")}
		 ${extractFunction(src, "anchorRectAt")}
		 ${extractFunction(src, "openWithSubmenu")}
		 ${extractFunction(src, "buildMenuItems")}
		 return { joinPath, parentPathOf, anchorRectAt, openWithSubmenu, buildMenuItems };
	 }`,
);
const wsf = menuRunner({ h: (tag, props, ...kids) => ({ tag, props, kids }) });

check("joinPath：根带尾斜杠不产生双斜杠", wsf.joinPath("/Users/x/我的小说/", "第一卷/第3章.md") === "/Users/x/我的小说/第一卷/第3章.md");
check("joinPath：空 rel 返回根本身", wsf.joinPath("/Users/x/我的小说", "") === "/Users/x/我的小说");
check("joinPath：相对根（拿不到 cwd）退化为相对路径", wsf.joinPath("", "a.md") === "a.md");
check("parentPathOf：取所在目录", wsf.parentPathOf("第一卷/第3章.md") === "第一卷");
check("parentPathOf：根下的条目 → 空串", wsf.parentPathOf("readme.md") === "" && wsf.parentPathOf("第一卷/") === "");

const fileIds = wsf.buildMenuItems({ kind: "file", rel: "第一卷/第3章.md", name: "第3章.md" }, null).map((e) => e.id);
check(
	"文件菜单：预览 / 默认应用 / 打开方式 / 访达 / 终端 / 复制三项 / 重命名 / 删除都在",
	["preview", "openDefault", "openWith", "reveal", "terminal", "copyAbs", "copyRel", "copyName", "rename", "trash"].every((id) => fileIds.includes(id))
);
const dirIds = wsf.buildMenuItems({ kind: "dir", rel: "第一卷", name: "第一卷" }, null).map((e) => e.id);
check(
	"目录菜单：有新建两项、无「用默认应用打开」与「打开方式」",
	dirIds.includes("newFile") && dirIds.includes("newDir") && !dirIds.includes("openDefault") && !dirIds.includes("openWith") && dirIds.includes("copyName")
);
const blankIds = wsf.buildMenuItems({ kind: "blank", rel: "", name: "我的小说" }, null).map((e) => e.id);
check(
	"空白菜单：能新建，但没有重命名/删除（工作区根不能从这里动）",
	blankIds.includes("newFile") && blankIds.includes("newDir") && !blankIds.includes("rename") && !blankIds.includes("trash")
);
const submenuItem = wsf.buildMenuItems({ kind: "file", rel: "a.md", name: "a.md" }, null).find((e) => e.id === "openWith");
check("打开方式：子菜单在未加载时是禁用占位（不空着）", Array.isArray(submenuItem.submenu) && submenuItem.submenu[0].disabled === true);
const appsReady = wsf.openWithSubmenu({ state: "ready", list: [{ id: "typora", name: "Typora", default: true, icon: "data:image/png;base64," }] });
check("打开方式：拿到列表后为 apps:<id>，并标出默认项", appsReady.length === 1 && appsReady[0].id === "apps:typora" && appsReady[0].label.includes("默认"));
check(
	"打开方式：查询失败（空表）也给可读占位",
	wsf.openWithSubmenu({ state: "ready", list: [] })[0].disabled === true && wsf.openWithSubmenu({ state: "loading", list: [] })[0].label.includes("载入")
);
const rect = wsf.anchorRectAt(12, 34);
check("菜单锚点矩形落在鼠标坐标上（DOMRect 缺失时走对象兜底）", rect.left === 12 && rect.top === 34);

check("名字校验：正常中文文件名通过", nameProblem("第二章 风起.md") === null && nameProblem("（上）") === null);
check(
	"名字校验：空 / 路径分隔符 / . / .. / 超长都被拒",
	["", "a/b", "a\\b", ".", "..", "x".repeat(300)].every((bad) => typeof nameProblem(bad) === "string")
);
check(
	"路径校验：相对路径与 .. 回溯被拒、绝对路径通过",
	typeof pathProblem("a/b") === "string" && typeof pathProblem("/a/../b") === "string" && pathProblem("/Users/x/我的小说/第3章.md") === null
);
check(
	"保护名单：文件系统根 / 主目录 / 废纸篓自身被拒，普通文件放行",
	typeof protectedProblem("/", "/Users/x") === "string" &&
		typeof protectedProblem("/Users/x", "/Users/x") === "string" &&
		typeof protectedProblem("/Users/x/.Trash", "/Users/x") === "string" &&
		protectedProblem("/Users/x/Documents/a.md", "/Users/x") === null
);
check(
	"废纸篓避让：空篓用原名，占用则 name 2.ext / name 3.ext（Finder 同款）",
	trashNameFor("a.txt", new Set()) === "a.txt" &&
		trashNameFor("a.txt", new Set(["a.txt"])) === "a 2.txt" &&
		trashNameFor("a.txt", new Set(["a.txt", "a 2.txt"])) === "a 3.txt" &&
		trashNameFor("第一卷", new Set(["第一卷"])) === "第一卷 2"
);
check("工作区边界：同前缀的不同目录不算在内", withinRoot("/a/b", "/a/b/c") === true && withinRoot("/a/b", "/a/b") === true && withinRoot("/a/b", "/a/bc") === false);

/* ── 结果 ─────────────────────────────────────────────────── */
if (failures.length > 0) {
	console.error(`✗ ${failures.length} 项失败（通过 ${pass} 项）：`);
	for (const item of failures) console.error("   -", item);
	process.exit(1);
}
console.log(`✓ 全部通过：${pass} 项断言`);
