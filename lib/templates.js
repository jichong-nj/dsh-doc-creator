/**
 * 内置中文写作模板库。
 *
 * 每个模板给出「章节骨架 + 每节写作提示 + 默认风格 + 建议红线」，用于：
 *   1. 设置页展示模板卡片与骨架预览（客户端调用 `listTemplates()`）；
 *   2. 生成大纲时把骨架与提示注入提示词（引擎调用 `resolveSections()`）；
 *   3. 新建项目时写入默认风格与内置红线（服务层调用 `defaultRedlines()` / `styleLabels()`）。
 *
 * 本模块是纯数据与纯函数：不读写磁盘、不访问网络、不依赖宿主 ctx。
 * 所有文案均为简体中文，风格与真实中文商务写作习惯一致，避免占位符。
 */

/** 自由发挥模板 id（无固定章节骨架）。 */
export const FREE_TEMPLATE_ID = "free";

/** 合法分类集合（供测试与校验复用）。 */
export const TEMPLATE_CATEGORIES = ["通用", "方案", "产品", "技术", "研究", "其他"];

/** 合法受众 / 语气 / 篇幅枚举值。 */
export const STYLE_VALUES = {
	audience: ["general", "management", "technical", "client"],
	tone: ["formal", "professional", "friendly"],
	length: ["short", "standard", "detailed"],
};

/**
 * 6 条通用内置红线（与模板专属红线分离）。
 * id 固定为 `rl-builtin-1` … `rl-builtin-6`，保证 `defaultRedlines()` 每次结果稳定。
 */
export const BUILTIN_REDLINES = [
	{
		id: "rl-builtin-1",
		text: "全文使用简体中文，同一概念、术语、产品名和指标名前后统一，不得混用多种叫法。",
	},
	{
		id: "rl-builtin-2",
		text: "不得编造数据、案例、机构、人物、政策或文献来源；无法核实的内容必须标注「（待核实）」。",
	},
	{
		id: "rl-builtin-3",
		text: "结论必须能在正文找到依据；避免「最好」「彻底解决」「百分之百」等绝对化、夸大表述。",
	},
	{
		id: "rl-builtin-4",
		text: "不复述标题、不堆砌空话套话凑字数，每一段都要提供新信息或推进论证。",
	},
	{
		id: "rl-builtin-5",
		text: "涉及第三方观点、数据与引用时必须注明出处；不得把他人观点表述为自己的原创结论。",
	},
	{
		id: "rl-builtin-6",
		text: "不得写入涉密信息、个人隐私与未公开内部数据；确需举例时做匿名化与脱敏处理。",
	},
];

/** 内置模板定义（free 固定排在最后，客户端据此渲染「自由发挥」卡片）。 */
const TEMPLATES = [
	{
		id: "general-report",
		name: "通用报告",
		description: "面向汇报或存档的通用报告：交代背景、呈现数据、分析问题、给出建议，适用于大多数「写一份材料说明情况」的场景。",
		category: "通用",
		defaults: { audience: "general", tone: "professional", length: "standard" },
		redlines: [
			"结论与关键数据必须有出处，不得使用无法核实的数字或传闻。",
			"必须区分事实、推断与建议，不得把推测写成既有事实。",
		],
		sections: [
			{
				heading: "一、摘要与背景",
				hint: "用 150–250 字说明报告目的、面向的读者和核心结论；交代起因（项目进展、问题暴露或决策需求）以及本文覆盖的范围，让读者不读全文也能抓住重点。",
			},
			{
				heading: "二、现状与关键数据",
				hint: "列出与主题直接相关的事实与指标，注明数据口径、统计周期和来源；用时间对比、数量、比例说明变化趋势，避免只写主观感受。",
			},
			{
				heading: "三、主要发现与分析",
				hint: "按重要性排列 3–5 条发现。每条先给结论句，再给支撑依据（数据、案例、访谈），并说明它与写作目标的关系。",
			},
			{
				heading: "四、问题与原因",
				hint: "用「现象—影响—原因」的结构描述具体问题，量化影响范围；明确哪些原因已经确认、哪些仍待验证，避免笼统归因于「沟通不到位」。",
			},
			{
				heading: "五、建议与行动项",
				hint: "给出可落地建议，每条包含负责人、完成时间和验收标准；按优先级排序，并说明所需资源与前置条件。",
			},
			{
				heading: "六、后续计划与风险",
				hint: "说明下一步时间节点、需要决策的事项，以及可能出现的风险与应对预案；给出后续跟踪与复盘方式。",
			},
		],
	},
	{
		id: "project-plan",
		name: "项目方案 / 立项报告",
		description: "用于立项评审与资源申请：讲清为什么做、怎么做、要多少资源、能带来什么收益，适合内部审批场景。",
		category: "方案",
		defaults: { audience: "management", tone: "formal", length: "detailed" },
		redlines: [
			"预算、周期、人力必须给出估算依据，不得只写「待定」或拍脑袋数字。",
			"目标必须可衡量（指标 + 时间），避免「提升效率」「优化体验」等无法验收的表述。",
		],
		sections: [
			{
				heading: "一、项目背景与目标",
				hint: "交代业务背景、当前问题与立项理由，说明为什么现在做；目标用「指标 + 目标值 + 完成时间」表述，区分必须达成的核心目标与期望达成的附加目标。",
			},
			{
				heading: "二、解决方案与范围",
				hint: "描述方案总体思路、关键举措与技术/业务路径；明确本项目做什么、不做什么（范围边界），以及与其他项目的依赖关系，防止后续范围蔓延。",
			},
			{
				heading: "三、实施计划与里程碑",
				hint: "按阶段拆解任务，给出起止时间、交付物和负责人；标明关键路径、上下游依赖与评审节点，里程碑要可验收。",
			},
			{
				heading: "四、资源与预算",
				hint: "列出人力（角色与人天）、设备、采购与外部服务需求，给出估算依据、单价口径与总预算区间；说明资源到位时间对计划的影响。",
			},
			{
				heading: "五、收益与量化指标",
				hint: "从效率、成本、收入或风险四个角度量化预期收益，说明计算口径与关键假设；收益要区分直接收益与间接收益，并给出验证方式。",
			},
			{
				heading: "六、风险与应对",
				hint: "识别 3–5 项主要风险（进度、资源、技术、合规、依赖方），评估发生概率与影响程度，给出缓解措施、触发条件和责任人。",
			},
			{
				heading: "七、组织与分工",
				hint: "明确项目负责人、核心成员与各方职责，说明决策机制、汇报节奏（周会/月会）与升级路径，确保跨部门协作有接口人。",
			},
		],
	},
	{
		id: "prd",
		name: "产品需求文档 PRD",
		description: "面向研发与设计的需求文档：从用户问题出发，定义功能、交互、边界与验收标准，减少实现阶段的反复确认。",
		category: "产品",
		defaults: { audience: "technical", tone: "professional", length: "detailed" },
		redlines: [
			"每个功能点必须有可验证的验收标准，不得使用「体验良好」「尽量快」等不可测描述。",
			"需求优先级与本期范围必须明确，不得把「以后再做」的功能混入本期交付。",
		],
		sections: [
			{
				heading: "一、需求背景与目标",
				hint: "说明用户问题、业务目标与需求来源（用户反馈、数据分析、战略要求）；给出可衡量的成功指标（如转化率、留存、工单量）及其当前基线。",
			},
			{
				heading: "二、目标用户与使用场景",
				hint: "描述用户角色、权限差异与典型使用场景，按「触发条件—操作—期望结果」写清完整任务流程；标注高频场景与关键场景。",
			},
			{
				heading: "三、功能需求",
				hint: "按模块列出功能点并用编号管理，每项写清输入、处理规则、输出、异常分支与权限要求；标注优先级（P0/P1/P2）与本期是否交付。",
			},
			{
				heading: "四、交互与页面流程",
				hint: "描述关键页面的信息层级、操作路径和页面状态（空态、加载、错误、无权限）；说明页面跳转关系，复杂流程可用「步骤 1→2→3」文字化表达。",
			},
			{
				heading: "五、边界与规则",
				hint: "明确数据范围、权限规则、限制条件（字数、数量、频率、尺寸）与不做的事项；列出需要产品、研发、法务共同确认的规则争议点。",
			},
			{
				heading: "六、非功能与数据埋点",
				hint: "说明性能、兼容性、可用性、安全合规要求（响应时间、支持端、数据保留周期）；列出需要统计的关键事件、字段与指标口径，供上线后验证目标。",
			},
			{
				heading: "七、发布与验收",
				hint: "给出验收标准清单、灰度或分批上线节奏、回归范围与回滚方案；说明上线后需要观察的指标和复盘时间点。",
			},
		],
	},
	{
		id: "tech-design",
		name: "技术方案设计",
		description: "面向技术评审的方案文档：现状与瓶颈、总体架构、关键流程、接口约定、稳定性与安全，以及测试发布策略。",
		category: "技术",
		defaults: { audience: "technical", tone: "professional", length: "detailed" },
		redlines: [
			"技术选型必须给出权衡理由（备选方案、对比维度与取舍），不得只列结论。",
			"涉及数据结构或存储变更时，必须说明兼容方案与回滚策略。",
		],
		sections: [
			{
				heading: "一、背景与目标",
				hint: "说明业务需求与本方案要解决的技术问题，列出关键约束：时间窗口、兼容性要求、成本上限、合规与安全要求，以及明确的非目标。",
			},
			{
				heading: "二、现状与问题",
				hint: "描述当前架构、核心数据流与调用链，指出瓶颈和风险（性能、耦合、单点、数据一致性）；说明本次改造的切入点和影响范围。",
			},
			{
				heading: "三、总体设计",
				hint: "给出架构图或模块划分的文字描述，说明各模块职责、核心数据流和关键接口；对比至少一个备选方案并说明选型理由与代价。",
			},
			{
				heading: "四、关键流程与数据结构",
				hint: "用编号步骤或伪代码描述核心流程（含异常与重试分支），定义关键数据结构、字段含义、状态机与状态迁移条件；标明数据一致性要求。",
			},
			{
				heading: "五、接口设计",
				hint: "列出接口路径、方法、请求/响应字段（含类型与必填）、错误码与错误语义；说明鉴权、幂等、限流、分页与版本兼容策略。",
			},
			{
				heading: "六、性能、可用性与安全",
				hint: "给出容量与性能估算（QPS、数据量、响应时间目标），说明降级、重试、熔断、监控告警设计；描述权限控制、数据加密与审计要求。",
			},
			{
				heading: "七、测试与发布",
				hint: "说明单测、集成测试、压测与兼容性测试的范围和通过标准；给出发布方案、灰度策略、回滚步骤与上线后观察指标。",
			},
		],
	},
	{
		id: "research-report",
		name: "研究报告 / 调研报告",
		description: "用于市场调研、行业分析与专题研究：先给方法与关键结论，再展开数据与洞察，最后落到可执行建议。",
		category: "研究",
		defaults: { audience: "management", tone: "formal", length: "detailed" },
		redlines: [
			"所有数据必须标注来源、样本量与统计口径，无法溯源的数据不得使用。",
			"不得用个别案例或主观感受代替整体数据结论，个例必须说明代表性。",
		],
		sections: [
			{
				heading: "一、研究背景与方法",
				hint: "说明研究问题、目标与边界，交代样本来源（问卷、访谈、公开数据）、样本量、调研方式与时间区间，让读者能判断结论的可信度。",
			},
			{
				heading: "二、关键结论摘要",
				hint: "用不超过 5 条结论前置呈现，每条一句话并标注支撑数据所在章节；结论要直接回答研究问题，不写过程性描述。",
			},
			{
				heading: "三、现状与数据概览",
				hint: "呈现总体规模、结构分布与时间趋势，用文字描述关键数据、口径和对比基准；避免只罗列数字而不给判断。",
			},
			{
				heading: "四、细分分析与洞察",
				hint: "按用户、区域、产品、时间等维度拆解差异，解释差异背后的原因，并指出哪些差异具有统计或业务意义。",
			},
			{
				heading: "五、案例与访谈发现",
				hint: "选取 2–3 个典型案例或代表性访谈观点，说明选择标准和代表性；区分事实描述与受访者主观判断，避免以个例代替整体。",
			},
			{
				heading: "六、结论与建议",
				hint: "结论须与研究问题一一对应；建议按优先级给出，说明实施条件、预期效果和衡量方式，避免脱离数据空谈方向。",
			},
			{
				heading: "七、局限与后续研究",
				hint: "说明样本、方法或数据的局限及其对结论的影响，列出待验证的问题和后续研究计划，保持研究结论的边界清晰。",
			},
		],
	},
	{
		id: "meeting-minutes",
		name: "会议纪要",
		description: "结构化会议记录：基本信息、讨论要点、决议事项、行动项与待确认问题，便于会后跟踪落实。",
		category: "其他",
		defaults: { audience: "general", tone: "formal", length: "short" },
		redlines: [
			"行动项必须落实到具体负责人并给出截止时间，不得只写「相关人员跟进」。",
			"记录须忠于发言原意，不得加入记录人的主观评价或未讨论的结论。",
		],
		sections: [
			{
				heading: "一、会议基本信息",
				hint: "记录会议主题、时间、地点或会议号、主持人、记录人、参会人与缺席人；重要会议注明会议目标和所属项目。",
			},
			{
				heading: "二、议题与讨论要点",
				hint: "按议题顺序记录讨论要点和主要分歧，忠实还原各方观点（可标注发言人），不添加个人评价；跑题内容不记。",
			},
			{
				heading: "三、决议事项",
				hint: "逐条列出已达成一致的决议，明确适用范围与生效条件；未达成一致的事项单独列出并说明分歧点，不要含糊写成「原则同意」。",
			},
			{
				heading: "四、行动项与负责人",
				hint: "用「任务—负责人—截止时间—交付物」逐条记录，确保每条可追踪；一项任务只有一个责任人，多人协作时指明协调人。",
			},
			{
				heading: "五、待确认与风险",
				hint: "列出需要上级或相关方确认的问题、待补充的资料，以及可能影响进度或成本的风险与应对建议。",
			},
			{
				heading: "六、下次会议安排",
				hint: "说明下次会议时间、议题与需提前准备的材料和责任人；若无固定例会，写明后续沟通方式。",
			},
		],
	},
	{
		id: "work-report",
		name: "工作汇报 / 周报月报",
		description: "面向上级的周期汇报：本期概览、量化成果、进行中工作、问题风险与下期计划，突出进展与需要的支持。",
		category: "其他",
		defaults: { audience: "management", tone: "professional", length: "standard" },
		redlines: [
			"进展与成果必须量化（数据、完成度或交付物），避免只写「顺利推进」「持续优化」。",
			"风险与求助要具体到事项、影响和期望解决时间，不得只写「有困难」。",
		],
		sections: [
			{
				heading: "一、本期概览",
				hint: "用一段话（100–200 字）说明本期核心进展与整体状态（正常/有风险/延期），以及最需要关注的一件事，让读者 30 秒抓住重点。",
			},
			{
				heading: "二、关键成果",
				hint: "列出 3–5 项可量化成果，每项写清完成内容、数据结果与业务价值；没有硬指标的写交付物与验收情况。",
			},
			{
				heading: "三、进行中工作",
				hint: "说明各项任务当前进度百分比、所处阶段、预计完成时间；对跨期任务标注与计划的偏差。",
			},
			{
				heading: "四、问题与风险",
				hint: "描述阻塞点、影响范围和已采取的应对措施，明确需要谁在什么时间提供什么支持；区分自己能解决的和需要升级的。",
			},
			{
				heading: "五、下期计划",
				hint: "列出下期优先事项与可衡量目标，标明依赖方与需要协调的资源；计划数量控制在 3–5 项，避免罗列成流水账。",
			},
			{
				heading: "六、需要决策 / 支持",
				hint: "集中列出需要上级拍板、跨部门配合或资源投入的事项，一项一行，写清背景、可选项和建议方案。",
			},
		],
	},
	{
		id: "user-manual",
		name: "操作手册 / 用户指南",
		description: "面向使用者的操作文档：产品简介、快速开始、功能说明、常见场景、问题排查与注意事项，步骤与界面保持一致。",
		category: "技术",
		defaults: { audience: "general", tone: "friendly", length: "standard" },
		redlines: [
			"操作步骤必须与产品界面一致，按钮、菜单、字段名称全文统一，不得自行改写。",
			"涉及删除、覆盖、批量操作等高风险动作时，必须给出风险提示与确认步骤。",
		],
		sections: [
			{
				heading: "一、产品简介与适用范围",
				hint: "说明本手册用途、适用版本、目标读者和使用前提（账号、权限、浏览器或环境要求）；解释产品解决的核心问题，不写营销话术。",
			},
			{
				heading: "二、快速开始",
				hint: "用 3–5 步让用户完成首次使用，每步给出操作路径、点击/输入内容与预期结果；关键步骤注明截图位置，失败时如何回退。",
			},
			{
				heading: "三、功能说明",
				hint: "按功能模块逐项说明入口位置、操作步骤、参数含义与执行结果；术语与界面文案保持一致，复杂参数给出示例值。",
			},
			{
				heading: "四、常见场景操作",
				hint: "给出典型业务场景的完整操作流程（如新建、导入、导出、批量处理），按「场景描述—前置条件—操作步骤—结果确认」组织。",
			},
			{
				heading: "五、常见问题与排查",
				hint: "列出高频问题、报错原文、可能原因与解决步骤，按现象分类；无法自助解决的问题给出支持渠道与需提供的日志信息。",
			},
			{
				heading: "六、注意事项与限制",
				hint: "说明使用限制（数量、格式、权限）、数据安全要求、兼容性与已知问题；高风险操作给出明确警示，避免用户误操作。",
			},
			{
				heading: "七、附录",
				hint: "提供术语表、快捷键、字段说明、相关文档链接与支持联系方式；术语表与正文保持一致，只收录本手册出现的术语。",
			},
		],
	},
	{
		id: FREE_TEMPLATE_ID,
		name: "自由发挥",
		description: "不套用固定章节骨架，由 AI 根据主题与要求自行设计结构。适合已有明确提纲、或需要个性化章节的场景；请在主题中写清目标读者、用途与必须包含的内容。",
		category: "通用",
		defaults: { audience: "general", tone: "professional", length: "standard" },
		redlines: ["章节结构必须服务于主题、读者和用途，不得套用无关章节或凑数。"],
		sections: [],
	},
];

/** 深拷贝模板对象，避免调用方修改内置数据。 */
function cloneTemplate(template) {
	return {
		id: template.id,
		name: template.name,
		description: template.description,
		category: template.category,
		defaults: { ...template.defaults },
		redlines: [...template.redlines],
		sections: template.sections.map((section) => ({ heading: section.heading, hint: section.hint })),
	};
}

/**
 * 列出全部内置模板（含 free，且 free 固定最后）。
 * @returns {Array<object>} Template 数组（深拷贝，可安全修改）
 */
export function listTemplates() {
	return TEMPLATES.map(cloneTemplate);
}

/**
 * 按 id 取模板。
 * @param {string} id 模板 id
 * @returns {object|null} 模板深拷贝；未知 id 返回 null
 */
export function getTemplate(id) {
	if (typeof id !== "string") return null;
	const template = TEMPLATES.find((item) => item.id === id);
	return template ? cloneTemplate(template) : null;
}

/**
 * 取出模板的章节骨架；free 模板或未知模板返回空数组。
 * 返回值已归一化（只保留 heading / hint 两个字段），可直接注入提示词。
 * @param {object|string|null} template 模板对象或模板 id
 * @returns {Array<{heading: string, hint: string}>}
 */
export function resolveSections(template) {
	let resolved = template;
	if (typeof resolved === "string") resolved = getTemplate(resolved);
	if (!resolved || typeof resolved !== "object") return [];
	if (resolved.id === FREE_TEMPLATE_ID) return [];
	if (!Array.isArray(resolved.sections)) return [];
	return resolved.sections
		.filter((section) => section && typeof section === "object")
		.map((section) => ({
			heading: String(section.heading ?? "").trim(),
			hint: String(section.hint ?? "").trim(),
		}))
		.filter((section) => section.heading.length > 0);
}

/**
 * 生成默认红线列表（通用内置红线），每次返回全新对象。
 * @returns {Array<{id: string, text: string, builtin: true}>}
 */
export function defaultRedlines() {
	return BUILTIN_REDLINES.map((redline) => ({ id: redline.id, text: redline.text, builtin: true }));
}

/**
 * 风格枚举的中文展示标签（设置页下拉框、提示词注入共用）。
 * @returns {{audience: Record<string,string>, tone: Record<string,string>, length: Record<string,string>}}
 */
export function styleLabels() {
	return {
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
	};
}
