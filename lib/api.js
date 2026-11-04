// lib/api.js — HTTP 路由：POST /doc-creator/api/<endpoint>，GET download/<projectId>/<version>.<ext>。
//
// 导出两个入口，便于测试：
//   createApiHandler(deps) -> async (req, res)   纯 Node 请求处理器
//   registerRoutes(ctx, deps)                    挂到 DSH webServer 前缀

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { toAppError } from "./errors.js";

const JSON_LIMIT = 4 * 1024 * 1024;
const UPLOAD_LIMIT = 50 * 1024 * 1024;
const API_PREFIX = "/doc-creator/api";

function writeJson(res, code, value) {
	const body = JSON.stringify(value);
	res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
	res.end(body);
}

function writeError(res, code, kind, message) {
	writeJson(res, code, { ok: false, error: { code: kind, message: String(message) } });
}

async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > JSON_LIMIT) throw Object.assign(new RangeError("请求体过大（上限 4MB）"), { code: "payload-too-large" });
		chunks.push(chunk);
	}
	if (size === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (error) {
		throw Object.assign(new Error(`请求 JSON 解析失败：${error.message}`), { code: "bad-request" });
	}
}

/** 流式接收上传，超限销毁请求。 */
async function readUpload(req, destPath) {
	await mkdir(path.dirname(destPath), { recursive: true });
	return await new Promise((resolve, reject) => {
		const out = createWriteStream(destPath);
		let size = 0;
		let failed = null;
		out.on("error", (error) => {
			failed = error;
			req.destroy();
			reject(error);
		});
		req.on("data", (chunk) => {
			if (failed !== null) return;
			size += chunk.length;
			if (size > UPLOAD_LIMIT) {
				failed = Object.assign(new RangeError("文件过大（上限 50MB）"), { code: "payload-too-large" });
				req.destroy();
				out.destroy();
				reject(failed);
				return;
			}
			out.write(chunk);
		});
		req.on("error", (error) => {
			if (failed === null) reject(error);
		});
		req.on("end", () => {
			if (failed !== null) return;
			out.end(() => {
				if (failed === null) resolve(size);
			});
		});
	});
}

function disposition(filename) {
	const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function streamFile(res, file, contentType, size, extraHeaders = {}) {
	const headers = {
		"content-type": contentType,
		...(size === undefined ? {} : { "content-length": String(size) }),
		"cache-control": "no-cache",
		...extraHeaders,
	};
	res.writeHead(200, headers);
	createReadStream(file).pipe(res);
}

function intOr(value, fallback) {
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : fallback;
}

/**
 * @param {{
 *   service: ReturnType<typeof import("./service.js").createService>,
 *   store: ReturnType<typeof import("./store.js").createStore>,
 *   jobs: ReturnType<typeof import("./jobs.js").createJobs>,
 *   logger?: { warn?: (message: string) => void },
 * }} deps
 */
export function createApiHandler({ service, store, jobs, logger }) {
	/**
	 * @param {import("node:http").IncomingMessage & { method?: string, url?: string }} req
	 * @param {import("node:http").ServerResponse} res
	 */
	return async function handler(req, res) {
		const url = new URL(req.url ?? "/", "http://localhost");
		const route = decodeURIComponent(url.pathname).replace(/^\/doc-creator\/api\/?/, "");
		try {
			// ── 下载（GET/HEAD） ─────────────────────────────────────────────
			const downloadMatch = /^download\/([^/]+)\/(\d+)\.(docx|md)$/.exec(route);
			if (downloadMatch !== null) {
				if (req.method !== "GET" && req.method !== "HEAD") {
					return writeError(res, 405, "method-not-allowed", "下载只支持 GET");
				}
				const info = await service.getDownload({
					projectId: downloadMatch[1],
					version: Number(downloadMatch[2]),
					ext: downloadMatch[3],
				});
				return streamFile(res, info.file, info.mime, undefined, { "content-disposition": disposition(info.name) });
			}

			// ── 上传参考文档（POST 原始字节） ───────────────────────────────
			if (route === "upload-ref") {
				if (req.method !== "POST") return writeError(res, 405, "method-not-allowed", "upload-ref 只支持 POST");
				const projectId = url.searchParams.get("projectId") ?? "";
				const name = url.searchParams.get("name") ?? "参考文档";
				const tmpDir = await store.tmpDir();
				const tmpPath = path.join(tmpDir, "upload.bin");
				try {
					const size = await readUpload(req, tmpPath);
					if (size < 2) throw Object.assign(new Error("上传内容为空"), { code: "bad-request" });
					const value = await service.addReference({ projectId, tmpPath, name });
					return writeJson(res, 200, { ok: true, value });
				} finally {
					await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
				}
			}

			// ── 其余 JSON POST 端点 ─────────────────────────────────────────
			if (req.method !== "POST") return writeError(res, 405, "method-not-allowed", "该接口只支持 POST");
			const payload = await readJsonBody(req);
			let value;
			switch (route) {
				case "templates":
					value = service.listTemplates();
					break;
				case "models":
					value = await service.listModels();
					break;
				case "list":
					value = await service.listProjects();
					break;
				case "create":
					value = await service.createProject({ name: payload?.name, templateId: payload?.templateId });
					break;
				case "get":
					value = await service.getProject(String(payload?.projectId ?? ""));
					break;
				case "update":
					value = await service.updateProject({ projectId: String(payload?.projectId ?? ""), patch: payload?.patch });
					break;
				case "delete":
					value = await service.deleteProject({ projectId: String(payload?.projectId ?? "") });
					break;
				case "delete-ref":
					value = await service.removeReference({ projectId: String(payload?.projectId ?? ""), refId: String(payload?.refId ?? "") });
					break;
				case "ref-preview":
					value = await service.readReferencePreview({
						projectId: String(payload?.projectId ?? ""),
						refId: String(payload?.refId ?? ""),
						maxChars: intOr(payload?.maxChars, undefined),
					});
					break;
				case "outline-generate":
					value = { jobId: await service.generateOutline({ projectId: String(payload?.projectId ?? "") }) };
					break;
				case "outline-confirm":
					value = await service.confirmOutline({ projectId: String(payload?.projectId ?? ""), version: intOr(payload?.version, 0) });
					break;
				case "document-generate":
					value = { jobId: await service.generateDocument({ projectId: String(payload?.projectId ?? ""), outlineVersion: intOr(payload?.outlineVersion, undefined) }) };
					break;
				case "chat": {
					value = {
						jobId: await service.chat({
							projectId: String(payload?.projectId ?? ""),
							message: typeof payload?.message === "string" ? payload.message : "",
							phase: payload?.phase,
						}),
					};
					break;
				}
				case "job": {
					const job = jobs.get(String(payload?.jobId ?? ""));
					if (job === null) throw Object.assign(new Error("任务不存在或已过期，请刷新页面后重试"), { code: "not-found" });
					value = { job };
					break;
				}
				case "document":
					value = await service.getDocument({ projectId: String(payload?.projectId ?? ""), version: intOr(payload?.version, undefined) });
					break;
				default:
					return writeError(res, 404, "not-found", `未知接口：${route}`);
			}
			return writeJson(res, 200, { ok: true, value });
		} catch (error) {
			const appError = toAppError(error);
			if (appError.code === "internal") logger?.warn?.(`[doc-creator] api error: ${appError.stack ?? appError.message}`);
			if (!res.headersSent) {
				const status = appError.status ?? 500;
				return writeError(res, status >= 500 ? 500 : status, appError.code, appError.message);
			}
			res.destroy?.();
		}
	};
}

/**
 * 注册到 DSH webServer 前缀路由。
 * @returns 取消注册函数（若宿主提供）
 */
export function registerRoutes(ctx, deps) {
	const handler = createApiHandler(deps);
	return ctx.webServer.register({ kind: "prefix", path: API_PREFIX, handler });
}

export { API_PREFIX };
