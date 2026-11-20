// dsh-workspace-files — node half（host 半边）
//
// 浏览器半边负责左侧边栏的文件树；这里补**官方没有的那一半：文件系统的写操作**。
// 取证（/tmp/dsh-src）：官方 `packages/api/workspace-files/src/index.ts` 自述
// 「this service exposes no mutations」；client 可见的 Remote 命名空间清单
// （packages/api/remotes/src/client/index.ts）里没有任何 fs 写能力；Electron preload
// （apps/desktop/src/preload-app.ts）只暴露 browser / keyboard / shortcuts / updates，
// 也没有 shell.trashItem。所以「删除 / 重命名 / 新建 / 在终端打开」只能由插件自己的路由承担。
//
// 路由（同源 fetch；本地 GUI 无鉴权网关，与 dsh-memguard / dsh-preset-hotswap 同一手法）：
//   GET  /dsh-workspace-files/health  → { ok, actions, roots }
//   POST /dsh-workspace-files/fs      → { action, path?, dir?, name? }
//     action = trash | rename | newFile | newDir | openTerminal
//
// 安全边界（三层，均可离线回归）：
//   ① 目标必须落在某个**已注册工作区**之下（`workspaceRegistry.list()` 的 canonical path，
//      比较前两侧都做 realpath 归一，避免符号链接误判）；拿不到根列表时放行 ——
//      服务缺失不该把功能卡死；命中工作区根目录本身则单独拒绝。
//   ② 根目录 / 主目录 / ~/.Trash 自身这类「删了就回不来」的目标一律拒绝。
//   ③ 新建与重命名的名字必须是纯名字（无分隔符、无 `..`、无 NUL、非空、≤255）。
//
// 移到废纸篓的三条路径（跨卷也能用；2026-10-26 起）：
//   ① 同卷 → `rename` 进 `~/.Trash`；
//   ② 跨卷且目标卷有 `.Trashes/<uid>`（macOS 每卷自带）→ `rename` 进**该卷的**废纸篓；
//   ③ 跨卷兜底 → `cp` 到废纸篓临时名 → 比对条目数/字节数 → `rename` 落位 → 最后才删原件。
// 任何一步失败都保留原件；详见 trashPath / trashByCopy。
//
// ⚠️ 改本文件（host 半边）**必须完全重启 DSH 应用**才生效：client 半边走 stat-poll
// 热读，host 半边是启动时装配的模块。重启后 `curl :19387/dsh-workspace-files/health`
// 应返回 ok:true —— 这是「路由有没有活过来」的一秒判据。
import { spawn } from "node:child_process";
import { access, cp, lstat, mkdir, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

export const name = "@jipika/dsh-workspace-files";
export const inject = [];

/** 路由前缀（prefix 注册下 req.url 是完整路径，别只认尾部段 —— 见 dsh-memguard 的教训）。 */
const ROUTE = "/dsh-workspace-files";
/** 请求体上限：这里只有几个短字段，超过就是异常流量。 */
const MAX_BODY_BYTES = 16 * 1024;
/** 废纸篓避让名最多试到第几号（Finder 也是 name 2 / name 3 …）。 */
const TRASH_LIMIT = 200;

/** 带错误码的失败：码进响应体，消息原样给用户看。 */
class WorkspaceFilesError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/* ───────────────────────── 校验（纯函数，可离线回归） ───────────────────────── */

/**
 * 新建 / 重命名用的名字校验。
 * @returns 出问题的原因，合法时为 null。
 */
export function nameProblem(name) {
	if (typeof name !== "string") return "名字必须是字符串";
	const value = name.trim();
	if (value === "") return "名字不能为空";
	if (value === "." || value === "..") return "名字不能是 . 或 ..";
	if (value.includes("/") || value.includes("\\")) return "名字里不能有路径分隔符";
	if (value.includes("\u0000")) return "名字里有非法字符";
	if (value.length > 255) return "名字过长（最多 255 个字符）";
	return null;
}

/**
 * 绝对路径校验。`..` 一律拒绝：调用方（client）已经持有规范化路径，
 * 出现回溯段说明拼接出错，宁可直接报错也别猜。
 */
export function pathProblem(target) {
	if (typeof target !== "string" || target.trim() === "") return "路径不能为空";
	if (target.includes("\u0000")) return "路径里有非法字符";
	if (!isAbsolute(target)) return "路径必须是绝对路径（浏览器半边用工作区 cwd 拼）";
	if (target.split(/[/\\]/).includes("..")) return "路径里不能有 .. 回溯段";
	return null;
}

/** 拒绝「动一下就回不来」的目标：文件系统根、主目录、废纸篓目录自身。 */
export function protectedProblem(target, home) {
	const clean = String(target).replace(/[/\\]+$/, "");
	if (clean === "") return "不能操作文件系统根目录";
	if (clean === home) return "不能操作主目录本身";
	if (clean === join(home, ".Trash")) return "不能操作废纸篓目录本身";
	return null;
}

/**
 * 废纸篓里的避让名：`a.txt` → `a 2.txt` → `a 3.txt`（与 Finder 同款）。
 * @param name - 原文件名。
 * @param taken - 废纸篓里**已占用**的名字集合。
 */
export function trashNameFor(name, taken) {
	if (!taken.has(name)) return name;
	const dot = name.lastIndexOf(".");
	const hasExtension = dot > 0;
	const stem = hasExtension ? name.slice(0, dot) : name;
	const extension = hasExtension ? name.slice(dot) : "";
	for (let index = 2; index <= TRASH_LIMIT; index += 1) {
		const candidate = stem + " " + index + extension;
		if (!taken.has(candidate)) return candidate;
	}
	return stem + " " + Date.now() + extension;
}

/** 路径是否等于根、或在根之下（两侧都应是已归一化的绝对路径）。 */
export function withinRoot(root, target) {
	if (root === target) return true;
	const prefix = root.endsWith(sep) ? root : root + sep;
	return target.startsWith(prefix);
}

/* ───────────────────────── host 侧动作 ───────────────────────── */

/** 已注册工作区的 canonical 根路径（服务缺失 / 抛错时返回空数组 = 不拦）。 */
async function workspaceRoots(ctx) {
	try {
		const registry = typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : undefined;
		if (registry === undefined || registry === null || typeof registry.list !== "function") return [];
		const items = registry.list();
		if (!Array.isArray(items)) return [];
		return items.map((item) => (item && typeof item.path === "string" && item.path !== "" ? item.path : null)).filter((value) => value !== null);
	} catch {
		return [];
	}
}

/** 把路径归一成「真的那一份」：父目录 realpath + 原名（末段可能还不存在，不能整体 realpath）。 */
async function canonical(target) {
	let parent = dirname(target);
	try {
		parent = await realpath(parent);
	} catch {}
	return join(parent, basename(target));
}

/**
 * 工作区边界判定。
 * @returns `{ ok, reason, isRoot }`；`ok` false 时 `reason` 是给用户看的拒绝理由。
 */
async function boundaryOf(ctx, target) {
	const roots = await workspaceRoots(ctx);
	if (roots.length === 0) return { ok: true, reason: null, isRoot: false };
	const real = await canonical(target);
	let isRoot = false;
	for (const root of roots) {
		const realRoot = await canonical(root);
		if (real === realRoot) isRoot = true;
		if (withinRoot(realRoot, real)) return { ok: true, reason: null, isRoot };
	}
	return { ok: false, reason: "目标不在任何已注册工作区之内，已拒绝（这是插件的安全边界）", isRoot: false };
}

/** 存在性（lstat，不跟随末段符号链接）。 */
async function exists(target) {
	try {
		await lstat(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * 递归统计一棵树的「条目数 + 字节数」，用来校验复制出来的副本是否**完整**。
 * 目录自己的 size 与文件系统块无关，所以只累加文件/符号链接的 lstat().size；
 * 目录只贡献一个条目数。源与副本用同一套算法，两边可直接比较。
 * @param target - 任意路径（文件 / 目录 / 符号链接）。
 */
export async function treeStats(target) {
	const info = await lstat(target);
	if (!info.isDirectory()) return { entries: 1, bytes: info.size };
	let entries = 1;
	let bytes = 0;
	for (const name of await readdir(target)) {
		const sub = await treeStats(join(target, name));
		entries += sub.entries;
		bytes += sub.bytes;
	}
	return { entries, bytes };
}

/**
 * 目标所在**卷的挂载点**：沿父目录上溯，直到父目录的 dev 变了（或到 `/`）。
 * `/Volumes/mac/a/b` → `/Volumes/mac`；`/Users/x/y` → `/`。
 * @param target - 已存在的绝对路径。
 */
export async function mountPointOf(target) {
	let current = dirname(target);
	for (;;) {
		const parent = dirname(current);
		if (parent === current) return current;
		try {
			const [cur, par] = [await stat(current), await stat(parent)];
			if (cur.dev !== par.dev) return current;
		} catch {
			return current;
		}
		current = parent;
	}
}

/**
 * 目标所在卷**自己的**废纸篓：macOS 的 `/Volumes/<卷>/.Trashes/<uid>`。
 * 跨卷删除优先用它 —— 同卷 rename 是瞬时的（不复制内容），Finder 里也出现在该卷的
 * 废纸篓里。不可用（非 macOS / 目录建不出来 / 不可写）时返回 null，交给复制兜底。
 * @param target - 待删除的绝对路径。
 * @param platform - 可注入的平台（离线回归用）。
 * @param uid - 可注入的 uid（离线回归用；默认取进程 uid）。
 */
export async function volumeTrashFor(target, platform = process.platform, uid = typeof process.getuid === "function" ? process.getuid() : null) {
	if (platform !== "darwin" || uid === null) return null;
	const root = join(await mountPointOf(target), ".Trashes", String(uid));
	try {
		await mkdir(root, { recursive: true });
		const info = await stat(root);
		if (!info.isDirectory()) return null;
		await access(root, fsConstants.W_OK);
		return root;
	} catch {
		return null;
	}
}

/**
 * 跨卷兜底：**先复制、校验、落位，最后才删原件**。
 *
 * 顺序是刻意的（文件系统没有跨卷原子移动）：
 *   ① `cp` 到废纸篓里的临时名（`.dsh-wsf-trash-*`，不叫最终名字）；
 *   ② 递归比对源与副本的「条目数 + 字节数」，不一致就撤掉副本并报错；
 *   ③ `rename` 临时名 → 最终名（同卷原子，Finder 只会看到完整条目）；
 *   ④ 这之后才 `rm` 原件。
 * 任何一步失败都**保留原件**；副本要么不存在、要么是完整可恢复的一份。
 * @param target - 待删除的绝对路径（调用方已做过工作区边界校验）。
 * @param trashDir - 目标废纸篓目录（通常是 `~/.Trash`）。
 */
export async function trashByCopy(target, trashDir) {
	const taken = new Set();
	try {
		for (const entry of await readdir(trashDir)) taken.add(entry);
	} catch {}
	const finalName = trashNameFor(basename(target), taken);
	const finalPath = join(trashDir, finalName);
	const tempPath = join(trashDir, ".dsh-wsf-trash-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
	const drop = async (target_) => {
		try {
			await rm(target_, { recursive: true, force: true });
		} catch {}
	};
	try {
		await cp(target, tempPath, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: true });
	} catch (error) {
		await drop(tempPath);
		throw new WorkspaceFilesError("internal", "跨卷移入废纸篓失败（复制阶段，原件未改动）：" + String((error && error.message) || error));
	}
	let source;
	let copy;
	try {
		source = await treeStats(target);
		copy = await treeStats(tempPath);
	} catch (error) {
		await drop(tempPath);
		throw new WorkspaceFilesError("internal", "跨卷移入废纸篓失败（校验阶段，原件未改动）：" + String((error && error.message) || error));
	}
	if (source.entries !== copy.entries || source.bytes !== copy.bytes) {
		await drop(tempPath);
		throw new WorkspaceFilesError(
			"internal",
			"跨卷移入废纸篓失败：副本不完整（源 " + source.entries + " 项 / " + source.bytes + " 字节，副本 " + copy.entries + " 项 / " + copy.bytes + " 字节），已撤掉副本，原件未改动"
		);
	}
	try {
		await rename(tempPath, finalPath);
	} catch (error) {
		await drop(tempPath);
		throw new WorkspaceFilesError("internal", "跨卷移入废纸篓失败（落位阶段，原件未改动）：" + String((error && error.message) || error));
	}
	try {
		await rm(target, { recursive: true, force: true });
	} catch (error) {
		// 副本已在废纸篓里、原件还在：宁可「两份」也不丢数据，把情况如实报出来。
		throw new WorkspaceFilesError(
			"internal",
			"已把副本放进废纸篓（" + finalPath + "），但删除原件失败（原件仍在）：" + String((error && error.message) || error)
		);
	}
	return { trashed: finalPath, via: "copy" };
}

/**
 * 移到废纸篓，三条路径按顺序尝试：
 *   ① **同卷**：直接 `rename` 进 `~/.Trash`（瞬时，无复制）；
 *   ② **跨卷 + 目标卷有 `.Trashes`**：`rename` 进该卷自己的废纸篓（仍是同卷，瞬时）；
 *   ③ **跨卷兜底**：`trashByCopy`（复制 → 校验 → 落位 → 删原件）。
 * 过去的实现只做 ①，跨卷直接报「不被系统支持」；用户的工作区在 /Volumes/mac，
 * 于是那条菜单项整个不可用（2026-10-26 用户截图报障）。
 * @param target - 待移除的绝对路径。
 * @param home - 可注入的「家目录」（离线回归用它把废纸篓换到临时目录，不污染真实废纸篓）。
 * @param options - `volumeTrash:false` 跳过 ②（离线回归里避免写真实的外部卷废纸篓）。
 */
export async function trashPath(target, home = homedir(), options = {}) {
	try {
		await lstat(target);
	} catch {
		throw new WorkspaceFilesError("not-found", "目标不存在或不可读：" + target);
	}
	const trashDir = join(home, ".Trash");
	try {
		await mkdir(trashDir, { recursive: true });
	} catch {}
	let trashInfo;
	try {
		trashInfo = await stat(trashDir);
	} catch {
		throw new WorkspaceFilesError("no-trash", "找不到系统废纸篓目录 ~/.Trash，已放弃（文件未改动）");
	}
	let info;
	try {
		info = await lstat(target);
	} catch {
		throw new WorkspaceFilesError("not-found", "目标不存在或不可读：" + target);
	}
	const taken = new Set();
	try {
		for (const entry of await readdir(trashDir)) taken.add(entry);
	} catch {}
	if (info.dev === trashInfo.dev) {
		const destination = join(trashDir, trashNameFor(basename(target), taken));
		await rename(target, destination);
		return { trashed: destination, via: "rename" };
	}
	if (options.volumeTrash !== false) {
		const volumeTrash = await volumeTrashFor(target);
		if (volumeTrash !== null) {
			try {
				const names = new Set();
				for (const entry of await readdir(volumeTrash)) names.add(entry);
				const destination = join(volumeTrash, trashNameFor(basename(target), names));
				await rename(target, destination);
				return { trashed: destination, via: "volume-trash" };
			} catch {
				/* 该卷废纸篓不可用（只读卷 / 权限）→ 走复制兜底 */
			}
		}
	}
	return trashByCopy(target, trashDir);
}

/** 同目录改名。 */
export async function renameEntry(target, name) {
	const problem = nameProblem(name);
	if (problem !== null) throw new WorkspaceFilesError("bad-name", problem);
	const destination = join(dirname(target), name.trim());
	if (destination === target) return { unchanged: true };
	if (await exists(destination)) throw new WorkspaceFilesError("exists", "同目录下已有同名条目：" + name.trim());
	await rename(target, destination);
	return { path: destination };
}

/** 在指定目录里新建文件（空）或文件夹；已存在则拒绝，绝不覆盖。 */
export async function createEntry(dir, name, kind) {
	const problem = nameProblem(name);
	if (problem !== null) throw new WorkspaceFilesError("bad-name", problem);
	let info;
	try {
		info = await stat(dir);
	} catch {
		throw new WorkspaceFilesError("not-found", "目标目录不存在：" + dir);
	}
	if (!info.isDirectory()) throw new WorkspaceFilesError("not-directory", "目标不是目录：" + dir);
	const target = join(dir, name.trim());
	if (await exists(target)) throw new WorkspaceFilesError("exists", "已存在同名条目：" + name.trim());
	if (kind === "dir") await mkdir(target);
	else await writeFile(target, "", { flag: "wx" });
	return { path: target };
}

/** 在本机终端里打开目录（macOS 走系统自带的 Terminal.app）。 */
async function openTerminal(dir) {
	let info = null;
	try {
		info = await stat(dir);
	} catch {
		throw new WorkspaceFilesError("not-found", "目录不存在：" + dir);
	}
	if (!info.isDirectory()) throw new WorkspaceFilesError("not-directory", "不是目录：" + dir);
	const child =
		process.platform === "darwin"
			? spawn("open", ["-a", "Terminal", dir], { detached: true, stdio: "ignore" })
			: process.platform === "win32"
				? spawn("cmd", ["/c", "start", "cmd"], { cwd: dir, detached: true, stdio: "ignore", windowsHide: true })
				: spawn("x-terminal-emulator", [], { cwd: dir, detached: true, stdio: "ignore" });
	child.unref();
	return { opened: dir };
}

/* ───────────────────────── HTTP 管线 ───────────────────────── */

function sendJson(res, status, payload) {
	try {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(payload));
	} catch {
		/* 客户端已断开 */
	}
}

async function readBody(req) {
	let text = "";
	await new Promise((resolve, reject) => {
		req.on("data", (chunk) => {
			text += chunk;
			if (text.length > MAX_BODY_BYTES) {
				reject(new WorkspaceFilesError("too-large", "请求体过大"));
				try {
					req.destroy();
				} catch {}
			}
		});
		req.on("end", resolve);
		req.on("error", reject);
	});
	return text;
}

const STATUS_OF = {
	"bad-name": 400,
	"bad-request": 400,
	"too-large": 413,
	"not-found": 404,
	"not-directory": 400,
	exists: 409,
	"no-trash": 500,
	forbidden: 403,
	internal: 500
};

/** 单个动作的校验 + 执行。校验顺序固定：路径 → 保护名单 → 工作区边界。 */
export async function runAction(ctx, body) {
	const action = typeof body.action === "string" ? body.action : "";
	if (action === "trash" || action === "rename") {
		const problem = pathProblem(body.path);
		if (problem !== null) throw new WorkspaceFilesError("bad-request", problem);
		const guarded = protectedProblem(body.path, homedir());
		if (guarded !== null) throw new WorkspaceFilesError("forbidden", guarded);
		const boundary = await boundaryOf(ctx, body.path);
		if (!boundary.ok) throw new WorkspaceFilesError("forbidden", boundary.reason);
		if (boundary.isRoot) throw new WorkspaceFilesError("forbidden", "这是某个工作区的根目录本身，已拒绝（改工作区请在设置里操作）");
		if (action === "trash") return trashPath(body.path);
		return renameEntry(body.path, body.name);
	}
	if (action === "newFile" || action === "newDir") {
		const problem = pathProblem(body.dir);
		if (problem !== null) throw new WorkspaceFilesError("bad-request", problem);
		const boundary = await boundaryOf(ctx, body.dir);
		if (!boundary.ok) throw new WorkspaceFilesError("forbidden", boundary.reason);
		return createEntry(body.dir, body.name, action === "newFile" ? "file" : "dir");
	}
	if (action === "openTerminal") {
		const problem = pathProblem(body.path);
		if (problem !== null) throw new WorkspaceFilesError("bad-request", problem);
		const boundary = await boundaryOf(ctx, body.path);
		if (!boundary.ok) throw new WorkspaceFilesError("forbidden", boundary.reason);
		return openTerminal(body.path);
	}
	throw new WorkspaceFilesError("bad-request", "未知动作：" + action);
}

/* ───────────────────────── apply ───────────────────────── */

export function apply(ctx) {
	// 探针行：证明 loader 行挂上了（host 日志里可见；重启后仍有它 = 新代码在跑）。
	console.log("[dsh-workspace-files] host half mounted; POST " + ROUTE + "/fs");

	ctx.inject(["webServer"], (wctx) => {
		ctx.effect(
			() =>
				wctx.webServer.register({
					kind: "prefix",
					path: ROUTE,
					handler: async (req, res) => {
						const url = new URL(req.url ?? "/", "http://localhost");
						// prefix 注册下 req.url 是**完整路径**，两种形态都收（尾斜杠/带前缀）
						const pathname = url.pathname.replace(/\/+$/, "");
						const at = (suffix) => pathname === suffix || pathname.endsWith(ROUTE + suffix);
						try {
							if (req.method === "GET" && (at("") || at("/health"))) {
								sendJson(res, 200, {
									ok: true,
									plugin: "@jipika/dsh-workspace-files",
									actions: ["trash", "rename", "newFile", "newDir", "openTerminal"],
									roots: (await workspaceRoots(ctx)).length,
									trash: join(homedir(), ".Trash"),
									trashModes: ["rename", "volume-trash", "copy"],
									at: new Date().toISOString()
								});
								return;
							}
							if (req.method === "POST" && at("/fs")) {
								let body = null;
								try {
									body = JSON.parse((await readBody(req)) || "{}");
								} catch (error) {
									sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON：" + String((error && error.message) || error) });
									return;
								}
								if (body === null || typeof body !== "object") {
									sendJson(res, 400, { ok: false, error: "请求体必须是对象" });
									return;
								}
								try {
									const value = await runAction(ctx, body);
									sendJson(res, 200, Object.assign({ ok: true }, value));
								} catch (error) {
									const code = error instanceof WorkspaceFilesError ? error.code : "internal";
									const message = String((error && error.message) || error);
									console.warn("[dsh-workspace-files] " + body.action + " 失败：" + message);
									sendJson(res, STATUS_OF[code] ?? 500, { ok: false, code, error: message });
								}
								return;
							}
							sendJson(res, 404, { ok: false, error: "未知路由：" + req.method + " " + pathname });
						} catch (error) {
							sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
						}
					}
				}),
			"dsh-workspace-files: fs route"
		);
	});
}
