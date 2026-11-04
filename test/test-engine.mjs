// test/test-engine.mjs —— lib/engine.js 的离线单元测试
//
// 全部使用假的 callModel / search，不联网、不读写磁盘、不触碰 ~/.dsh。
// 运行：node test/test-engine.mjs，输出 PASS/FAIL，失败时退出码 1。

import {
	createEngine,
	parseArtifact,
	extractJson,
	normalizeOutline,
	normalizeDocumentMarkdown,
	normalizeReport,
} from "../lib/engine.js";

/* ───────────────────────── 极简断言框架 ───────────────────────── */

const state = { pass: 0, fail: 0, failures: [] };

function fmt(value) {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function ok(name, condition, detail = "") {
	if (condition) {
		state.pass++;
		console.log(`PASS ${name}`);
		return;
	}
	state.fail++;
	state.failures.push(name);
	console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(name, actual, expected) {
	const actualText = fmt(actual);
	const expectedText = fmt(expected);
	ok(name, actualText === expectedText, `期望 ${expectedText}，实际 ${actualText}`);
}

function includes(name, haystack, needle) {
	ok(name, String(haystack ?? "").includes(needle), `未找到片段：${needle}`);
}

function notIncludes(name, haystack, needle) {
	ok(name, !String(haystack ?? "").includes(needle), `不应出现片段：${needle}`);
}

function countOf(text, needle) {
	return String(text ?? "").split(needle).length - 1;
}

/* ───────────────────────── 测试替身 ───────────────────────── */

/** 假 callModel：responses 可以是字符串 / 对象 / Error / 函数；记录每次调用参数。 */
function makeModel(responses) {
	const calls = [];
	async function callModel(payload) {
		calls.push(payload);
		const index = calls.length - 1;
		let response;
		if (typeof responses === "function") response = responses(payload, index);
		else if (Array.isArray(responses)) response = responses[Math.min(index, responses.length - 1)];
		else response = responses;
		if (response instanceof Error) throw response;
		return typeof response === "string" ? { text: response } : response;
	}
	return { callModel, calls };
}

/** 假 search：记录调用；默认返回空结果，可传入函数返回值或抛错。 */
function makeSearch(handler = () => ({ sources: [] })) {
	const calls = [];
	async function search(payload) {
		calls.push(payload);
		return handler(payload, calls.length - 1);
	}
	return { search, calls };
}

function promptOf(calls, index = 0) {
	return calls[index]?.messages?.[0]?.content ?? "";
}

/* ───────────────────────── 固定夹具 ───────────────────────── */

const TEMPLATE = {
	id: "project-plan",
	name: "项目方案 / 立项报告",
	description: "用于项目立项、建设方案与实施方案",
	category: "方案",
	sections: [
		{ heading: "一、项目背景", hint: "说明项目由来、现状痛点与政策/业务背景" },
		{ heading: "二、目标与范围", hint: "写清建设目标、覆盖范围与边界" },
		{ heading: "三、建设内容", hint: "分模块说明建设内容与技术路线" },
		{ heading: "四、实施计划", hint: "分期、里程碑与资源投入" },
		{ heading: "五、风险与保障", hint: "风险识别、应对措施与保障机制" },
	],
	defaults: { audience: "management", tone: "formal", length: "standard" },
	redlines: ["数据必须有来源"],
};

const FREE_TEMPLATE = {
	id: "free",
	name: "自由发挥",
	description: "自行设计文档结构",
	category: "通用",
	sections: [],
	defaults: { audience: "general", tone: "professional", length: "standard" },
	redlines: [],
};

const OUTLINE_FIXTURE = {
	title: "智慧园区建设方案",
	sections: [
		{ heading: "一、项目背景", points: ["说明园区现状与痛点", "梳理政策与业务驱动"], notes: "用 2 段说明" },
		{ heading: "二、建设目标与范围", points: ["明确总体目标", "界定建设边界"] },
		{ heading: "三、建设内容", points: ["安防子系统", "能耗管理", "运营平台"] },
	],
};

function makeProject(overrides = {}) {
	return {
		id: "doc-fixture",
		name: "智慧园区建设方案",
		topic: "为某产业园区编写智慧化建设方案，覆盖安防、能耗与运营平台，重点说明投资回报与分期实施。",
		templateId: "project-plan",
		style: { audience: "management", tone: "formal", length: "standard" },
		refs: [],
		redlines: [
			{ id: "rl-1", text: "不得出现虚假数据与未经验证的引用", builtin: true },
			{ id: "rl-2", text: "必须说明投资回报与分期实施", builtin: true },
		],
		webSearch: { enabled: false, queries: [], lastSearchAt: null },
		sources: [],
		outline: { active: 0, confirmed: null, versions: [] },
		document: { active: null, versions: [] },
		conversation: { messages: [] },
		...overrides,
	};
}

function makeJob() {
	const updates = [];
	return {
		updates,
		update(progress, message) {
			updates.push({ progress, message });
		},
	};
}

function jsonOutline(outline) {
	return `<OUTLINE>${JSON.stringify(outline)}</OUTLINE>`;
}

/* ═════════════════════════ extractJson ═════════════════════════ */

function testExtractJson() {
	console.log("\n# extractJson");

	eq("extractJson：纯 JSON 对象", extractJson('{"a":1,"b":"x"}'), { a: 1, b: "x" });
	eq(
		"extractJson：Markdown 围栏 + 前后说明文字",
		extractJson('结果如下：\n```json\n{"title":"T","sections":[]}\n```\n请查收。'),
		{ title: "T", sections: [] },
	);
	eq("extractJson：容忍尾随逗号", extractJson('{"a":1,"b":[2,3,],}'), { a: 1, b: [2, 3] });
	eq(
		"extractJson：跳过字符串内的花括号/方括号",
		extractJson('说明 {"text":"包含 } 和 { 的字符串","ok":true} 结束'),
		{ text: "包含 } 和 { 的字符串", ok: true },
	);
	eq("extractJson：处理转义引号", extractJson('{"a":"他说：\\"你好\\"","b":2}'), { a: '他说："你好"', b: 2 });
	eq(
		"extractJson：字符串内的「,}」不被尾随逗号修复破坏",
		extractJson('{"text":"逗号,} 在字符串里","ok":true}'),
		{ text: "逗号,} 在字符串里", ok: true },
	);
	eq(
		"extractJson：跳过无效候选继续扫描",
		extractJson('说明 {不是 JSON} 然后 {"a":2} 结束'),
		{ a: 2 },
	);
	eq("extractJson：无 JSON 返回 null", extractJson("这里没有任何 JSON，只有中文说明。"), null);
	eq("extractJson：括号不闭合返回 null", extractJson('{"a":1'), null);
	eq("extractJson：非字符串输入返回 null", extractJson(undefined), null);
}

/* ═════════════════════════ parseArtifact ═════════════════════════ */

function testParseArtifact() {
	console.log("\n# parseArtifact");

	const withTags = parseArtifact(
		'已生成大纲，请确认。\n<OUTLINE>{"title":"T","sections":[{"heading":"H1"},{"heading":"H2"}]}</OUTLINE>\n<REPORT>[{"label":"a","status":"pass"}]</REPORT>',
	);
	eq("parseArtifact：reply 取第一个标签之前的文本", withTags.reply, "已生成大纲，请确认。");
	eq("parseArtifact：解析 OUTLINE 标签", withTags.outline.title, "T");
	eq("parseArtifact：解析 REPORT 标签", withTags.report, [{ label: "a", status: "pass" }]);

	const docTitled = parseArtifact("<DOCUMENT>\n# 标题\n\n正文包含 <标签> 与 **加粗**。\n</DOCUMENT>");
	eq("parseArtifact：DOCUMENT 标签外无文字时 reply 为空", docTitled.reply, "");
	includes("parseArtifact：DOCUMENT 内容保留 Markdown 与尖括号文本", docTitled.document, "正文包含 <标签> 与 **加粗**。");

	const unclosed = parseArtifact('<OUTLINE>{"title":"T","sections":[{"heading":"H1"}]}');
	eq("parseArtifact：缺少闭合标签时取到末尾", unclosed.outline.title, "T");

	const plain = parseArtifact("这只是讨论，不会修改任何内容。");
	eq("parseArtifact：纯文本时整段作为 reply", plain.reply, "这只是讨论，不会修改任何内容。");
	ok(
		"parseArtifact：纯文本不会被误判为成文/大纲/报告",
		plain.document === undefined && plain.outline === undefined && plain.report === undefined,
	);
	eq("parseArtifact：空 DOCUMENT 标签不产出成文", parseArtifact("<DOCUMENT></DOCUMENT>").document, undefined);

	const fenced = parseArtifact(
		'前言\n```json\n{"title":"自由","sections":[{"heading":"第一节"},{"heading":"第二节"}]}\n```',
	);
	eq("parseArtifact：无标签时用围栏 JSON 回退大纲", fenced.outline.sections.length, 2);

	const jsonReply = parseArtifact(
		'{"reply":"已更新版本","outline":{"title":"T2","sections":[{"heading":"A"},{"heading":"B"}]}}',
	);
	eq("parseArtifact：JSON 回退 {reply, outline}", jsonReply.reply, "已更新版本");
	eq("parseArtifact：JSON 回退的大纲 hook", jsonReply.outline.title, "T2");

	const jsonDoc = parseArtifact('{"reply":"已重写","markdown":"# T\\n\\n正文"}');
	eq("parseArtifact：JSON 回退 {reply, markdown}", jsonDoc.document, "# T\n\n正文");

	const rawReport = parseArtifact(
		'[{"label":"红线一","status":"pass","note":"ok"},{"label":"红线二","status":"risk","note":"位置"}]',
	);
	eq("parseArtifact：裸 JSON 数组回退为自检报告", rawReport.report.length, 2);
	eq("parseArtifact：裸 JSON 报告保留状态", rawReport.report[1].status, "risk");

	const lowerTag = parseArtifact('好的，已调整。\n<outline>{"title":"小写","sections":[{"heading":"A"},{"heading":"B"}]}</outline>');
	eq("parseArtifact：标签大小写不敏感（reply）", lowerTag.reply, "好的，已调整。");
	eq("parseArtifact：标签大小写不敏感（outline）", lowerTag.outline.title, "小写");

	const fencedDoc = parseArtifact("<DOCUMENT>\n```markdown\n# T\n\n正文\n```\n</DOCUMENT>");
	eq("parseArtifact：成文标签内的整段围栏被剥掉", fencedDoc.document, "# T\n\n正文");
}

/* ═════════════════════════ 归一化 ═════════════════════════ */

function testNormalize() {
	console.log("\n# normalizeOutline / normalizeDocumentMarkdown / normalizeReport");
	const project = makeProject();

	const normalized = normalizeOutline(
		{
			title: "",
			sections: [
				{
					heading: "## 一、背景",
					points: [" 要点 A ", "要点 A", "  ", ...Array.from({ length: 9 }, (_, index) => `补充要点 ${index}`)],
					notes: " 提示 ",
				},
				{ heading: "二、目标", points: "单行要点 1\n单行要点 2" },
			],
		},
		{ project, template: TEMPLATE },
	);
	eq("normalizeOutline：title 缺省用 project.name", normalized.title, project.name);
	eq("normalizeOutline：heading 去掉 Markdown 标记", normalized.sections[0].heading, "一、背景");
	eq("normalizeOutline：points 去重并最多 8 条", normalized.sections[0].points.length, 8);
	eq("normalizeOutline：points 去除首尾空白", normalized.sections[0].points[0], "要点 A");
	eq("normalizeOutline：notes 去除首尾空白", normalized.sections[0].notes, "提示");
	eq("normalizeOutline：字符串 points 按行拆分", normalized.sections[1].points, ["单行要点 1", "单行要点 2"]);

	const paddedEmpty = normalizeOutline({ title: "T", sections: [] }, { project, template: TEMPLATE });
	eq("normalizeOutline：空 sections 用模板骨架补到 2 节", paddedEmpty.sections.length, 2);
	eq("normalizeOutline：补的第一节来自模板骨架", paddedEmpty.sections[0].heading, "一、项目背景");
	includes("normalizeOutline：补的节保留模板 hint 到 notes", paddedEmpty.sections[0].notes, "说明项目由来");

	const paddedOne = normalizeOutline(
		{ title: "T", sections: [{ heading: "一、项目背景", points: ["p"] }] },
		{ project, template: TEMPLATE },
	);
	eq("normalizeOutline：只有 1 节时补到 2 节", paddedOne.sections.length, 2);
	eq("normalizeOutline：补的节不重复已有标题", paddedOne.sections[1].heading, "二、目标与范围");

	const fromArray = normalizeOutline([{ heading: "第一节" }, { heading: "第二节" }], { project, template: TEMPLATE });
	eq("normalizeOutline：接受章节数组输入", fromArray.sections.length, 2);
	eq("normalizeOutline：章节数组输入的 title 兜底", fromArray.title, project.name);

	const custom = normalizeOutline({ title: "自定义标题", sections: [{ heading: "A" }, { heading: "B" }] }, {});
	eq("normalizeOutline：显式 title 优先", custom.title, "自定义标题");

	const numbered = normalizeOutline(
		{ sections: [{ heading: "H", points: ["1. 第一点", "- 第二点"] }] },
		{ project: makeProject({ name: "兜底" }) },
	);
	eq("normalizeOutline：points 去除编号与列表符号", numbered.sections[0].points, ["第一点", "第二点"]);

	const topicFallback = normalizeOutline(
		{ sections: [{ heading: "A" }, { heading: "B" }] },
		{ project: makeProject({ name: "", topic: "这是一段没有项目名时使用的主题文本，用于验证标题兜底是否截断到前三十个字" }) },
	);
	eq(
		"normalizeOutline：name 为空时用主题前 30 字兜底标题",
		topicFallback.title,
		"这是一段没有项目名时使用的主题文本，用于验证标题兜底是否截断到前三十个字".slice(0, 30),
	);

	const doc1 = normalizeDocumentMarkdown("正文第一段……", { title: "标题 T" });
	eq("normalizeDocumentMarkdown：缺失一级标题时补「# 标题」", doc1.markdown, "# 标题 T\n\n正文第一段……");
	eq("normalizeDocumentMarkdown：返回标题", doc1.title, "标题 T");

	const doc2 = normalizeDocumentMarkdown("```markdown\n# 已有标题\n\n正文\n```", { title: "忽略" });
	eq("normalizeDocumentMarkdown：剥掉整段围栏", doc2.markdown, "# 已有标题\n\n正文");

	const doc3 = normalizeDocumentMarkdown("<DOCUMENT>\n# 标签标题\n\n正文\n</DOCUMENT>", { title: "x" });
	eq("normalizeDocumentMarkdown：剥掉残留 DOCUMENT 标签", doc3.markdown, "# 标签标题\n\n正文");

	const doc4 = normalizeDocumentMarkdown("前言说明\n\n正文\n", { title: "X" });
	includes("normalizeDocumentMarkdown：无标题时补标题并不丢正文", doc4.markdown, "# X\n\n前言说明\n\n正文");

	const report = normalizeReport(
		[{ label: "", status: "风险", note: 42 }, { label: "第二条", status: "通过", note: "" }],
		["红线一", { text: "红线二" }, "红线三"],
	);
	eq("normalizeReport：条数与红线一致（缺失补 unknown）", report.length, 3);
	eq("normalizeReport：label 缺失回退红线原文", report[0].label, "红线一");
	eq("normalizeReport：状态「风险」归一化为 risk", report[0].status, "risk");
	eq("normalizeReport：非字符串 note 转字符串", report[0].note, "42");
	eq("normalizeReport：状态「通过」归一化为 pass", report[1].status, "pass");
	eq("normalizeReport：空 note 使用默认说明", report[1].note.length > 0, true);
	eq("normalizeReport：缺失项状态为 unknown", report[2].status, "unknown");
	eq("normalizeReport：缺失项 label 回退红线原文", report[2].label, "红线三");
}

/* ═════════════════════════ planSearchQueries ═════════════════════════ */

async function testPlanSearchQueries() {
	console.log("\n# planSearchQueries");

	const project = makeProject();
	const search = makeSearch();
	const first = makeModel("x");
	const engineA = createEngine({ callModel: first.callModel, search: search.search });
	const engineB = createEngine({ callModel: makeModel("y").callModel, search: makeSearch().search });

	const queriesA = engineA.planSearchQueries({ project, template: TEMPLATE });
	const queriesB = engineB.planSearchQueries({ project, template: TEMPLATE });
	eq("planSearchQueries：同一输入两次结果一致", queriesA, queriesB);
	ok("planSearchQueries：返回 2–4 条查询", queriesA.length >= 2 && queriesA.length <= 4, `实际 ${queriesA.length}`);
	ok(
		"planSearchQueries：每条都是非空字符串",
		queriesA.every((query) => typeof query === "string" && query.trim().length > 0),
	);
	eq("planSearchQueries：查询不重复", new Set(queriesA).size, queriesA.length);
	includes("planSearchQueries：查询包含项目名", queriesA[0], "智慧园区建设方案");
	includes("planSearchQueries：查询包含模板名（非自由发挥）", queriesA.join(" | "), "项目方案");
	ok("planSearchQueries：不调用 callModel", first.calls.length === 0);

	const freeQueries = engineA.planSearchQueries({
		project: makeProject({ name: "年度个人总结", topic: "" }),
		template: FREE_TEMPLATE,
	});
	ok("planSearchQueries：自由发挥模板也返回 2–4 条", freeQueries.length >= 2 && freeQueries.length <= 4);
	ok(
		"planSearchQueries：无 undefined/null 文本",
		freeQueries.every((query) => !/undefined|null/.test(query)),
	);

	const blankQueries = engineA.planSearchQueries({ project: makeProject({ name: "", topic: "" }), template: null });
	ok("planSearchQueries：空项目也能给出兜底查询", blankQueries.length >= 2);
}

/* ═════════════════════════ createEngine ═════════════════════════ */

async function testCreateEngine() {
	console.log("\n# createEngine");

	let thrown = null;
	try {
		createEngine({});
	} catch (error) {
		thrown = error;
	}
	ok("createEngine：缺少 callModel 时抛 TypeError", thrown instanceof TypeError);

	const engine = createEngine({
		callModel: makeModel("x").callModel,
		search: makeSearch().search,
		logger: { warn() {} },
	});
	for (const method of ["planSearchQueries", "generateOutline", "generateDocument", "revise", "checkRedlines"]) {
		eq(`createEngine：暴露 ${method}`, typeof engine[method], "function");
	}

	// 无状态：两个引擎实例各自绑定自己的 callModel，互不影响
	const modelA = makeModel(jsonOutline(OUTLINE_FIXTURE));
	const modelB = makeModel(jsonOutline(OUTLINE_FIXTURE));
	const engineA = createEngine({ callModel: modelA.callModel });
	const engineB = createEngine({ callModel: modelB.callModel });
	await engineA.generateOutline({ project: makeProject(), template: TEMPLATE, references: [] });
	eq("createEngine：实例 A 只调用自己的模型", modelA.calls.length, 1);
	eq("createEngine：实例 A 不触发实例 B 的模型", modelB.calls.length, 0);
	await engineB.generateOutline({ project: makeProject(), template: TEMPLATE, references: [] });
	eq("createEngine：实例 B 独立调用自己的模型", modelB.calls.length, 1);
}

/* ═════════════════════════ generateOutline ═════════════════════════ */

async function testGenerateOutline() {
	console.log("\n# generateOutline");

	const project = makeProject({
		conversation: {
			messages: [
				{ id: "m1", role: "user", content: "我想突出投资回报和分期实施。", phase: "outline", error: false },
				{ id: "m2", role: "assistant", content: "好的，会在大纲中体现。", phase: "outline", error: false },
			],
		},
	});
	const references = [{ name: "现状调研.docx", text: "园区现有安防系统老化，能耗数据分散在多个系统。" }];
	const sources = [
		{ id: "src-1", title: "智慧园区白皮书", url: "https://example.com/whitepaper", snippet: "智慧园区强调数据打通。" },
	];
	const canned = jsonOutline({
		title: "",
		sections: [
			{
				heading: "## 一、项目背景",
				points: ["痛点 1", "痛点 1", "痛点 2", "", "3", "4", "5", "6", "7", "8", "9"],
				notes: " 用两段说明 ",
			},
			{ heading: "二、建设目标", points: "目标 1\n目标 2\n目标 3" },
		],
	});
	const model = makeModel(canned);
	const search = makeSearch();
	const engine = createEngine({ callModel: model.callModel, search: search.search });
	const job = makeJob();

	const result = await engine.generateOutline({ project, template: TEMPLATE, references, sources, job });

	eq("generateOutline：title 缺省用 project.name", result.outline.title, project.name);
	eq("generateOutline：heading 去掉 Markdown 标记", result.outline.sections[0].heading, "一、项目背景");
	eq("generateOutline：points 去重并最多 8 条", result.outline.sections[0].points.length, 8);
	eq("generateOutline：notes 去除首尾空白", result.outline.sections[0].notes, "用两段说明");
	eq("generateOutline：字符串 points 按行拆分", result.outline.sections[1].points.length, 3);
	eq("generateOutline：结果只有 outline / warnings", result.sources, undefined);
	eq("generateOutline：无联网资料时不产生 warning（未启用联网）", result.warnings, []);
	eq("generateOutline：不自行发起联网检索", search.calls.length, 0);

	eq("generateOutline：只调用一次模型", model.calls.length, 1);
	eq("generateOutline：maxTokens=4000", model.calls[0].maxTokens, 4000);
	eq("generateOutline：temperature=0.7", model.calls[0].temperature, 0.7);
	eq("generateOutline：messages 为单条 user 消息", model.calls[0].messages[0].role, "user");

	const system = model.calls[0].system;
	const prompt = promptOf(model.calls);
	includes("generateOutline：system 声明资深中文撰写专家", system, "资深中文文档撰写专家");
	includes("generateOutline：system 写明 OUTLINE 标签协议", system, "<OUTLINE>");
	includes("generateOutline：system 写明不得编造", system, "不得编造");
	includes("generateOutline：prompt 注入模板骨架标题", prompt, "一、项目背景 —— 写作提示：说明项目由来");
	includes("generateOutline：prompt 注入模板骨架完整列表", prompt, "五、风险与保障");
	includes("generateOutline：prompt 注入参考文档名称", prompt, "【参考文档 1：现状调研.docx】");
	includes("generateOutline：prompt 注入参考文档正文", prompt, "园区现有安防系统老化");
	includes("generateOutline：prompt 注入联网资料编号与 URL", prompt, "[1] 智慧园区白皮书 — https://example.com/whitepaper");
	includes("generateOutline：prompt 注入联网资料摘要", prompt, "摘要：智慧园区强调数据打通。");
	includes("generateOutline：prompt 注入红线原文", prompt, "不得出现虚假数据与未经验证的引用");
	includes("generateOutline：prompt 标注红线必须遵守", prompt, "必须遵守，违反即返工");
	includes("generateOutline：prompt 注入风格中文字段", prompt, "读者：管理层；语气：正式严谨；篇幅：标准（约 2000–3500 字）");
	includes("generateOutline：prompt 注入共享对话上下文", prompt, "共享对话上下文");
	includes("generateOutline：prompt 注入历史对话内容", prompt, "我想突出投资回报和分期实施。");
	includes("generateOutline：prompt 要求 6–10 节", prompt, "章节 6–10 节");
	includes("generateOutline：prompt 列出输出要求", prompt, "【输出要求】");
	eq("generateOutline：job 进度接续 service 节奏（30→80→90）", job.updates.map((item) => item.progress), [30, 80, 90]);
	includes("generateOutline：job 提示生成大纲", job.updates.map((item) => item.message).join("|"), "生成大纲");

	// 无标签 + 围栏 JSON 的宽容回退
	const fallbackModel = makeModel('这里是结果：\n```json\n{"title":"T","sections":[{"heading":"甲"},{"heading":"乙"}]}\n```');
	const fallbackEngine = createEngine({ callModel: fallbackModel.callModel, search: search.search });
	const fallbackResult = await fallbackEngine.generateOutline({ project: makeProject(), template: FREE_TEMPLATE, references: [] });
	eq("generateOutline：无标签时回退裸 JSON 大纲", fallbackResult.outline.title, "T");
	eq("generateOutline：回退大纲保持 2 节", fallbackResult.outline.sections.length, 2);

	// 启用联网但 service 未传入 sources → 产生 warning，且不自行检索
	const webProject = makeProject({ webSearch: { enabled: true, queries: [], lastSearchAt: null } });
	const webSearch = makeSearch(() => {
		throw new Error("这个假 search 不应被调用");
	});
	const webEngine = createEngine({ callModel: makeModel(canned).callModel, search: webSearch.search, logger: { warn() {} } });
	const webResult = await webEngine.generateOutline({ project: webProject, template: TEMPLATE, references: [], sources: [] });
	ok("generateOutline：启用联网但无资料时产生 warning", webResult.warnings.some((warning) => warning.includes("联网资料")));
	eq("generateOutline：service 编排检索时引擎不调用 search", webSearch.calls.length, 0);
	eq("generateOutline：联网 warning 不影响大纲生成", webResult.outline.sections.length >= 2, true);

	// 未传 sources 时回退 project.sources 缓存
	const cachedProject = makeProject({
		sources: [{ id: "src-9", title: "缓存资料", url: "https://example.com/cache", snippet: "缓存摘要" }],
	});
	const cachedModel = makeModel(canned);
	const cachedEngine = createEngine({ callModel: cachedModel.callModel });
	await cachedEngine.generateOutline({ project: cachedProject, template: TEMPLATE, references: [] });
	includes("generateOutline：未传 sources 时使用 project.sources 缓存", promptOf(cachedModel.calls), "https://example.com/cache");

	// 参考文档截断预算：单条 ≤6000 字、总量 ≤16000 字
	const longRefs = [
		{ name: "长参考一", text: "甲".repeat(12000) },
		{ name: "长参考二", text: "乙".repeat(12000) },
		{ name: "长参考三", text: "丙".repeat(12000) },
	];
	const truncModel = makeModel(canned);
	const truncEngine = createEngine({ callModel: truncModel.callModel });
	await truncEngine.generateOutline({ project: makeProject(), template: TEMPLATE, references: longRefs });
	const truncPrompt = promptOf(truncModel.calls);
	ok("generateOutline：参考文档单条截断到 6000 字内", countOf(truncPrompt, "甲") === 6000, `甲 出现 ${countOf(truncPrompt, "甲")} 次`);
	ok("generateOutline：参考文档总量不超过 16000 字", countOf(truncPrompt, "甲") + countOf(truncPrompt, "乙") + countOf(truncPrompt, "丙") <= 16000);
	includes("generateOutline：参考文档截断有标注", truncPrompt, "截断");
	includes("generateOutline：参考文档总量截断有标注", truncPrompt, "总摘录已达上限");

	// 联网资料注入预算：总量 ≤6000 字，超出部分不列出
	const manySources = Array.from({ length: 20 }, (_, index) => ({
		id: `src-${index + 1}`,
		title: `资料${index + 1}`,
		url: `https://example.com/long-${index + 1}-${"u".repeat(400)}`,
		snippet: "摘".repeat(400),
	}));
	const sourceModel = makeModel(canned);
	const sourceEngine = createEngine({ callModel: sourceModel.callModel });
	await sourceEngine.generateOutline({ project: makeProject(), template: TEMPLATE, references: [], sources: manySources });
	const sourcePrompt = promptOf(sourceModel.calls);
	includes("generateOutline：联网资料从 [1] 开始编号", sourcePrompt, "[1] 资料1 — https://example.com/long-1-");
	notIncludes("generateOutline：超出预算的资料不列出", sourcePrompt, "long-12-");
	includes("generateOutline：联网资料省略有标注", sourcePrompt, "因长度限制未列出");
	const sourceBlock = sourcePrompt.slice(sourcePrompt.indexOf("【联网资料】"), sourcePrompt.indexOf("【红线要求】"));
	ok(
		"generateOutline：联网资料注入总量 ≤6000 字（含少量标题/标注）",
		sourceBlock.length <= 6300,
		`实际 ${sourceBlock.length} 字`,
	);

	// 无联网资料时提示词明确禁止编造引用
	const noSourceModel = makeModel(canned);
	const noSourceEngine = createEngine({ callModel: noSourceModel.callModel });
	await noSourceEngine.generateOutline({ project: makeProject(), template: TEMPLATE, references: [] });
	const noSourcePrompt = promptOf(noSourceModel.calls);
	includes("generateOutline：无联网资料时提示不要编造引用", noSourcePrompt, "未提供联网资料");
	includes("generateOutline：无参考资料时提示不要编造数据", noSourcePrompt, "未提供参考文档");

	// 模型返回无法解析的内容 → 中文错误
	const badEngine = createEngine({ callModel: makeModel("抱歉，我无法完成这个请求。").callModel });
	let badError = null;
	try {
		await badEngine.generateOutline({ project: makeProject(), template: TEMPLATE, references: [] });
	} catch (error) {
		badError = error;
	}
	ok("generateOutline：无法解析时抛中文错误", Boolean(badError) && badError.message.includes("大纲"));

	// 模型空输出 → 中文错误
	const emptyEngine = createEngine({ callModel: makeModel("   ").callModel });
	let emptyError = null;
	try {
		await emptyEngine.generateOutline({ project: makeProject(), template: TEMPLATE, references: [] });
	} catch (error) {
		emptyError = error;
	}
	ok("generateOutline：模型空输出时抛中文错误", Boolean(emptyError) && emptyError.message.includes("模型未返回"));

	// 模型调用异常向上抛出
	const throwEngine = createEngine({ callModel: makeModel(new Error("上游模型不可用")).callModel });
	let throwError = null;
	try {
		await throwEngine.generateOutline({ project: makeProject(), template: TEMPLATE, references: [] });
	} catch (error) {
		throwError = error;
	}
	eq("generateOutline：模型异常原样抛出", throwError?.message, "上游模型不可用");

	// 模型直接返回章节数组（无 title）也能归一化
	const arrayModel = makeModel('<OUTLINE>[{"heading":"第一章"},{"heading":"第二章"}]</OUTLINE>');
	const arrayEngine = createEngine({ callModel: arrayModel.callModel });
	const arrayResult = await arrayEngine.generateOutline({ project: makeProject(), template: TEMPLATE, references: [] });
	eq("generateOutline：章节数组输出可归一化", arrayResult.outline.sections.length, 2);
	eq("generateOutline：章节数组输出 title 兜底项目名", arrayResult.outline.title, "智慧园区建设方案");
}

/* ═════════════════════════ generateDocument ═════════════════════════ */

function documentCannedMarkdown(title = "智慧园区建设方案") {
	return [
		"<DOCUMENT>",
		"```markdown",
		`# ${title}`,
		"",
		"## 一、项目背景",
		"园区现有安防系统老化，能耗数据分散在各子系统，管理成本逐年上升。",
		"",
		"## 二、建设目标与范围",
		"## 三、建设内容",
		"```",
		"</DOCUMENT>",
	].join("\n");
}

async function testGenerateDocument() {
	console.log("\n# generateDocument");

	const project = makeProject();
	const references = [{ name: "需求说明.md", text: "本期覆盖安防、能耗与运营平台三个子系统。" }];
	const sources = [{ id: "src-1", title: "智慧园区白皮书", url: "https://example.com/whitepaper", snippet: "智慧园区强调数据打通。" }];
	const model = makeModel(documentCannedMarkdown());
	const engine = createEngine({ callModel: model.callModel });
	const job = makeJob();

	const result = await engine.generateDocument({
		project,
		template: TEMPLATE,
		outline: OUTLINE_FIXTURE,
		references,
		sources,
		job,
	});

	includes("generateDocument：markdown 以「# 标题」开头", result.markdown, "# 智慧园区建设方案");
	ok("generateDocument：第一行就是标题", result.markdown.startsWith("# 智慧园区建设方案"));
	notIncludes("generateDocument：剥掉代码围栏", result.markdown, "```");
	notIncludes("generateDocument：剥掉 DOCUMENT 标签", result.markdown, "<DOCUMENT>");
	includes("generateDocument：保留正文章节标题", result.markdown, "## 一、项目背景");
	eq("generateDocument：title 取大纲标题", result.title, "智慧园区建设方案");
	eq("generateDocument：无 warning", result.warnings, []);

	eq("generateDocument：只调用一次模型", model.calls.length, 1);
	eq("generateDocument：standard 长度 maxTokens=9000", model.calls[0].maxTokens, 9000);
	eq("generateDocument：temperature=0.6", model.calls[0].temperature, 0.6);

	const system = model.calls[0].system;
	const prompt = promptOf(model.calls);
	includes("generateDocument：system 写明 DOCUMENT 标签协议", system, "<DOCUMENT>");
	includes("generateDocument：system 写入第一行标题规则", system, "第一行必须是");
	includes("generateDocument：prompt 注入已确认大纲标题", prompt, "【已确认大纲】");
	includes("generateDocument：prompt 注入大纲章节标题", prompt, "一、项目背景");
	includes("generateDocument：prompt 注入大纲要点", prompt, "梳理政策与业务驱动");
	includes("generateDocument：prompt 注入大纲 notes", prompt, "写作提示：用 2 段说明");
	includes("generateDocument：prompt 注入文档标题", prompt, "# 智慧园区建设方案");
	includes("generateDocument：prompt 注入参考文档", prompt, "【参考文档 1：需求说明.md】");
	includes("generateDocument：prompt 注入参考正文", prompt, "本期覆盖安防、能耗与运营平台三个子系统。");
	includes("generateDocument：prompt 注入联网资料", prompt, "[1] 智慧园区白皮书 — https://example.com/whitepaper");
	includes("generateDocument：prompt 注入红线", prompt, "不得出现虚假数据与未经验证的引用");
	includes("generateDocument：prompt 注入风格篇幅", prompt, "标准（约 2000–3500 字）");
	includes("generateDocument：prompt 要求「待核实」标注", prompt, "（待核实）");
	includes("generateDocument：prompt 要求参考资料一节", prompt, "参考资料");
	includes("generateDocument：prompt 注入共享对话上下文", prompt, "共享对话上下文");
	eq("generateDocument：job 进度止于 60，交给 service 继续 75/88", job.updates.map((item) => item.progress), [5, 15, 60]);

	// 不同篇幅对应不同 maxTokens
	for (const [length, expectedTokens, expectedLabel] of [
		["short", 5000, "简短（约 800–1200 字）"],
		["standard", 9000, "标准（约 2000–3500 字）"],
		["detailed", 14000, "详尽（约 4500–7000 字）"],
	]) {
		const lengthProject = makeProject({ style: { audience: "client", tone: "friendly", length } });
		const lengthModel = makeModel(documentCannedMarkdown());
		const lengthEngine = createEngine({ callModel: lengthModel.callModel });
		await lengthEngine.generateDocument({ project: lengthProject, template: TEMPLATE, outline: OUTLINE_FIXTURE, references: [], sources: [] });
		eq(`generateDocument：${length} maxTokens`, lengthModel.calls[0].maxTokens, expectedTokens);
		includes(`generateDocument：${length} 注入篇幅目标`, promptOf(lengthModel.calls), expectedLabel);
	}

	// 无标签时整段当 Markdown，并补标题
	const plainModel = makeModel("好的，以下是正文：\n\n正文段落一。\n\n正文段落二。");
	const plainEngine = createEngine({ callModel: plainModel.callModel });
	const plainResult = await plainEngine.generateDocument({ project, template: TEMPLATE, outline: OUTLINE_FIXTURE, references: [] });
	ok("generateDocument：无标签时整段作为 Markdown 并补标题", plainResult.markdown.startsWith("# 智慧园区建设方案"));
	includes("generateDocument：无标签回退保留正文", plainResult.markdown, "正文段落一。");

	// 已有标题保持原样，不重复补标题
	const titledModel = makeModel("# 自定义标题\n\n正文内容。");
	const titledEngine = createEngine({ callModel: titledModel.callModel });
	const titledResult = await titledEngine.generateDocument({ project, template: TEMPLATE, outline: OUTLINE_FIXTURE, references: [] });
	ok("generateDocument：模型标题被保留", titledResult.markdown.startsWith("# 自定义标题"));
	eq("generateDocument：不会重复插入标题", countOf(titledResult.markdown, "# 智慧园区建设方案"), 0);

	// 空 DOCUMENT 标签 → 中文错误
	const emptyDocEngine = createEngine({ callModel: makeModel("<DOCUMENT>\n  \n</DOCUMENT>").callModel });
	let emptyDocError = null;
	try {
		await emptyDocEngine.generateDocument({ project, template: TEMPLATE, outline: OUTLINE_FIXTURE, references: [] });
	} catch (error) {
		emptyDocError = error;
	}
	ok("generateDocument：空成文标签抛中文错误", Boolean(emptyDocError) && emptyDocError.message.includes("成文内容为空"));

	// 缺少大纲 → 中文错误
	const noOutlineEngine = createEngine({ callModel: makeModel("x").callModel });
	let noOutlineError = null;
	try {
		await noOutlineEngine.generateDocument({ project, template: TEMPLATE, references: [] });
	} catch (error) {
		noOutlineError = error;
	}
	ok("generateDocument：缺少大纲时抛中文错误", Boolean(noOutlineError) && noOutlineError.message.includes("缺少已确认的大纲"));
}

/* ═════════════════════════ revise ═════════════════════════ */

async function testRevise() {
	console.log("\n# revise");

	const project = makeProject({
		conversation: {
			messages: [
				{ id: "m1", role: "user", content: "先按管理层视角写。", phase: "outline", error: false },
				{ id: "m2", role: "assistant", content: "好的，已按管理层视角组织大纲。", phase: "outline", error: false },
			],
		},
	});
	const references = [{ name: "调研记录.txt", text: "园区企业反映停车与能耗管理问题突出。" }];
	const sources = [{ id: "src-1", title: "行业报告", url: "https://example.com/report", snippet: "智慧园区市场持续增长。" }];

	// 只讨论，不产出工件
	const discussModel = makeModel("第 2 节目前有两个要点，建议补充「分期实施」与「投资回报周期」两项。");
	const discussEngine = createEngine({ callModel: discussModel.callModel });
	const discussResult = await discussEngine.revise({
		project,
		template: TEMPLATE,
		phase: "outline",
		outline: OUTLINE_FIXTURE,
		references,
		sources,
		message: "第 2 节现在写了什么？",
	});
	eq("revise：只讨论时保留 reply", discussResult.reply, "第 2 节目前有两个要点，建议补充「分期实施」与「投资回报周期」两项。");
	ok("revise：只讨论时不产出 outline", discussResult.outline === undefined);
	ok("revise：只讨论时不产出 markdown", discussResult.markdown === undefined);
	eq("revise：只讨论时 warnings 为空", discussResult.warnings, []);

	const discussPrompt = promptOf(discussModel.calls);
	includes("revise：prompt 注入当前大纲", discussPrompt, "【当前大纲】");
	includes("revise：prompt 注入大纲章节", discussPrompt, "一、项目背景");
	includes("revise：prompt 注入用户最新要求", discussPrompt, "【用户最新要求】\n第 2 节现在写了什么？");
	includes("revise：prompt 注入历史对话", discussPrompt, "先按管理层视角写。");
	includes("revise：prompt 注入参考文档", discussPrompt, "调研记录.txt");
	includes("revise：prompt 注入联网资料", discussPrompt, "https://example.com/report");
	includes("revise：prompt 注入红线", discussPrompt, "必须说明投资回报与分期实施");
	includes("revise：prompt 说明只讨论不输出标签", discussPrompt, "只输出文字回复，不要输出任何标签");
	eq("revise：maxTokens=9000", discussModel.calls[0].maxTokens, 9000);
	eq("revise：temperature=0.5", discussModel.calls[0].temperature, 0.5);

	// 返回完整新大纲
	const nextOutline = {
		title: "智慧园区建设方案（修订版）",
		sections: [
			{ heading: "一、项目背景", points: ["保留原背景", "补充政策依据"] },
			{ heading: "二、建设目标与范围", points: ["目标更聚焦"] },
			{ heading: "三、建设内容", points: ["安防", "能耗", "运营平台"] },
			{ heading: "四、分期实施", points: ["一期试点", "二期推广"] },
		],
	};
	const outlineModel = makeModel(`已增加「分期实施」章节，并统一了章节编号。\n\n${jsonOutline(nextOutline)}`);
	const outlineEngine = createEngine({ callModel: outlineModel.callModel });
	const outlineResult = await outlineEngine.revise({
		project,
		template: TEMPLATE,
		phase: "outline",
		outline: OUTLINE_FIXTURE,
		message: "增加一个分期实施章节",
	});
	eq("revise：大纲调整 reply 取标签前文本", outlineResult.reply, "已增加「分期实施」章节，并统一了章节编号。");
	eq("revise：大纲调整返回新标题", outlineResult.outline.title, "智慧园区建设方案（修订版）");
	eq("revise：大纲调整返回完整章节", outlineResult.outline.sections.length, 4);
	includes("revise：新大纲包含新增章节", outlineResult.outline.sections[3].heading, "分期实施");

	// 无标签 JSON 回退：{reply, outline}
	const jsonModel = makeModel(JSON.stringify({ reply: "已更新大纲", outline: nextOutline }));
	const jsonEngine = createEngine({ callModel: jsonModel.callModel });
	const jsonResult = await jsonEngine.revise({ project, template: TEMPLATE, phase: "outline", outline: OUTLINE_FIXTURE, message: "再调整一下" });
	eq("revise：JSON 回退的 reply", jsonResult.reply, "已更新大纲");
	eq("revise：JSON 回退的 outline", jsonResult.outline.title, "智慧园区建设方案（修订版）");

	// 返回完整新成文
	const currentMarkdown = "# 智慧园区建设方案\n\n## 一、项目背景\n原正文。";
	const newMarkdown = "# 智慧园区建设方案\n\n## 一、项目背景\n补充后的正文。\n\n## 二、建设目标与范围\n补充目标。";
	const docModel = makeModel(`已补写参考资料段落。\n<DOCUMENT>\n${newMarkdown}\n</DOCUMENT>`);
	const docEngine = createEngine({ callModel: docModel.callModel });
	const docResult = await docEngine.revise({
		project,
		template: TEMPLATE,
		phase: "document",
		outline: OUTLINE_FIXTURE,
		document: currentMarkdown,
		references,
		sources,
		message: "把背景一节写得更具体，并补充参考资料",
	});
	eq("revise：成文调整 reply 取标签前文本", docResult.reply, "已补写参考资料段落。");
	ok("revise：成文调整返回 markdown", docResult.markdown.startsWith("# 智慧园区建设方案"));
	includes("revise：成文调整返回完整新版本", docResult.markdown, "补充后的正文。");
	const docPrompt = promptOf(docModel.calls);
	includes("revise：成文阶段 prompt 注入当前成文", docPrompt, "【当前成文】");
	includes("revise：成文阶段 prompt 注入当前正文内容", docPrompt, "原正文。");
	includes("revise：成文阶段 prompt 要求保持大纲一致", docPrompt, "保持已确认大纲的章节标题与顺序");

	// 成文标签内整段围栏被剥离
	const fencedModel = makeModel(`已重写。\n<DOCUMENT>\n\`\`\`markdown\n${newMarkdown}\n\`\`\`\n</DOCUMENT>`);
	const fencedEngine = createEngine({ callModel: fencedModel.callModel });
	const fencedResult = await fencedEngine.revise({ project, template: TEMPLATE, phase: "document", outline: OUTLINE_FIXTURE, document: currentMarkdown, message: "重写" });
	notIncludes("revise：成文围栏被剥掉", fencedResult.markdown, "```");

	// 成文阶段返回大纲 → 忽略并给出 warning
	const crossModel = makeModel(jsonOutline(nextOutline));
	const crossEngine = createEngine({ callModel: crossModel.callModel });
	const crossResult = await crossEngine.revise({ project, template: TEMPLATE, phase: "document", outline: OUTLINE_FIXTURE, document: currentMarkdown, message: "改大纲" });
	ok("revise：成文阶段忽略大纲输出", crossResult.markdown === undefined);
	ok("revise：成文阶段忽略大纲时给出 warning", crossResult.warnings.some((warning) => warning.includes("已忽略模型返回的大纲内容")));

	// 对话上下文预算：最近 ≤30 条、≤12000 字
	const longMessages = Array.from({ length: 6 }, (_, index) => ({
		id: `m${index}`,
		role: index % 2 === 0 ? "user" : "assistant",
		content: `[[MSG${index}]]` + "内容".repeat(2000),
		phase: "outline",
		error: false,
	}));
	longMessages.push({ id: "m6", role: "user", content: "请精简第 3 节", phase: "outline", error: false });
	const budgetProject = makeProject({ conversation: { messages: longMessages } });
	const budgetModel = makeModel("好的，我建议第 3 节保留两项要点。");
	const budgetEngine = createEngine({ callModel: budgetModel.callModel });
	await budgetEngine.revise({ project: budgetProject, template: TEMPLATE, phase: "outline", outline: OUTLINE_FIXTURE, message: "请精简第 3 节" });
	const budgetPrompt = promptOf(budgetModel.calls);
	includes("revise：保留最近对话 MSG5", budgetPrompt, "[[MSG5]]");
	includes("revise：保留最近对话 MSG4", budgetPrompt, "[[MSG4]]");
	// 每条消息约 4008 字，三条即超过 12000 字预算，因此 MSG3 应被省略
	notIncludes("revise：超出 12000 字预算的 MSG3 被省略", budgetPrompt, "[[MSG3]]");
	notIncludes("revise：较早对话 MSG0 被省略", budgetPrompt, "[[MSG0]]");
	notIncludes("revise：较早对话 MSG1 被省略", budgetPrompt, "[[MSG1]]");
	includes("revise：上下文过长时标注省略", budgetPrompt, "较早内容已省略");
	eq("revise：本轮指令不在历史里重复出现", countOf(budgetPrompt, "请精简第 3 节"), 1);

	// 超过 30 条时只保留最近 30 条
	const manyMessages = Array.from({ length: 40 }, (_, index) => ({
		id: `n${index}`,
		role: index % 2 === 0 ? "user" : "assistant",
		content: `[[N${index}]]短内容`,
		phase: "outline",
		error: false,
	}));
	const manyProject = makeProject({ conversation: { messages: manyMessages } });
	const manyModel = makeModel("好的。");
	const manyEngine = createEngine({ callModel: manyModel.callModel });
	await manyEngine.revise({ project: manyProject, template: TEMPLATE, phase: "outline", outline: OUTLINE_FIXTURE, message: "继续" });
	const manyPrompt = promptOf(manyModel.calls);
	includes("revise：超过 30 条时保留最新一条", manyPrompt, "[[N39]]");
	notIncludes("revise：超过 30 条时丢弃最早消息", manyPrompt, "[[N9]]");
	ok("revise：30 条窗口条目数", manyPrompt.includes("最近 30 条"));
}

/* ═════════════════════════ checkRedlines ═════════════════════════ */

async function testCheckRedlines() {
	console.log("\n# checkRedlines");

	const project = makeProject();
	const redlines = [
		{ id: "r1", text: "不得出现虚假数据与未经验证的引用" },
		{ id: "r2", text: "必须说明投资回报与分期实施" },
		{ id: "r3", text: "不得使用绝对化表述" },
	];
	const markdown = "# 智慧园区建设方案\n\n## 一、项目背景\n园区现状。\n\n## 四、实施计划\n分两期实施。";
	const canned = '<REPORT>[{"label":"","status":"RISK","note":42},{"label":"必须说明投资回报与分期实施","status":"通过","note":"第 4 节已说明"}]</REPORT>';
	const model = makeModel(canned);
	const engine = createEngine({ callModel: model.callModel });
	const job = makeJob();

	const result = await engine.checkRedlines({ project, redlines, outline: OUTLINE_FIXTURE, markdown, job });
	eq("checkRedlines：报告条数与红线一致", result.report.length, 3);
	eq("checkRedlines：label 缺失回退红线原文", result.report[0].label, redlines[0].text);
	eq("checkRedlines：状态 RISK 归一化为 risk", result.report[0].status, "risk");
	eq("checkRedlines：非字符串 note 转为字符串", result.report[0].note, "42");
	eq("checkRedlines：状态「通过」归一化为 pass", result.report[1].status, "pass");
	eq("checkRedlines：模型 label 被保留", result.report[1].label, "必须说明投资回报与分期实施");
	eq("checkRedlines：缺失项补 unknown", result.report[2].status, "unknown");
	eq("checkRedlines：缺失项 label 回退红线原文", result.report[2].label, redlines[2].text);
	ok("checkRedlines：缺失项 note 为非空说明", result.report[2].note.length > 0);

	const checkPrompt = promptOf(model.calls);
	includes("checkRedlines：prompt 注入逐条红线", checkPrompt, "1. 不得出现虚假数据与未经验证的引用");
	includes("checkRedlines：prompt 注入正文", checkPrompt, "园区现状。");
	includes("checkRedlines：prompt 注入大纲", checkPrompt, "一、项目背景");
	includes("checkRedlines：prompt 说明判定标准", checkPrompt, "pass：");
	includes("checkRedlines：prompt 写明 REPORT 协议", checkPrompt, "<REPORT>");
	includes("checkRedlines：prompt 要求不编造问题", checkPrompt, "不得编造问题");
	eq("checkRedlines：maxTokens=3000", model.calls[0].maxTokens, 3000);
	eq("checkRedlines：temperature=0.2", model.calls[0].temperature, 0.2);
	eq("checkRedlines：job 进度在 service 的 78→88 之间", job.updates.map((item) => item.progress), [80, 86]);

	// 无红线时直接返回空报告，不调用模型
	const noRedlineModel = makeModel("不应被调用");
	const noRedlineEngine = createEngine({ callModel: noRedlineModel.callModel });
	const noRedlineResult = await noRedlineEngine.checkRedlines({ project, redlines: [], markdown });
	eq("checkRedlines：无红线返回空报告", noRedlineResult.report, []);
	eq("checkRedlines：无红线不调用模型", noRedlineModel.calls.length, 0);

	// 无标签围栏 JSON 数组回退
	const fenceModel = makeModel(
		'```json\n[{"label":"r1","status":"pass","note":"ok"},{"label":"r2","status":"risk","note":"第 4 节"},{"label":"r3","status":"unknown","note":"无法判断"}]\n```',
	);
	const fenceEngine = createEngine({ callModel: fenceModel.callModel });
	const fenceResult = await fenceEngine.checkRedlines({ project, redlines, markdown });
	eq("checkRedlines：围栏 JSON 数组回退（pass）", fenceResult.report[0].status, "pass");
	eq("checkRedlines：围栏 JSON 数组回退（risk）", fenceResult.report[1].status, "risk");
	eq("checkRedlines：围栏 JSON 数组回退（unknown）", fenceResult.report[2].status, "unknown");

	// 模型输出无法解析 → 全部 unknown，不抛错
	const garbageModel = makeModel("我无法完成自检。");
	const garbageEngine = createEngine({ callModel: garbageModel.callModel });
	const garbageResult = await garbageEngine.checkRedlines({ project, redlines, markdown });
	eq("checkRedlines：无法解析时仍返回全部红线", garbageResult.report.length, 3);
	ok("checkRedlines：无法解析时状态均为 unknown", garbageResult.report.every((item) => item.status === "unknown"));

	// 模型调用失败 → 全部 unknown + 记录 warning，不抛错
	const warns = [];
	const throwModel = makeModel(new Error("模型超时"));
	const throwEngine = createEngine({ callModel: throwModel.callModel, logger: { warn: (message) => warns.push(message) } });
	const throwResult = await throwEngine.checkRedlines({ project, redlines, markdown });
	eq("checkRedlines：模型失败时仍返回全部红线", throwResult.report.length, 3);
	ok("checkRedlines：模型失败时标记 unknown", throwResult.report.every((item) => item.status === "unknown"));
	eq("checkRedlines：模型失败时写 logger.warn", warns.length, 1);
	includes("checkRedlines：logger.warn 记录中文原因", warns[0], "红线自检失败");
}

/* ═════════════════════════ 主流程 ═════════════════════════ */

async function main() {
	testExtractJson();
	testParseArtifact();
	testNormalize();
	await testPlanSearchQueries();
	await testCreateEngine();
	await testGenerateOutline();
	await testGenerateDocument();
	await testRevise();
	await testCheckRedlines();

	console.log(`\n${state.pass} passed, ${state.fail} failed, ${state.pass + state.fail} total`);
	if (state.fail) {
		console.error(`失败用例：${state.failures.join("；")}`);
		process.exit(1);
	}
	console.log("ENGINE_TEST_PASS");
	process.exit(0);
}

await main();
