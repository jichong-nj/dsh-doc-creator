// test/test-service.mjs — 业务编排层端到端离线测试（假模型 + 假联网 + 临时数据目录）。
// 覆盖：项目 CRUD / 参考文档上传 / 大纲生成与版本 / 确认 / 成文生成与 Word 落盘 /
//       红线与确定性校验 / 两阶段共享对话上下文（大纲调整 + 成文调整 + 纯讨论）/ 联网检索 / 错误路径。

import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createJobs } from "../lib/jobs.js";
import { AppError } from "../lib/errors.js";
import { createService } from "../lib/service.js";
import { createStore } from "../lib/store.js";
import {
	DOCUMENT_TEXT,
	DOCUMENT_TEXT_2,
	DISCUSSION_TEXT,
	OUTLINE_TEXT,
	OUTLINE_TEXT_2,
	REPORT_TEXT,
	check,
	checkEqual,
	checkMatch,
	createMockModel,
	createMockSearch,
	makeTempDir,
	summary,
	waitForJob,
} from "./helpers.mjs";

const { dir, cleanup } = await makeTempDir("doc-creator-service-");
const store = createStore(dir);
const jobs = createJobs();
const model = createMockModel();
const search = createMockSearch();
const service = createService({
	store,
	jobs,
	getModel: () => model,
	getSearch: () => search,
	logger: { warn: (message) => console.error("[warn]", message) },
});

async function expectAppError(fn, code, label) {
	let caught = null;
	try {
		await fn();
	} catch (error) {
		caught = error;
	}
	check(caught instanceof AppError, `${label}：抛出 AppError`);
	checkEqual(caught.code, code, `${label}：code=${code}`);
}

try {
	await store.ensureDirs();

	// ── 模板 ────────────────────────────────────────────────────────────────
	const { templates } = service.listTemplates();
	check(templates.length >= 9, "内置模板数量 ≥ 9");
	check(templates.some((item) => item.id === "free"), "内置模板包含自由发挥");
	check(templates.every((item) => item.sections.length > 0 || item.id === "free"), "模板含章节骨架（free 除外）");

	// ── 创建项目 ────────────────────────────────────────────────────────────
	const created = await service.createProject({ name: "端到端测试文档", templateId: "project-plan" });
	const projectId = created.project.id;
	checkMatch(projectId, /^doc-[a-z0-9-]+$/, "项目 id 格式正确");
	checkEqual(created.project.stage, "setup", "新项目 stage=setup");
	check(created.project.redlines.length >= 6, "新项目预置内置红线");
	checkEqual(created.project.outline.confirmed, null, "新项目未确认大纲");

	// ── 更新配置 ────────────────────────────────────────────────────────────
	const updated = await service.updateProject({
		projectId,
		patch: {
			topic: "面向中小企业的数据安全治理方案，重点讲落地路径与成本。",
			style: { audience: "management", tone: "formal", length: "standard" },
			webSearch: { enabled: true },
			redlines: [...created.project.redlines.map((item) => ({ id: item.id, text: item.text, builtin: true })), "不得出现未脱敏的手机号"],
		},
	});
	checkEqual(updated.project.topic.startsWith("面向中小企业"), true, "主题已保存");
	checkEqual(updated.project.style.audience, "management", "受众已保存");
	checkEqual(updated.project.webSearch.enabled, true, "联网开关已保存");
	check(updated.project.redlines.some((item) => item.text.includes("未脱敏")), "自定义红线已保存");

	// ── 参考文档上传 ────────────────────────────────────────────────────────
	const refFile = path.join(dir, "ref-source.md");
	await writeFile(refFile, "# 参考资料\n\n数据安全治理需要覆盖制度、技术、运营三个方面。\n", "utf8");
	const added = await service.addReference({ projectId, tmpPath: refFile, name: "数据安全背景资料.md" });
	checkEqual(added.ref.status, "ready", "参考文档解析成功");
	check(added.ref.chars > 10, "参考文档字数抽取成功");
	checkEqual(added.project.refs.length, 1, "参考文档已加入项目");
	const preview = await service.readReferencePreview({ projectId, refId: added.ref.id });
	check(preview.text.includes("数据安全治理"), "参考文档预览内容正确");

	// ── 生成大纲（含联网） ──────────────────────────────────────────────────
	search.push([{ title: "数据安全治理白皮书", url: "https://example.com/whitepaper", snippet: "覆盖制度、技术、运营三个层面。" }]);
	model.push(OUTLINE_TEXT);
	const outlineJobId = await service.generateOutline({ projectId });
	const outlineJob = await waitForJob(jobs, outlineJobId);
	checkEqual(outlineJob.status, "done", "大纲任务完成");
	checkEqual(outlineJob.progress, 100, "大纲任务进度 100");
	let project = (await service.getProject(projectId)).project;
	checkEqual(project.outline.versions.length, 1, "生成 1 个大纲版本");
	checkEqual(project.outline.active, 1, "大纲当前版本 v1");
	checkEqual(project.outline.versions[0].sections.length, 2, "大纲版本带完整 sections 内容");
	checkEqual(project.stage, "outline", "生成大纲后 stage=outline");
	checkEqual(project.sources.length, 1, "联网资料已缓存到项目");
	checkEqual(project.webSearch.lastSearchAt !== null, true, "联网检索时间已记录");
	checkEqual(search.calls.length >= 1, true, "确实调用了联网检索");
	checkEqual(model.calls.length, 1, "大纲生成调用模型 1 次");
	check(model.calls[0].system.includes("红线"), "提示词包含红线要求");
	check(model.calls[0].system.includes("参考文档") || JSON.stringify(model.calls[0].messages).includes("参考文档"), "提示词包含参考文档");
	checkEqual(outlineJob.result.outlineVersion, 1, "任务结果包含大纲版本号");

	// ── 重新生成大纲（不重新检索已有 sources 也允许） ───────────────────────
	search.push(new Error("模拟检索失败"));
	model.push(OUTLINE_TEXT);
	const regenJobId = await service.generateOutline({ projectId });
	const regenJob = await waitForJob(jobs, regenJobId);
	checkEqual(regenJob.status, "done", "联网失败也不阻断大纲生成");
	project = (await service.getProject(projectId)).project;
	checkEqual(project.outline.versions.length, 2, "重新生成产生 v2");
	checkEqual(project.sources.length, 1, "沿用上次联网资料");
	check(project.warnings.some((warning) => warning.includes("联网")), "warning 记录联网失败");

	// ── 确认大纲 ────────────────────────────────────────────────────────────
	const confirmed = await service.confirmOutline({ projectId, version: 2 });
	checkEqual(confirmed.project.outline.confirmed, 2, "大纲 v2 已确认");
	checkEqual(confirmed.project.stage, "document", "确认大纲后 stage=document");
	checkEqual(confirmed.project.outline.versions[1].status, "confirmed", "版本状态标记为 confirmed");

	// ── 生成成文 ────────────────────────────────────────────────────────────
	model.push(DOCUMENT_TEXT, REPORT_TEXT);
	const docJobId = await service.generateDocument({ projectId });
	const docJob = await waitForJob(jobs, docJobId);
	checkEqual(docJob.status, "done", "成文任务完成");
	const docVersion = docJob.result.documentVersion;
	checkEqual(docVersion, 1, "成文版本 v1");
	project = (await service.getProject(projectId)).project;
	const docMeta = project.document.versions.find((item) => item.version === 1);
	checkEqual(docMeta.outlineVersion, 2, "成文基于已确认大纲 v2");
	check(docMeta.format.includes("md") && docMeta.format.includes("docx"), "成文包含 md 与 docx");
	check(docMeta.validation.some((item) => item.kind === "length"), "校验包含篇幅检查");
	check(docMeta.validation.some((item) => item.kind === "section"), "校验包含章节覆盖检查");
	check(docMeta.validation.some((item) => item.kind === "redline"), "校验包含红线自检");
	check(docMeta.validation.find((item) => item.kind === "redline" && item.status === "risk") !== undefined, "红线 risk 被记录");
	const docxStat = await stat(store.documentPath(projectId, 1, "docx"));
	check(docxStat.size > 5000, `Word 文件已生成（${docxStat.size} 字节）`);
	const document = await service.getDocument({ projectId });
	check(document.markdown.includes("# 测试文档"), "Markdown 正文可读取");
	check(document.meta.version === 1, "getDocument 返回版本元数据");

	// ── 下载 ────────────────────────────────────────────────────────────────
	const download = await service.getDownload({ projectId, version: 1, ext: "docx" });
	checkEqual(download.mime.includes("wordprocessingml"), true, "docx 下载 MIME 正确");
	check(download.name.endsWith(".docx"), "下载文件名以 .docx 结尾");
	const mdDownload = await service.getDownload({ projectId, version: 1, ext: "md" });
	check(mdDownload.name.endsWith(".md"), "Markdown 下载文件名正确");

	// ── 对话调整（大纲阶段）：产生 v3 并清空确认 ────────────────────────────
	model.push(OUTLINE_TEXT_2);
	const chatOutlineJobId = await service.chat({ projectId, message: "请新增风险与应对章节，并压缩背景。", phase: "outline" });
	const chatOutlineJob = await waitForJob(jobs, chatOutlineJobId);
	checkEqual(chatOutlineJob.status, "done", "大纲对话任务完成");
	project = (await service.getProject(projectId)).project;
	checkEqual(project.outline.versions.length, 3, "对话产生第 3 个大纲版本");
	checkEqual(project.outline.confirmed, null, "新大纲版本需要重新确认");
	checkEqual(project.outline.versions[2].changeNote, "用户对话调整", "版本变更说明正确");
	checkEqual(project.conversation.messages.length, 2, "对话保存用户与助手两条消息");
	checkEqual(project.conversation.messages[0].role, "user", "第一条是用户消息");
	checkEqual(project.conversation.messages[0].phase, "outline", "用户消息带大纲阶段标记");
	checkEqual(project.conversation.messages[1].action.kind, "outline", "助手消息带大纲版本动作");
	checkEqual(project.conversation.messages[1].action.version, 3, "助手动作版本号正确");
	checkEqual(project.stage, "outline", "对话调整后回到 outline 阶段");

	// ── 再次确认 + 成文阶段对话调整 ────────────────────────────────────────
	await service.confirmOutline({ projectId, version: 3 });
	model.push(DOCUMENT_TEXT_2, REPORT_TEXT);
	const chatDocJobId = await service.chat({ projectId, message: "把背景部分扩写，语气更正式。", phase: "document" });
	const chatDocJob = await waitForJob(jobs, chatDocJobId);
	checkEqual(chatDocJob.status, "done", "成文对话任务完成");
	project = (await service.getProject(projectId)).project;
	checkEqual(project.document.versions.length, 2, "成文对话产生第 2 个成文版本");
	checkEqual(project.conversation.messages.length, 4, "两阶段对话共享同一上下文（共 4 条消息）");
	checkEqual(project.conversation.messages[0].phase, "outline", "成文阶段仍能看到大纲阶段历史消息（上下文未丢失）");
	checkEqual(project.conversation.messages[2].phase, "document", "第 3 条是成文阶段用户消息");
	checkEqual(project.conversation.messages[3].phase, "document", "第 4 条是成文阶段消息");
	checkEqual(project.conversation.messages[3].action.kind, "document", "成文助手动作版本类型正确");
	const doc2 = await service.getDocument({ projectId, version: 2 });
	check(doc2.markdown.includes("扩充后的背景"), "成文新版本内容已落盘");

	// ── 纯讨论（不产生新版本） ──────────────────────────────────────────────
	model.push(DISCUSSION_TEXT);
	const beforeDocCount = project.document.versions.length;
	const discussJobId = await service.chat({ projectId, message: "这版整体怎么样？", phase: "document" });
	await waitForJob(jobs, discussJobId);
	project = (await service.getProject(projectId)).project;
	checkEqual(project.document.versions.length, beforeDocCount, "纯讨论不产生新成文版本");
	checkEqual(project.conversation.messages.length, 6, "纯讨论也记录到共享上下文");
	checkEqual(project.conversation.messages[5].action, null, "纯讨论消息无版本动作");

	// ── 错误路径 ────────────────────────────────────────────────────────────
	await expectAppError(() => service.generateDocument({ projectId: "doc-not-exist-0000" }), "not-found", "未知项目");
	await expectAppError(() => service.chat({ projectId, message: "", phase: "outline" }), "bad-request", "空消息");
	await expectAppError(() => service.chat({ projectId, message: "x", phase: "unknown" }), "bad-request", "非法 phase");
	const fresh = await service.createProject({ name: "无主题项目", templateId: "free" });
	await expectAppError(() => service.generateOutline({ projectId: fresh.project.id }), "bad-request", "无主题无参考时拒绝生成大纲");
	await expectAppError(() => service.generateDocument({ projectId: fresh.project.id }), "conflict", "未确认大纲时拒绝生成成文");

	// ── 任务串行（busy） ────────────────────────────────────────────────────
	const slow = await service.createProject({ name: "慢任务项目", templateId: "general-report" });
	await service.updateProject({ projectId: slow.project.id, patch: { topic: "串行任务测试" } });
	model.push(() => new Promise((resolve) => setTimeout(() => resolve(OUTLINE_TEXT), 250)));
	const slowJobId = await service.generateOutline({ projectId: slow.project.id });
	await expectAppError(() => service.generateOutline({ projectId: slow.project.id }), "busy", "同项目并发任务被拒绝");
	await expectAppError(() => service.chat({ projectId: slow.project.id, message: "你好", phase: "outline" }), "busy", "任务进行中拒绝对话");
	const slowJob = await waitForJob(jobs, slowJobId);
	checkEqual(slowJob.status, "done", "慢任务最终完成");

	// ── 删除参考文档 / 项目 ────────────────────────────────────────────────
	const afterRemove = await service.removeReference({ projectId, refId: added.ref.id });
	checkEqual(afterRemove.project.refs.length, 0, "删除参考文档成功");
	await expectAppError(() => service.getProject("DOC-BAD-ID"), "bad-request", "非法项目 id 被拒绝");
	await service.deleteProject({ projectId: fresh.project.id });
	const list = await service.listProjects();
	check(!list.projects.some((item) => item.id === fresh.project.id), "删除项目后列表不再包含");

	// ── 项目模型选择 ────────────────────────────────────────────────────────
	await service.updateProject({ projectId, patch: { model: { provider: "mock", model: "mock-1" } } });
	model.push(OUTLINE_TEXT);
	const modelJobId = await service.generateOutline({ projectId });
	await waitForJob(jobs, modelJobId);
	const modelCall = model.calls[model.calls.length - 1];
	checkEqual(modelCall.preferred, { provider: "mock", model: "mock-1" }, "项目模型选择被传入模型调用");

	console.log("\nALL SERVICE TESTS PASSED");
} finally {
	await cleanup();
}

summary("test-service");
