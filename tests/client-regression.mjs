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
check("返回按钮 40px 宽、图标靠左（与箭头列同心）", src.includes("place-items:center start;width:40px;height:24px;margin-left:6px"));

check("listDir 支持 force 绕过缓存", src.includes("async function listDir(sessionId, path, signal, opts)") && src.includes("const force = !!(opts && opts.force);"));
check("缓存带 TTL", src.includes("DIR_CACHE_TTL_MS") && src.includes("Date.now() - hit.at < DIR_CACHE_TTL_MS"));
check("失败计数 + 退避上限", src.includes("REFRESH_FAIL_LIMIT") && src.includes("dirFail"));
check("轮询 tick 由可见性驱动", src.includes("setInterval(") && src.includes("REFRESH_INTERVAL_MS") && src.includes("visibilitychange"));
check("内容未变时不 setState", src.includes("sameEntries(prev, value.entries) ? prev : value.entries"));
check("「刷新」只清本会话缓存", src.includes("function invalidateSession(sessionId)") && src.includes("invalidateSession(sessionId);"));
check("刷新后不误清展开态（容忍窗口）", src.includes("OPEN_MISS_GRACE_MS") && src.includes("if (rows.length === 0) return;"));
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

/* ── 结果 ─────────────────────────────────────────────────── */
if (failures.length > 0) {
	console.error(`✗ ${failures.length} 项失败（通过 ${pass} 项）：`);
	for (const item of failures) console.error("   -", item);
	process.exit(1);
}
console.log(`✓ 全部通过：${pass} 项断言`);
