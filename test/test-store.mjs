/**
 * lib/store.js 离线测试（无测试框架，直接 node test/test-store.mjs）。
 *
 * 覆盖：目录初始化、索引读写与派生 Summary、项目/会话/参考/大纲/成文持久化、
 * 原子写（无 .tmp 残留）、id 与版本校验（防路径穿越）、损坏文件容错、删除与临时目录。
 * 所有数据写入 fs.mkdtemp(os.tmpdir()) 创建的临时目录，结束时清理，绝不触碰 ~/.dsh。
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createStore } from "../lib/store.js";

const NOW = 1_700_000_000_000;

/** 测试用例集合。 */
const tests = [];

/**
 * 注册一个测试用例。
 * @param {string} name 用例名
 * @param {() => Promise<void>} fn 用例函数
 */
function test(name, fn) {
	tests.push({ name, fn });
}

/**
 * 构造一个字段完整的 Project 测试对象。
 * @param {string} id 项目 id
 * @param {object} [overrides] 覆盖字段
 * @returns {object}
 */
function makeProject(id, overrides = {}) {
	return {
		id,
		name: "季度经营分析报告",
		createdAt: NOW,
		updatedAt: NOW,
		templateId: "general-report",
		topic: "分析三季度经营情况，给出四季度建议",
		style: { audience: "management", tone: "formal", length: "detailed" },
		model: null,
		refs: [
			{
				id: "ref-1",
				name: "经营数据.xlsx",
				size: 1024,
				ext: "xlsx",
				status: "error",
				error: "不支持的文件格式",
				chars: 0,
				truncated: false,
				method: "text",
				addedAt: NOW,
			},
			{
				id: "ref-2",
				name: "季度总结.docx",
				size: 2048,
				ext: "docx",
				status: "ready",
				error: null,
				chars: 512,
				truncated: false,
				method: "docx",
				addedAt: NOW + 1,
			},
		],
		redlines: [{ id: "rl-builtin-1", text: "术语统一", builtin: true }],
		webSearch: { enabled: false, queries: [], lastSearchAt: null },
		sources: [],
		outline: {
			active: 2,
			confirmed: 2,
			versions: [
				{
					version: 1,
					title: "季度经营分析报告",
					sectionCount: 6,
					chars: 800,
					createdAt: NOW,
					changeNote: "初始生成",
					status: "draft",
					sourceCount: 0,
				},
				{
					version: 2,
					title: "季度经营分析报告",
					sectionCount: 7,
					chars: 900,
					createdAt: NOW + 10,
					changeNote: "用户对话调整",
					status: "confirmed",
					sourceCount: 0,
				},
			],
		},
		document: {
			active: 1,
			versions: [
				{
					version: 1,
					outlineVersion: 2,
					title: "季度经营分析报告",
					wordCount: 2310,
					createdAt: NOW + 20,
					format: ["md"],
					model: null,
					validation: [],
				},
			],
		},
		warnings: ["Word 导出失败，已保留 Markdown"],
		stage: "document",
		...overrides,
	};
}

/**
 * 递归检查目录里没有原子写遗留的 `.xxx.tmp` 文件。
 * @param {string} dir 目录
 * @returns {Promise<string[]>} 残留临时文件路径
 */
async function findTempFiles(dir) {
	const found = [];
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await findTempFiles(full)));
		else if (entry.name.endsWith(".tmp")) found.push(full);
	}
	return found;
}

/**
 * 判断路径是否存在。
 * @param {string} target 路径
 * @returns {Promise<boolean>}
 */
async function exists(target) {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "doc-creator-store-"));
const store = createStore(path.join(tmpRoot, "data"));

test("ensureDirs 创建数据目录、projects 与 tmp 目录", async () => {
	const dirs = await store.ensureDirs();
	assert.equal(path.resolve(store.dataDir), path.resolve(path.join(tmpRoot, "data")));
	assert.equal(store.projectsRoot, path.join(store.dataDir, "projects"));
	assert.ok(await exists(store.dataDir));
	assert.ok(await exists(store.projectsRoot));
	assert.ok(await exists(path.join(store.dataDir, "tmp")));
	assert.deepEqual(dirs, {
		dataDir: store.dataDir,
		projectsRoot: store.projectsRoot,
		tmpRoot: path.join(store.dataDir, "tmp"),
	});
});

test("loadIndex：索引缺失时返回空索引", async () => {
	assert.deepEqual(await store.loadIndex(), { projects: {} });
	assert.deepEqual(await store.listProjects(), []);
});

test("assertId：接受合法 id、拒绝路径穿越与非法字符", () => {
	for (const id of ["doc-1", "doc-m1a2b3c4-9f0e", "a", "z9", "a".repeat(65), "ref-1-2"]) {
		assert.equal(store.assertId(id), id);
	}
	for (const id of ["", " ", "Doc-1", "-doc", "doc_1", "../doc", "doc/1", "doc 1", "a".repeat(66), "文档", null, undefined, 1]) {
		assert.throws(() => store.assertId(id), /非法/, `应拒绝 ${String(id)}`);
	}
	// 存储层自身的路径方法同样受保护
	assert.throws(() => store.projectDir("../escape"), /非法/);
	assert.throws(() => store.refDir("doc-1", "../../x"), /非法/);
});

test("genId：格式为 <prefix>-<base36 时间戳>-<8 位十六进制> 且唯一", () => {
	const ids = new Set();
	// 1000 个 id 集中生成：若随机部分退化回 4 位 hex（65536 空间），碰撞概率 >99%，可稳定暴露回归
	for (let index = 0; index < 1000; index += 1) {
		const id = store.genId("doc");
		assert.match(id, /^doc-[a-z0-9]+-[0-9a-f]{8}$/);
		assert.equal(store.assertId(id), id);
		ids.add(id);
	}
	assert.equal(ids.size, 1000, "1000 个 id 应互不重复");
	assert.match(store.genId("ref"), /^ref-/);
	assert.match(store.genId("MSG"), /^msg-/);
	assert.match(store.genId(""), /^id-/);
});

test("writeProject：原子写 meta.json 并派生 Summary", async () => {
	const project = makeProject("doc-main-0001");
	const summary = await store.writeProject(project);
	const dir = store.projectDir(project.id);

	const metaRaw = await readFile(path.join(dir, "meta.json"), "utf8");
	assert.ok(metaRaw.startsWith('{\n "id"'), "JSON 使用 1 空格缩进");
	assert.deepEqual(JSON.parse(metaRaw), project);
	assert.deepEqual(await store.readProject(project.id), project);

	const expected = {
		id: "doc-main-0001",
		name: "季度经营分析报告",
		createdAt: NOW,
		updatedAt: NOW,
		stage: "document",
		templateId: "general-report",
		refsCount: 2,
		outlineCount: 2,
		outlineActive: 2,
		confirmed: 2,
		documentCount: 1,
		documentActive: 1,
		lastMessageAt: 0,
	};
	assert.deepEqual(summary, expected);

	const indexRaw = JSON.parse(await readFile(path.join(store.dataDir, "index.json"), "utf8"));
	assert.deepEqual(indexRaw.projects["doc-main-0001"], expected);
	assert.deepEqual((await store.listProjects()).find((item) => item.id === project.id), expected);
	assert.deepEqual(await findTempFiles(dir), [], "不应残留 .tmp 文件");
});

test("Summary 阶段派生：setup / outline / document", async () => {
	const base = { createdAt: NOW, updatedAt: NOW + 1 };
	const setup = makeProject("doc-stage-0001", {
		...base,
		outline: { active: 0, confirmed: null, versions: [] },
		document: { active: null, versions: [] },
	});
	const outline = makeProject("doc-stage-0002", {
		...base,
		outline: {
			active: 1,
			confirmed: null,
			versions: [{ version: 1, title: "t", sectionCount: 2, chars: 10, createdAt: NOW, changeNote: "初始生成", status: "draft", sourceCount: 0 }],
		},
		document: { active: null, versions: [] },
	});
	await store.writeProject(setup);
	await store.writeProject(outline);
	const summaries = await store.listProjects();
	const byId = new Map(summaries.map((item) => [item.id, item]));
	assert.equal(byId.get("doc-stage-0001").stage, "setup");
	assert.equal(byId.get("doc-stage-0001").confirmed, null);
	assert.equal(byId.get("doc-stage-0002").stage, "outline");
	assert.equal(byId.get("doc-stage-0002").confirmed, null);
	assert.equal(byId.get("doc-main-0001").stage, "document");
});

test("listProjects：updatedAt 降序（同时按 id 稳定排序）", async () => {
	for (const [index, updatedAt] of [
		["doc-order-a", NOW + 300],
		["doc-order-b", NOW + 500],
		["doc-order-c", NOW + 100],
	]) {
		await store.writeProject(makeProject(index, { updatedAt }));
	}
	const ids = (await store.listProjects()).map((item) => item.id);
	assert.ok(ids.indexOf("doc-order-b") < ids.indexOf("doc-order-a"));
	assert.ok(ids.indexOf("doc-order-a") < ids.indexOf("doc-order-c"));
});

test("会话：缺失返回空、写入读回并刷新 lastMessageAt", async () => {
	assert.deepEqual(await store.readConversation("doc-main-0001"), { messages: [] });

	const messages = [
		{ id: "msg-1", role: "user", content: "把第三节写详细些", phase: "outline", at: NOW + 1000, error: false, action: null },
		{ id: "msg-2", role: "assistant", content: "已更新大纲", phase: "outline", at: NOW + 2000, error: false, action: { kind: "outline", version: 2 } },
	];
	const written = await store.writeConversation("doc-main-0001", { messages });
	assert.deepEqual(written, { messages });
	assert.deepEqual(await store.readConversation("doc-main-0001"), { messages });

	const summary = (await store.listProjects()).find((item) => item.id === "doc-main-0001");
	assert.equal(summary.lastMessageAt, NOW + 2000);
	const index = await store.loadIndex();
	assert.equal(index.projects["doc-main-0001"].lastMessageAt, NOW + 2000);

	// 会话文件损坏时读取退化为空会话
	await writeFile(path.join(store.projectDir("doc-main-0001"), "conversation.json"), "{ not json");
	assert.deepEqual(await store.readConversation("doc-main-0001"), { messages: [] });

	// 写会话时项目不存在也不应抛错
	await store.writeConversation("doc-ghost-0001", { messages: [] });
});

test("readProject：缺失 / 损坏返回 null，非法 id 抛错", async () => {
	assert.equal(await store.readProject("doc-missing-0001"), null);
	assert.throws(() => store.projectDir("../x"), /非法/);

	const dir = store.projectDir("doc-broken-0001");
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "meta.json"), "}{");
	assert.equal(await store.readProject("doc-broken-0001"), null);
});

test("参考文档：目录、原始文件路径净化与文本读写", async () => {
	const dir = store.refDir("doc-main-0001", "ref-0001");
	assert.equal(dir, path.join(store.projectDir("doc-main-0001"), "refs", "ref-0001"));
	assert.equal(store.refSourcePath("doc-main-0001", "ref-0001", "季度总结.docx"), path.join(dir, "source.docx"));
	assert.equal(store.refSourcePath("doc-main-0001", "ref-0001", "a.PDF"), path.join(dir, "source.pdf"));
	assert.equal(store.refSourcePath("doc-main-0001", "ref-0001", "../../etc/passwd"), path.join(dir, "source"));
	assert.equal(store.refSourcePath("doc-main-0001", "ref-0001", "报告 V2 final.docx"), path.join(dir, "source.docx"));
	assert.ok(store.refSourcePath("doc-main-0001", "ref-0001", "../../etc/passwd").startsWith(dir));

	assert.equal(await store.readRefText("doc-main-0001", "ref-0001"), null);
	const text = "第一段\n第二段\t表格";
	const written = await store.writeRefText("doc-main-0001", "ref-0001", text);
	assert.equal(written, path.join(dir, "text.txt"));
	assert.equal(await store.readRefText("doc-main-0001", "ref-0001"), text);
});

test("大纲：版本路径校验与读写", async () => {
	const outline = {
		version: 2,
		title: "季度经营分析报告",
		sections: [
			{ heading: "一、背景", points: ["要点 1", "要点 2"], notes: "写作提示" },
			{ heading: "二、建议", points: ["要点 3"], notes: "" },
		],
		createdAt: NOW,
		model: null,
	};
	assert.equal(store.outlinePath("doc-main-0001", 2), path.join(store.projectDir("doc-main-0001"), "outlines", "2.json"));
	assert.equal(store.outlinePath("doc-main-0001", "2"), path.join(store.projectDir("doc-main-0001"), "outlines", "2.json"));
	await store.writeOutline("doc-main-0001", 2, outline);
	assert.deepEqual(await store.readOutline("doc-main-0001", 2), outline);
	assert.equal(await store.readOutline("doc-main-0001", 99), null);

	for (const bad of [0, -1, 10000, 1.5, "abc", null, undefined]) {
		assert.throws(() => store.outlinePath("doc-main-0001", bad), /非法版本号/, `应拒绝版本号 ${String(bad)}`);
	}
	assert.throws(() => store.outlinePath("../escape", 1), /非法/);

	// 版本文件损坏时返回 null
	await writeFile(store.outlinePath("doc-main-0001", 3), "oops");
	assert.equal(await store.readOutline("doc-main-0001", 3), null);
});

test("成文：Markdown / Word 字节读写与扩展名校验", async () => {
	const mdPath = store.documentPath("doc-main-0001", 1, "md");
	assert.equal(mdPath, path.join(store.projectDir("doc-main-0001"), "documents", "1.md"));
	assert.equal(store.documentPath("doc-main-0001", 1, ".DOCX").endsWith("1.docx"), true);

	const markdown = "# 标题\n\n正文内容。\n";
	await store.writeDocumentFile("doc-main-0001", 1, "md", markdown);
	const mdBuffer = await store.readDocumentFile("doc-main-0001", 1, "md");
	assert.ok(Buffer.isBuffer(mdBuffer));
	assert.equal(mdBuffer.toString("utf8"), markdown);

	const docxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
	await store.writeDocumentFile("doc-main-0001", 1, "docx", docxBytes);
	const docxBuffer = await store.readDocumentFile("doc-main-0001", 1, "docx");
	assert.ok(Buffer.isBuffer(docxBuffer));
	assert.deepEqual([...docxBuffer], [...docxBytes]);

	// ArrayBuffer 也可写入
	await store.writeDocumentFile("doc-main-0001", 2, "md", new TextEncoder().encode("# v2").buffer);
	assert.equal((await store.readDocumentFile("doc-main-0001", 2, "md")).toString("utf8"), "# v2");

	assert.equal(await store.readDocumentFile("doc-main-0001", 99, "md"), null);
	assert.throws(() => store.documentPath("doc-main-0001", 1, "exe"), /非法成文格式/);
	assert.throws(() => store.documentPath("doc-main-0001", 0, "md"), /非法版本号/);
	await assert.rejects(() => store.writeDocumentFile("doc-main-0001", 3, "md", 123), /字符串或 Uint8Array/);

	const files = await readdir(path.join(store.projectDir("doc-main-0001"), "documents"));
	assert.deepEqual(files.sort(), ["1.docx", "1.md", "2.md"]);
});

test("saveIndex / loadIndex：往返一致，非法索引结构退化为空", async () => {
	const index = {
		projects: {
			"doc-index-0001": {
				id: "doc-index-0001",
				name: "索引测试",
				createdAt: NOW,
				updatedAt: NOW,
				stage: "setup",
				templateId: "free",
				refsCount: 0,
				outlineCount: 0,
				outlineActive: 0,
				confirmed: null,
				documentCount: 0,
				documentActive: null,
				lastMessageAt: 0,
			},
		},
	};
	await store.saveIndex(index);
	assert.deepEqual(await store.loadIndex(), index);
	assert.equal((await store.listProjects()).find((item) => item.id === "doc-index-0001").stage, "setup");

	await writeFile(path.join(store.dataDir, "index.json"), JSON.stringify({ projects: "oops" }));
	assert.deepEqual(await store.loadIndex(), { projects: {} });
	assert.deepEqual(await store.listProjects(), []);
});

test("deleteProject：删除目录与索引，幂等", async () => {
	const project = makeProject("doc-del-0001");
	await store.writeProject(project);
	assert.ok(await exists(store.projectDir("doc-del-0001")));
	assert.equal(await store.deleteProject("doc-del-0001"), true);
	assert.equal(await exists(store.projectDir("doc-del-0001")), false);
	assert.equal((await store.listProjects()).some((item) => item.id === "doc-del-0001"), false);
	assert.equal(await store.deleteProject("doc-del-9999"), false);
	await assert.rejects(() => store.deleteProject("../x"), /非法/);
});

test("writeConversation 不覆盖索引中的其他项目", async () => {
	await store.writeProject(makeProject("doc-keep-0001"));
	await store.writeConversation("doc-keep-0001", {
		messages: [{ id: "msg-9", role: "user", content: "hi", phase: "document", at: NOW + 9, error: false, action: null }],
	});
	const index = await store.loadIndex();
	assert.ok(index.projects["doc-keep-0001"]);
	assert.equal(index.projects["doc-keep-0001"].lastMessageAt, NOW + 9);
});

test("tmpDir：mkdtemp 生成 tmp 下的独立目录", async () => {
	const first = await store.tmpDir();
	const second = await store.tmpDir();
	assert.ok(await exists(first));
	assert.ok(await exists(second));
	assert.notEqual(first, second);
	assert.equal(path.dirname(first), path.join(store.dataDir, "tmp"));
	assert.ok(path.basename(first).startsWith("upload-"));
});

test("writeProject：拒绝非法 id 且不落盘", async () => {
	await assert.rejects(() => store.writeProject({ id: "../evil" }), /非法/);
	assert.equal(await exists(path.join(store.dataDir, "projects", "..", "evil")), false);
	await assert.rejects(() => store.writeProject(null), /项目对象/);
});

let failures = 0;
for (const item of tests) {
	try {
		await item.fn();
		console.log(`PASS ${item.name}`);
	} catch (error) {
		failures += 1;
		console.error(`FAIL ${item.name}`);
		console.error(error?.stack ?? error);
	}
}
await rm(tmpRoot, { recursive: true, force: true });
console.log(`\n${tests.length - failures}/${tests.length} store tests passed`);
if (failures > 0) process.exit(1);
console.log("ALL STORE TESTS PASS");
