#!/usr/bin/env node
// dsh-workspace-files —— host 半边（写操作路由）的离线回归：真在临时目录里建/改/移文件，
// 不碰任何真实工作区，也不污染真实废纸篓（废纸篓用可注入的假 home）。
//
//   node tests/host-actions.mjs
//
// 覆盖：新建文件/文件夹、重命名、移到废纸篓（含同名避让）、以及三层安全边界的拒绝矩阵。
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEntry, renameEntry, runAction, trashNameFor, trashPath } from "../lib/index.js";

let pass = 0;
const failures = [];
function check(name, ok, detail) {
	if (ok) {
		pass += 1;
		return;
	}
	failures.push(detail === undefined ? name : `${name} —— ${detail}`);
}

/** 断言某个 async 调用以指定 code 拒绝。 */
async function rejects(name, promise, code) {
	try {
		await promise;
		check(name, false, "本该拒绝却成功了");
	} catch (error) {
		check(name, error && error.code === code, `code=${error && error.code} message=${error && error.message}`);
	}
}

const sandbox = await mkdtemp(join(tmpdir(), "wsf-host-"));
const workspace = join(sandbox, "workspace");
const outside = join(sandbox, "outside");
const fakeHome = join(sandbox, "home");
await mkdir(workspace, { recursive: true });
await mkdir(outside, { recursive: true });
await mkdir(join(fakeHome, ".Trash"), { recursive: true });
/** 假 ctx：只提供 workspaceRegistry（boundaryOf 用它列工作区根）。 */
const ctx = { get: (name) => (name === "workspaceRegistry" ? { list: () => [{ path: workspace }] } : undefined) };

try {
	/* ── 新建 ─────────────────────────────────────────────── */
	const created = await runAction(ctx, { action: "newFile", dir: workspace, name: "第二章 风起.md" });
	check("新建文件：落在目标目录里", created.path === join(workspace, "第二章 风起.md") && existsSync(created.path));
	check("新建文件：内容是空的", (await readFile(created.path, "utf8")) === "");
	await rejects("新建文件：同名已存在 → exists", runAction(ctx, { action: "newFile", dir: workspace, name: "第二章 风起.md" }), "exists");
	const dir = await runAction(ctx, { action: "newDir", dir: workspace, name: "第一卷" });
	check("新建文件夹：建成的是目录", existsSync(dir.path) && (await lstat(dir.path)).isDirectory());
	await rejects("新建：名字带路径分隔符 → bad-name", runAction(ctx, { action: "newFile", dir: workspace, name: "../逃逸.md" }), "bad-name");
	await rejects("新建：目录不存在 → not-found", runAction(ctx, { action: "newFile", dir: join(workspace, "没有这个目录"), name: "a.md" }), "not-found");

	/* ── 重命名 ───────────────────────────────────────────── */
	const renamed = await renameEntry(join(workspace, "第二章 风起.md"), "第3章 风起.md");
	check("重命名：旧名消失、新名出现", renamed.path === join(workspace, "第3章 风起.md") && existsSync(renamed.path) && !existsSync(join(workspace, "第二章 风起.md")));
	check("重命名：同名（不改变）返回 unchanged", (await renameEntry(join(workspace, "第3章 风起.md"), "第3章 风起.md")).unchanged === true);
	await writeFile(join(workspace, "占位.md"), "");
	await rejects("重命名：目标已存在 → exists（绝不覆盖）", renameEntry(join(workspace, "第3章 风起.md"), "占位.md"), "exists");
	await rejects("重命名：空名字 → bad-name", renameEntry(join(workspace, "占位.md"), "   "), "bad-name");

	/* ── 移到废纸篓（假 home，不碰真实 ~/.Trash）────────────── */
	const doomed = join(workspace, "要删的草稿.md");
	await writeFile(doomed, "草稿内容");
	const trashed = await trashPath(doomed, fakeHome);
	check(
		"废纸篓：原位置消失、内容进了假废纸篓",
		!existsSync(doomed) && trashed.trashed === join(fakeHome, ".Trash", "要删的草稿.md") && existsSync(trashed.trashed)
	);
	check("废纸篓：内容原样保留（可恢复）", (await readFile(trashed.trashed, "utf8")) === "草稿内容");
	const doomed2 = join(workspace, "要删的草稿.md");
	await writeFile(doomed2, "第二份");
	const trashed2 = await trashPath(doomed2, fakeHome);
	check("废纸篓：同名避让成「名字 2.ext」", trashed2.trashed === join(fakeHome, ".Trash", "要删的草稿 2.md") && existsSync(trashed2.trashed));
	await rejects("废纸篓：目标不存在 → not-found", trashPath(join(workspace, "没这个文件"), fakeHome), "not-found");

	/* ── 安全边界（拒绝矩阵）──────────────────────────────── */
	await rejects("边界：工作区外的目标 → forbidden", runAction(ctx, { action: "trash", path: join(outside, "x.md") }), "forbidden");
	await rejects("边界：工作区根目录本身 → forbidden", runAction(ctx, { action: "rename", path: workspace, name: "改写工作区" }), "forbidden");
	await rejects("边界：文件系统根 → forbidden", runAction(ctx, { action: "trash", path: "/" }), "forbidden");
	await rejects("边界：相对路径 → bad-request", runAction(ctx, { action: "trash", path: "workspace/x.md" }), "bad-request");
	// 注意：这里必须用字符串拼接而不是 path.join —— join 会把 ".." 规范化掉，测不到那条规则
	await rejects("边界：路径含 .. 回溯 → bad-request", runAction(ctx, { action: "trash", path: `${workspace}/../outside/x.md` }), "bad-request");
	await rejects("边界：未知动作 → bad-request", runAction(ctx, { action: "explode", path: join(workspace, "a.md") }), "bad-request");
	await rejects("终端：目录不存在 → not-found（不会真的开终端）", runAction(ctx, { action: "openTerminal", path: join(workspace, "没这个目录") }), "not-found");

	/* ── 纯函数（避让名，边界值）─────────────────────────── */
	check("避让名：无扩展名的条目也按「名字 2」编号", trashNameFor("第一卷", new Set(["第一卷"])) === "第一卷 2");
	check("避让名：连续占用会一直往后找", trashNameFor("a.md", new Set(["a.md", "a 2.md", "a 3.md"])) === "a 4.md");

	/* ── 服务缺失时不该把功能卡死 ─────────────────────────── */
	const noRegistry = { get: () => undefined };
	const loose = await runAction(noRegistry, { action: "newFile", dir: workspace, name: "无注册表也能建.md" });
	check("拿不到 workSpaceRegistry 时放行（服务缺失不卡功能）", existsSync(loose.path));

	check("沙盒里没有留下意外文件", (await readdir(workspace)).every((name) => ["第一卷", "第3章 风起.md", "占位.md", "无注册表也能建.md"].includes(name)));
} finally {
	await rm(sandbox, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`✗ ${failures.length} 项失败（通过 ${pass} 项）：`);
	for (const item of failures) console.error("   -", item);
	process.exit(1);
}
console.log(`✓ host 半边全部通过：${pass} 项断言`);
