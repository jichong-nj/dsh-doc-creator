/**
 * lib/templates.js 离线测试（无测试框架，直接 node test/test-templates.mjs）。
 *
 * 覆盖：9 个内置模板的结构与内容质量、free 模板特殊行为、章节解析与深拷贝隔离、
 * 6 条通用红线、默认红线生成、风格中文标签。全部为纯内存断言，不读写磁盘。
 */

import assert from "node:assert/strict";

import {
	BUILTIN_REDLINES,
	FREE_TEMPLATE_ID,
	STYLE_VALUES,
	TEMPLATE_CATEGORIES,
	defaultRedlines,
	getTemplate,
	listTemplates,
	resolveSections,
	styleLabels,
} from "../lib/templates.js";

/** @type {Array<{name: string, fn: () => void}>} */
const tests = [];

/**
 * 注册测试用例。
 * @param {string} name 用例名
 * @param {() => void} fn 用例函数
 */
function test(name, fn) {
	tests.push({ name, fn });
}

const EXPECTED_IDS = [
	"general-report",
	"project-plan",
	"prd",
	"tech-design",
	"research-report",
	"meeting-minutes",
	"work-report",
	"user-manual",
	"free",
];

test("listTemplates：返回 9 个模板，id 唯一、free 固定在最后", () => {
	const templates = listTemplates();
	assert.ok(Array.isArray(templates));
	assert.equal(templates.length, 9);
	assert.deepEqual(
		templates.map((item) => item.id),
		EXPECTED_IDS,
	);
	assert.equal(templates.at(-1).id, FREE_TEMPLATE_ID);
	assert.equal(FREE_TEMPLATE_ID, "free");
	assert.equal(new Set(templates.map((item) => item.id)).size, 9);
});

test("每个模板的基础字段完整且合法", () => {
	for (const template of listTemplates()) {
		assert.match(template.id, /^[a-z][a-z0-9-]*$/, `${template.id} 的 id 格式非法`);
		assert.ok(typeof template.name === "string" && template.name.trim().length >= 2, `${template.id} 缺少名称`);
		assert.ok(
			typeof template.description === "string" && template.description.trim().length >= 20,
			`${template.id} 的描述太短，无法引导用户选择`,
		);
		assert.ok(TEMPLATE_CATEGORIES.includes(template.category), `${template.id} 分类非法：${template.category}`);
		assert.ok(template.defaults && typeof template.defaults === "object", `${template.id} 缺少 defaults`);
		for (const key of ["audience", "tone", "length"]) {
			assert.ok(
				STYLE_VALUES[key].includes(template.defaults[key]),
				`${template.id} 的默认 ${key} 非法：${template.defaults[key]}`,
			);
		}
		assert.ok(Array.isArray(template.redlines), `${template.id} 缺少 redlines`);
		assert.ok(template.redlines.length >= 1 && template.redlines.length <= 3, `${template.id} 模板红线应为 1–3 条`);
		for (const redline of template.redlines) {
			assert.ok(typeof redline === "string" && redline.trim().length >= 10, `${template.id} 的模板红线过短`);
		}
		assert.ok(Array.isArray(template.sections), `${template.id} 的 sections 必须是数组`);
	}
});

test("非 free 模板：5–8 个章节，标题与写作提示可用且有信息量", () => {
	for (const template of listTemplates()) {
		if (template.id === FREE_TEMPLATE_ID) continue;
		assert.ok(
			template.sections.length >= 5 && template.sections.length <= 8,
			`${template.id} 应有 5–8 个章节，实际 ${template.sections.length}`,
		);
		const headings = new Set();
		for (const section of template.sections) {
			assert.ok(section && typeof section === "object", `${template.id} 存在非法章节`);
			assert.ok(
				typeof section.heading === "string" && section.heading.trim().length >= 3,
				`${template.id} 存在空标题`,
			);
			assert.ok(
				typeof section.hint === "string" && section.hint.trim().length >= 25,
				`${template.id}「${section.heading}」的写作提示太短，不能指导写作`,
			);
			assert.match(section.hint, /[\u4e00-\u9fa5]/, `${template.id}「${section.heading}」的提示应为中文`);
			assert.equal(headings.has(section.heading), false, `${template.id} 章节标题重复：${section.heading}`);
			headings.add(section.heading);
		}
	}
});

test("free 模板：无固定章节、描述引导用户自由发挥", () => {
	const free = getTemplate(FREE_TEMPLATE_ID);
	assert.ok(free);
	assert.equal(free.name, "自由发挥");
	assert.deepEqual(free.sections, []);
	assert.equal(free.category, "通用");
	assert.ok(free.description.includes("主题"), "free 描述应引导用户补充主题");
	assert.ok(free.description.includes("结构"), "free 描述应说明结构自动设计");
});

test("getTemplate：按 id 取值，未知 id / 非法入参返回 null", () => {
	const template = getTemplate("project-plan");
	assert.ok(template);
	assert.equal(template.id, "project-plan");
	assert.equal(template.name, "项目方案 / 立项报告");
	assert.deepEqual(template, getTemplate("project-plan"));
	for (const bad of ["unknown", "", null, undefined, 42, {}, []]) {
		assert.equal(getTemplate(bad), null, `getTemplate(${String(bad)}) 应返回 null`);
	}
});

test("listTemplates / getTemplate 返回深拷贝，调用方修改不影响内置数据", () => {
	const first = listTemplates();
	first[0].name = "被改坏的名称";
	first[0].sections[0].heading = "被改坏的标题";
	first.push({ id: "fake" });
	const second = listTemplates();
	assert.equal(second.length, 9);
	assert.notEqual(second[0].name, "被改坏的名称");
	assert.notEqual(second[0].sections[0].heading, "被改坏的标题");

	const one = getTemplate("prd");
	one.sections.length = 0;
	one.redlines.push("注入的红线");
	assert.ok(getTemplate("prd").sections.length >= 5);
});

test("resolveSections：已知模板返回 heading/hint，free / 未知 / 空值返回 []", () => {
	const template = getTemplate("tech-design");
	const sections = resolveSections(template);
	assert.equal(sections.length, template.sections.length);
	for (const section of sections) {
		assert.deepEqual(Object.keys(section).sort(), ["heading", "hint"]);
		assert.ok(section.heading.length > 0 && section.hint.length > 0);
	}
	// 支持直接传 id
	assert.deepEqual(resolveSections("tech-design"), sections);
	assert.deepEqual(resolveSections(FREE_TEMPLATE_ID), []);
	assert.deepEqual(resolveSections(getTemplate(FREE_TEMPLATE_ID)), []);
	assert.deepEqual(resolveSections(null), []);
	assert.deepEqual(resolveSections(undefined), []);
	assert.deepEqual(resolveSections("unknown"), []);
	assert.deepEqual(resolveSections({}), []);

	// 返回值与模板隔离：修改结果不影响源数据
	sections[0].heading = "mutated";
	assert.equal(getTemplate("tech-design").sections[0].heading, "一、背景与目标");
});

test("BUILTIN_REDLINES：6 条通用红线，id 稳定且文案有指导性", () => {
	assert.equal(BUILTIN_REDLINES.length, 6);
	assert.equal(new Set(BUILTIN_REDLINES.map((item) => item.id)).size, 6);
	BUILTIN_REDLINES.forEach((redline, index) => {
		assert.equal(redline.id, `rl-builtin-${index + 1}`);
		assert.ok(typeof redline.text === "string");
		assert.ok(redline.text.trim().length >= 15, `红线 ${redline.id} 文案过短`);
		assert.match(redline.text, /[\u4e00-\u9fa5]/);
	});
	const joined = BUILTIN_REDLINES.map((item) => item.text).join("\n");
	for (const keyword of ["术语", "数据", "来源", "隐私"]) {
		assert.ok(joined.includes(keyword), `通用红线应覆盖「${keyword}」`);
	}
});

test("defaultRedlines：输出 6 条 builtin 红线且每次为独立副本", () => {
	const first = defaultRedlines();
	assert.equal(first.length, 6);
	for (const redline of first) {
		assert.match(redline.id, /^rl-builtin-[1-6]$/);
		assert.equal(redline.builtin, true);
		assert.deepEqual(Object.keys(redline).sort(), ["builtin", "id", "text"]);
	}
	first[0].text = "被改坏";
	first.pop();
	const second = defaultRedlines();
	assert.equal(second.length, 6);
	assert.notEqual(second[0].text, "被改坏");
	assert.notEqual(first, second);
});

test("styleLabels：受众 / 语气 / 篇幅与契约文案完全一致", () => {
	assert.deepEqual(styleLabels(), {
		audience: {
			general: "通用读者",
			management: "管理层",
			technical: "技术读者",
			client: "客户/外部",
		},
		tone: {
			formal: "正式严谨",
			professional: "专业清晰",
			friendly: "友好易懂",
		},
		length: {
			short: "简短（约 800–1200 字）",
			standard: "标准（约 2000–3500 字）",
			detailed: "详尽（约 4500–7000 字）",
		},
	});
	// 每次返回新对象，避免调用方污染
	const labels = styleLabels();
	labels.audience.general = "x";
	assert.equal(styleLabels().audience.general, "通用读者");
});

test("模板内容覆盖真实中文写作场景的关键要素", () => {
	const checks = [
		["general-report", "结论"],
		["project-plan", "预算"],
		["prd", "验收"],
		["tech-design", "选型"],
		["research-report", "来源"],
		["meeting-minutes", "行动项"],
		["work-report", "量化"],
		["user-manual", "操作步骤"],
	];
	for (const [id, keyword] of checks) {
		const template = getTemplate(id);
		const text = [
			template.description,
			...template.sections.map((section) => `${section.heading}${section.hint}`),
			...template.redlines,
		].join("\n");
		assert.ok(text.includes(keyword), `模板 ${id} 应包含关键要素「${keyword}」`);
	}
});

let failures = 0;
for (const item of tests) {
	try {
		item.fn();
		console.log(`PASS ${item.name}`);
	} catch (error) {
		failures += 1;
		console.error(`FAIL ${item.name}`);
		console.error(error?.stack ?? error);
	}
}
console.log(`\n${tests.length - failures}/${tests.length} template tests passed`);
if (failures > 0) process.exit(1);
console.log("ALL TEMPLATE TESTS PASS");
