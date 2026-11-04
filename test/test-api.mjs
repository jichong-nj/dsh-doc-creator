// test/test-api.mjs — HTTP 层离线端到端：用假 req/res 直接驱动 createApiHandler，
// 覆盖 JSON 端点、原始字节上传、任务轮询、成文读取与 docx 下载，以及错误映射。

import { Readable, Writable } from "node:stream";
import { createJobs } from "../lib/jobs.js";
import { createApiHandler } from "../lib/api.js";
import { createService } from "../lib/service.js";
import { createStore } from "../lib/store.js";
import {
	DOCUMENT_TEXT,
	OUTLINE_TEXT,
	REPORT_TEXT,
	check,
	checkEqual,
	checkMatch,
	createMockModel,
	createMockSearch,
	makeTempDir,
	summary,
} from "./helpers.mjs";

const { dir, cleanup } = await makeTempDir("doc-creator-api-");
const store = createStore(dir);
const jobs = createJobs();
const model = createMockModel();
const search = createMockSearch();
const service = createService({ store, jobs, getModel: () => model, getSearch: () => search, logger: { warn: () => undefined } });
const handler = createApiHandler({ service, store, jobs, logger: { warn: () => undefined } });

class FakeResponse extends Writable {
	constructor() {
		super();
		this.chunks = [];
		this.statusCode = 0;
		this.headers = {};
		this.headersSent = false;
	}
	_write(chunk, _encoding, callback) {
		this.chunks.push(Buffer.from(chunk));
		callback();
	}
	writeHead(code, headers = {}) {
		this.statusCode = code;
		this.headers = { ...headers };
		this.headersSent = true;
		return this;
	}
	destroy() {
		return super.destroy();
	}
	get body() {
		return Buffer.concat(this.chunks);
	}
	get text() {
		return this.body.toString("utf8");
	}
	get json() {
		return JSON.parse(this.text);
	}
}

function makeRequest({ method, path, json, raw, query }) {
	let url = `/doc-creator/api/${path}`;
	if (query !== undefined) url += `?${new URLSearchParams(query).toString()}`;
	const payload = json !== undefined ? JSON.stringify(json) : raw;
	const req = Readable.from(payload === undefined ? [] : [Buffer.isBuffer(raw) ? raw : Buffer.from(payload)]);
	req.method = method;
	req.url = url;
	return req;
}

async function call(options) {
	const req = makeRequest(options);
	const res = new FakeResponse();
	await new Promise((resolve, reject) => {
		res.on("finish", resolve);
		res.on("error", reject);
		Promise.resolve(handler(req, res)).catch(reject);
	});
	return res;
}

async function post(path, json) {
	const res = await call({ method: "POST", path, json });
	return { status: res.statusCode, body: res.json };
}

async function waitJob(jobId) {
	for (let index = 0; index < 300; index += 1) {
		const res = await post("job", { jobId });
		const job = res.body.value.job;
		if (job.status === "done" || job.status === "error") return job;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("job timeout");
}

try {
	await store.ensureDirs();

	// ── 模板 / 模型 / 列表 ───────────────────────────────────────────────────
	let res = await post("templates", {});
	checkEqual(res.status, 200, "POST templates → 200");
	checkEqual(res.body.ok, true, "响应 envelope ok");
	check(res.body.value.templates.length >= 9, "模板列表非空");
	res = await post("models", {});
	checkEqual(res.status, 200, "POST models → 200");
	checkEqual(res.body.value.selection.provider, "mock", "模型选择来自 model 服务");
	res = await post("list", {});
	checkEqual(res.status, 200, "POST list → 200");
	checkEqual(res.body.value.projects.length, 0, "空列表");

	// ── 创建 / 读取 / 更新 ──────────────────────────────────────────────────
	res = await post("create", { name: "API 测试文档", templateId: "prd" });
	checkEqual(res.status, 200, "POST create → 200");
	const projectId = res.body.value.project.id;
	checkMatch(projectId, /^doc-/, "创建返回项目 id");
	res = await post("get", { projectId });
	checkEqual(res.body.value.project.stage, "setup", "新项目处于 setup");
	res = await post("update", { projectId, patch: { topic: "为 API 层编写端到端测试的示例文档主题。", style: { length: "standard" } } });
	checkEqual(res.status, 200, "POST update → 200");
	checkEqual(res.body.value.project.topic.startsWith("为 API 层"), true, "主题更新成功");

	// ── 上传参考文档（原始字节） ────────────────────────────────────────────
	const rawRef = Buffer.from("# 参考资料\n\nAPI 测试使用的参考文档正文。\n", "utf8");
	res = await call({
		method: "POST",
		path: "upload-ref",
		raw: rawRef,
		query: { projectId, name: "api-ref.md" },
	});
	const upload = JSON.parse(res.text);
	checkEqual(res.statusCode, 200, "POST upload-ref → 200");
	checkEqual(upload.value.ref.status, "ready", "参考文档解析成功");
	checkEqual(upload.value.project.refs.length, 1, "上传后项目含参考文档");

	// 上传空内容 → 400
	res = await call({ method: "POST", path: "upload-ref", raw: Buffer.alloc(0), query: { projectId, name: "empty.md" } });
	checkEqual(res.statusCode, 400, "空上传 → 400");

	// ── 生成大纲 → 轮询任务 ────────────────────────────────────────────────
	model.push(OUTLINE_TEXT);
	res = await post("outline-generate", { projectId });
	checkEqual(res.status, 200, "POST outline-generate → 200");
	const outlineJob = await waitJob(res.body.value.jobId);
	checkEqual(outlineJob.status, "done", "大纲任务 done");
	checkEqual(outlineJob.result.outlineVersion, 1, "大纲版本 1");
	res = await post("get", { projectId });
	checkEqual(res.body.value.project.stage, "outline", "项目进入 outline 阶段");
	checkEqual(res.body.value.project.outline.versions[0].sections.length, 2, "大纲内容随项目返回");
	checkEqual(res.body.value.project.activeJob, null, "任务结束后 activeJob 为 null");

	// ── 确认大纲 + 生成成文 ────────────────────────────────────────────────
	res = await post("outline-confirm", { projectId, version: 1 });
	checkEqual(res.status, 200, "POST outline-confirm → 200");
	checkEqual(res.body.value.project.outline.confirmed, 1, "大纲已确认");
	model.push(DOCUMENT_TEXT, REPORT_TEXT);
	res = await post("document-generate", { projectId });
	checkEqual(res.status, 200, "POST document-generate → 200");
	const documentJob = await waitJob(res.body.value.jobId);
	checkEqual(documentJob.status, "done", "成文任务 done");
	checkEqual(documentJob.result.documentVersion, 1, "成文版本 1");

	// ── 读取成文 + 下载 ────────────────────────────────────────────────────
	res = await post("document", { projectId, version: 1 });
	checkEqual(res.status, 200, "POST document → 200");
	check(res.body.value.markdown.includes("# 测试文档"), "成文 markdown 返回");
	check(res.body.value.meta.format.includes("docx"), "成文含 docx 格式");

	res = await call({ method: "GET", path: `download/${projectId}/1.docx` });
	checkEqual(res.statusCode, 200, "GET docx 下载 → 200");
	checkMatch(res.headers["content-type"], /wordprocessingml/, "docx content-type 正确");
	checkMatch(res.headers["content-disposition"], /attachment/, "docx 走 attachment");
	checkEqual(res.body.subarray(0, 2).toString("latin1"), "PK", "docx 是 zip 包");

	res = await call({ method: "GET", path: `download/${projectId}/1.md` });
	checkEqual(res.statusCode, 200, "GET md 下载 → 200");
	check(res.text.includes("# 测试文档"), "md 下载内容正确");

	// ── 对话（API） ────────────────────────────────────────────────────────
	model.push("<OUTLINE>{\"title\":\"API 测试文档\",\"sections\":[{\"heading\":\"一、背景\",\"points\":[\"要点\"]},{\"heading\":\"二、方案\",\"points\":[\"要点\"]}]}</OUTLINE>");
	res = await post("chat", { projectId, message: "调整一下大纲", phase: "outline" });
	checkEqual(res.status, 200, "POST chat → 200");
	const chatJob = await waitJob(res.body.value.jobId);
	checkEqual(chatJob.status, "done", "对话任务 done");
	checkEqual(chatJob.result.outlineVersion, 2, "对话产生大纲 v2");

	// ── 错误路径 ────────────────────────────────────────────────────────────
	res = await post("nope", {});
	checkEqual(res.status, 404, "未知端点 → 404");
	res = await call({ method: "POST", path: "get", raw: "{bad json" });
	checkEqual(res.statusCode, 400, "非法 JSON → 400");
	res = await post("get", { projectId: "doc-missing-0000" });
	checkEqual(res.status, 404, "未知项目 → 404");
	res = await post("job", { jobId: "job-nope" });
	checkEqual(res.status, 404, "未知任务 → 404");
	res = await call({ method: "GET", path: `download/${projectId}/99.docx` });
	checkEqual(res.statusCode, 404, "不存在的成文版本 → 404");

	console.log("\nALL API TESTS PASSED");
} finally {
	await cleanup();
}

summary("test-api");
