# dsh-doc-creator 插件架构契约（团队共享 · 权威副本）

包名 / 插件 id：`@jichong/dsh-doc-creator`，插件 id（目录、路由、loader 行）：`doc-creator`。
仓库根目录即插件目录（下文以 `doc-creator/` 表示）。

目标：一个和「PPT 知识库」同级位置的 DSH Web 插件 —— 文档编写引导流程：
模板选择或自由发挥 → 上传参考文档 → 红线要求 / 是否允许联网 → 生成大纲（多版本、可切换查看）→
确认大纲 → 生成成文（Word/.docx + Markdown）→ 大纲与成文两个阶段都能通过**对话**调整，且两阶段对话**共享同一上下文**。

本文件是团队唯一权威接口约定。所有模块按此实现；发现契约需要变更时，通知 Lead，不要自行改动别人的文件。

## 运行环境与依赖

- Node ≥ 24，纯 ESM（`"type": "module"`）。宿主是 cordis 插件：`lib/index.js` 导出 `name` / `inject` / `apply(ctx)`。
- 只允许纯 JS 依赖：`jszip`（^3.10）、`fast-xml-parser`（^5.x）。不要引入原生编译依赖。
- 宿主服务（由 Lead 的 `lib/index.js` 接线，其它模块只通过注入的函数/对象使用，不直接抓 `ctx`）：
  - `ctx.webServer`：`ctx.webServer.register({ kind: "prefix", path: "/doc-creator/api", handler })`
  - `ctx.llm`：`ctx.llm.stream({ provider, model, system, messages, maxTokens, temperature, signal })`，chunk 流（`text-delta` / `finish`）
  - `ctx.agentDefaultModel.currentSelection()` → `{ provider, model, reasoningEffort? }`
  - `ctx.web.search({ query, maxResults })` / `ctx.web.fetch({ url })`
- 数据目录：默认 `path.join(os.homedir(), ".dsh", "data", "doc-creator")`，环境变量 `DOC_CREATOR_DATA` 可覆盖。
- 测试：`node test/test-*.mjs` 直接运行，输出 `PASS`/`FAIL`，退出码 0/1；全部离线可跑（LLM 一律用假 callModel，不联网）。
- 任何模块不得读写别人 scope 的文件；不得改 `package.json` / `cordis.patch.yml` / `build.js` / 本文件（Lead scope）。

## 数据目录布局

```
<dataDir>/
├── index.json                          # { projects: { [id]: Summary } }
├── projects/<projectId>/
│   ├── meta.json                       # Project（见下）
│   ├── conversation.json               # { messages: [ChatMessage] }
│   ├── refs/<refId>/source<.ext>       # 用户上传的原始参考文件
│   ├── refs/<refId>/text.txt           # 抽出的纯文本（供 LLM 分析，可截断）
│   ├── outlines/<version>.json         # { title, sections:[{heading,points,notes}], createdAt, ... }（版本文件）
│   ├── documents/<version>.md          # 成文 Markdown
│   └── documents/<version>.docx        # 成文 Word
└── tmp/<random>/                       # 上传中转目录
```

## 数据结构（Project 等）

```js
// Project（meta.json 整个对象；service 创建/维护，store 原样持久化）
{
  id: "doc-<base36ts>-<4hex>",
  name: "文档标题",                     // 用户可改；缺省用主题前 30 字
  createdAt: 1697456400000, updatedAt: 1697456400000,
  templateId: "project-plan" | "free" | <内置模板 id>,
  topic: "写作主题 / 背景 / 目标 / 补充要求",   // 用户输入
  style: { audience: "general"|"management"|"technical"|"client",
           tone: "formal"|"professional"|"friendly",
           length: "short"|"standard"|"detailed" },
  model: null | { provider: "deepseek-official", model: "deepseek-flash" },   // null = 跟随 DSH 默认模型
  refs: [ Ref ],
  redlines: [ { id: "rl-...", text: "红线要求原文", builtin: true|false } ],
  webSearch: { enabled: false, queries: [], lastSearchAt: null },
  sources: [ Source ],                  // 联网检索结果缓存（大纲生成时刷新）
  outline: {
    active: 1,                          // 当前展示版本
    confirmed: null | 1,                // 已确认版本号
    versions: [ OutlineVersionMeta ],   // 见下，版本证据在 outlines/<version>.json
  },
  document: {
    active: null | 1,
    versions: [ DocumentVersionMeta ],
  },
  warnings: [ "字符串" ],               // 最近一次生成的非致命提示（联网失败、Word 导出失败等）
  stage: "setup" | "outline" | "document",   // 派生字段，service 返回时计算
}

// Ref（参考文档）
{ id: "ref-...", name: "原始文件名.docx", size: 123456, ext: "docx",
  status: "ready" | "error", error: null | "错误信息",
  chars: 12345, truncated: false, method: "docx"|"pdf"|"pptx"|"text", addedAt: 1697456400000 }

// Source（联网资料）
{ id: "src-1", title: "标题", url: "https://…", snippet: "摘要", addedAt: 1697456400000 }

// OutlineVersionMeta（project.outline.versions[] 元素；正文在 outlines/<v>.json）
// 注意：service 返回 Project 时会为每项注入完整 sections（内容很小），
// 前端切换大纲版本不需要额外请求。
{ version: 1, title: "文档标题", sectionCount: 8, chars: 800,
  createdAt: 1697456400000, changeNote: "初始生成" | "用户对话调整" | "重新生成",
  status: "draft" | "confirmed", sourceCount: 3,
  sections: [ { heading, points, notes } ] }

// outlines/<version>.json
{ version: 1, title: "文档标题",
  sections: [ { heading: "一、背景与目标", points: ["要点 1", "要点 2"], notes: "可选：写作提示" } ],
  createdAt: 1697456400000, model: { provider, model } | null }

// DocumentVersionMeta（project.document.versions[] 元素；正文在 documents/<v>.md/.docx）
{ version: 1, outlineVersion: 1, title: "文档标题",
  wordCount: 2310, createdAt: 1697456400000,
  format: ["md", "docx"],             // docx 失败时只有 "md"，并写 warnings
  model: { provider, model } | null,
  validation: [ ValidationItem ] }

// ValidationItem（红线 / 长度 / 结构 / 引用自检结果）
{ kind: "redline"|"length"|"section"|"citation", label: "红线原文或检查项",
  status: "pass"|"risk"|"unknown", note: "说明" }

// ChatMessage（conversation.json.messages[]，两阶段共用同一数组 → 共享上下文）
{ id: "msg-...", role: "user"|"assistant", content: "文本", phase: "outline"|"document",
  at: 1697456400000, error: false,
  action: null | { kind: "outline"|"document", version: 2 } }   // assistant 触发了新版本时

// Summary（index.json 里每项，由 store 从 Project 派生）
{ id, name, createdAt, updatedAt, stage, templateId, refsCount,
  outlineCount: project.outline.versions.length,
  outlineActive: project.outline.active,
  confirmed: project.outline.confirmed,
  documentCount: project.document.versions.length,
  documentActive: project.document.active,
  lastMessageAt: 0 }

// Job（内存 job 注册表；API 返回）
{ id: "job-...", kind: "outline"|"document"|"chat", projectId, phase: "大纲"|"成文"|"对话",
  status: "running"|"done"|"error", progress: 0-100, message: "当前步骤说明",
  createdAt, updatedAt, result: null|object, error: null|string }

// Template（lib/templates.js 内置）
{ id, name, description, category: "通用"|"方案"|"产品"|"技术"|"研究"|"其他",
  sections: [ { heading: "一、项目背景", hint: "写作提示" } ],
  defaults: { audience, tone, length },
  redlines: ["模板建议红线 1", "…"] }
```

派生约定：
- `stage = "setup" if outline.versions.length === 0; "outline" if confirmed == null; "document"`.
- 红线自检（validation）在成文生成任务内做：红线逐条 LLM 自检 + 长度 + 大纲章节覆盖 + 引用检查（有 sources 时）。
- 生成大纲时若 `webSearch.enabled`：**service 层**先调 `engine.planSearchQueries` 生成 2–4 条查询，再逐个调用注入的 `search`、把结果持久化到 `project.sources`，然后作为 `sources` 参数传给 `generateOutline`；`generateOutline` 内部不再自行检索（避免重复请求/重复失败）。检索失败不失败任务，写 `warnings`。

## 模块契约（写作用域互不重叠）

### A. `lib/store.js` —— 负责人：backend-core

```js
export function createStore(dataDir) -> store
store = {
  dataDir, projectsRoot,
  async ensureDirs(),                              // mkdir -p
  async loadIndex() -> { projects: {} },           // 缺文件/损坏 → 空索引
  async saveIndex(index),
  async listProjects() -> [Summary],               // updatedAt 降序
  async readProject(id) -> Project|null,
  async writeProject(project),                     // 原子写 meta.json + upsert index 里的 Summary
  async deleteProject(id),                         // 删目录 + 从 index 移除
  projectDir(id),
  refDir(id, refId),
  refSourcePath(id, refId, filename),              // filename 已净化；保留原扩展名
  async writeRefText(id, refId, text),
  async readRefText(id, refId) -> string|null,
  async readConversation(id) -> { messages: [] },  // 缺文件 → { messages: [] }
  async writeConversation(id, conversation),       // 原子写
  outlinePath(id, version),                        // 版本号校验 1..9999
  async writeOutline(id, version, outline),
  async readOutline(id, version) -> object|null,
  documentPath(id, version, ext),                  // ext: "md" | "docx"
  async writeDocumentFile(id, version, ext, data), // data: string|Uint8Array
  async readDocumentFile(id, version, ext) -> Buffer|null,
  async tmpDir(),                                  // mkdtemp 新目录
  assertId,                                        // 导出的校验函数：/^[a-z0-9][a-z0-9-]{0,64}$/
  genId(prefix),                                   // `${prefix}-${base36ts}-${rand4hex}`
}
```
- 所有外部传入的 id（projectId/refId/version）必须先 `assertId` / 数字校验，防路径穿越。
- 原子写：同目录 `.<rand>.tmp` + `fs.rename`；写 JSON 用 `JSON.stringify(value, null, 1)`。
- `writeProject` 必须重算 Summary 并原子写 index；并发不是本插件关注点（单进程、服务层串行）。
- Summary 派生字段严格按上面 Summary 结构；`templateId` 原样带出。

### B. `lib/templates.js` —— 负责人：backend-core

```js
export const FREE_TEMPLATE_ID = "free";
export function listTemplates() -> [Template];       // 9 个左右内置模板，最后可含 free
export function getTemplate(id) -> Template|null;    // 未知 id → null
export function resolveSections(template) -> [{ heading, hint }];  // free → []
export const BUILTIN_REDLINES -> [ { id, text } ];   // 6 条通用红线（不含 template 专属）
export function defaultRedlines() -> [ { id:"rl-builtin-<n>", text, builtin:true } ];
export function styleLabels() -> {
  audience: { general:"通用读者", management:"管理层", technical:"技术读者", client:"客户/外部" },
  tone: { formal:"正式严谨", professional:"专业清晰", friendly:"友好易懂" },
  length: { short:"简短（约 800–1200 字）", standard:"标准（约 2000–3500 字）", detailed:"详尽（约 4500–7000 字）" },
};
```
内置模板要求（中文、可直接指导写作，每模板 5–8 个 section，每节含 hint）：
1. `general-report` 通用报告（通用）
2. `project-plan` 项目方案 / 立项报告（方案）
3. `prd` 产品需求文档 PRD（产品）
4. `tech-design` 技术方案设计（技术）
5. `research-report` 研究报告 / 调研报告（研究）
6. `meeting-minutes` 会议纪要（其他）
7. `work-report` 工作汇报 / 周报月报（其他）
8. `user-manual` 操作手册 / 用户指南（技术）
9. `free` 自由发挥（"通用"，sections: []，description 引导用户写主题与要求）
各模板 `redlines` 给 1–3 条模板专属建议红线（如研究报告「数据必须有来源」）。

### C. `lib/extract.js` —— 负责人：backend-core

```js
export async function extractText({ filePath, name }) ->
  { text, chars, truncated, method: "text"|"docx"|"pdf"|"pptx"|"html" }
```
- 支持：`.txt .md .markdown .json .csv`（直接 utf8）、`.docx`（jszip 解包 + fast-xml-parser 读 `word/document.xml`，段落 `\n`，表格行 `\t` 列/`\n` 行）、`.pptx`（jszip + 读 `ppt/presentation.xml` 的 sldIdLst 顺序，回退按 `ppt/slides/slideN.xml` 数字序；逐页文本，页间 `\n\n`）、`.pdf`（`pdftotext -q -enc UTF-8 <file> -` 子进程，超时 20s；`pdftotext` 不存在时抛可读错误）、`.html/.htm`（去标签、解实体）。
- 输出上限 `MAX_TEXT_CHARS = 400000`，超出截断并在文本尾部写 `\n\n[内容过长，已截断]`，`truncated=true`。
- 失败抛 `Error`，消息直接给用户看（中文，如 "PDF 解析失败：…"）。`.doc` 旧格式：抛"暂不支持 .doc，请另存为 .docx 或 PDF 后上传"。
- 不依赖网络；jszip/fast-xml-parser 从本包 node_modules 解析。

### D. `lib/docx.js` —— 负责人：docx-engine

```js
export function parseMarkdown(markdown) -> Block[];   // 导出供测试与复用
export async function buildDocxBuffer({ markdown, title, subtitle?, meta?, cover?, toc? }) -> Uint8Array;
export async function buildDocx({ markdown, title, subtitle?, meta?, outPath, cover?, toc? }) -> { outPath, bytes, headings, paragraphs, wordCount };
```
- 纯 JS 生成合法 OOXML（jszip 打包）：`[Content_Types].xml`、`_rels/.rels`、`docProps/core.xml`、`docProps/app.xml`、`word/document.xml`、`word/styles.xml`、`word/settings.xml`、`word/numbering.xml`、`word/footer1.xml`（页码）、`word/_rels/document.xml.rels`。
- Markdown 支持（GFM 子集）：`#`–`######` 标题、段落、`**粗体**` / `*斜体*` / `` `行内代码` ``、`-`/`*`/`+` 无序列表（可 2 级缩进）、`1.` 有序列表、`>` 引用、``` 代码块、GFM 表格（`| a | b |` + 分隔行）、`---` 分隔线、`[文本](url)`（渲染为文本+URL，URL 以灰色小字随文或脚注形式均可，但不得吞掉文字）、`<!-- pagebreak -->` 分页。
- 版式：A4（11906×16838 twips）、页边距 1440/1440/1440/1440；正文宋体 11pt（eastAsia 宋体，ascii Times New Roman），1.5 倍行距；标题 1/2/3 用黑体、18/15/13pt、加粗、段前段后间距；标题自动编号不要求（保留原文编号）；页脚居中「第 X 页 / 共 Y 页」域；可选中封面（标题 26pt 居中、副标题、日期、生成说明，之后分页）。
- `toc` 默认 true：封面后插入「目录」静态列表（遍历 level≤2 的标题，按 `1.` / `1.1` 形式编号），之后分页。不做 Word TOC 域。
- 中文字体/字号在 styles.xml 里显式设置 `w:rFonts w:eastAsia`；所有文本 XML 转义；非法控制字符剔除。
- 测试（`test/test-docx.mjs`）：用 jszip 重新打开产物、断言 XML 可解析且包含关键文本/标题；生成一段覆盖所有块类型的样例；如本机有 `python-docx`，可另跑子进程校验（可选、失败仅警告不影响 PASS，若用则先检测 python3）。
- 产物必须能被 Word/WPS 打开：至少要过 `unzip -t` + XML 解析 + python-docx 加载（本机有 python-docx 1.2）。

### E. `lib/engine.js` —— 负责人：llm-engine

```js
export function createEngine({ callModel, search, logger, now = Date.now }) -> engine
// callModel({ system, messages:[{role:"user"|"assistant", content: string}], maxTokens?, temperature?, signal? })
//   -> Promise<{ text: string, usage?: object }>
// search({ query, maxResults?, signal? }) -> Promise<{ sources: [{ title, url, snippet }] }>（可能抛错）
// service 会为每次生成创建新的 createEngine 实例（绑定项目选定的模型），因此 createEngine 必须无状态可重复创建。
engine.planSearchQueries({ project, template }) -> [string]           // 2–4 条，确定性
engine.generateOutline({ project, template, references, sources, job, signal })
  -> { outline: { title, sections:[{heading,points,notes}] }, warnings?: [string] }
engine.generateDocument({ project, template, outline, references, sources, job, signal })
  -> { markdown, title, warnings?: [string] }
engine.revise({ project, template, phase, outline, document, references, sources, message, job, signal })
  -> { reply, outline?: { title, sections }, markdown?: string, warnings?: [string] }
engine.checkRedlines({ project, redlines, outline, markdown, job, signal })
  -> { report: [{ label, status:"pass"|"risk"|"unknown", note }] }
export function parseArtifact(text) -> { reply, outline?, document?, report? }   // 供测试
export function extractJson(text) -> any | null                                  // 供测试
```
- **模型输出协议**（提示词必须明确写出；解析必须宽容）：
  - 大纲：`<OUTLINE>{JSON}</OUTLINE>`；解析后归一化（title 缺省用 project.name；sections 至少 2 节；heading 去空；points 数组字符串、最多 8 条；notes 可空）。
  - 成文：`<DOCUMENT>\nMarkdown 全文\n</DOCUMENT>`；去掉围栏/标签；确保以 `# 标题` 开头（缺失时补 `# ${outline.title}`）。
  - 对话调整：自由文本回复 + **可选**紧随一个 `<OUTLINE>…</OUTLINE>` 或 `<DOCUMENT>…</DOCUMENT>`（只有用户要求修改时才输出；只讨论/提问时不输出）。`reply` 取 tag 之前文本（去首尾空行），tag 缺失时整段为 reply。
  - 红线自检：`<REPORT>[{"label":"…","status":"pass|risk|unknown","note":"…"}]</REPORT>`。
  - 宽容回退：无 tag 时大纲尝试 `extractJson` 抓第一个 JSON 对象；成文把整段当 Markdown；对话尝试 JSON `{reply, outline|markdown}`；自检尝试抓 JSON 数组。JSON 允许 ```json 围栏、首尾说明文字；`extractJson` 需做括号配对扫描（跳过字符串内括号）并容忍尾随逗号。
- 提示词要求（中文）：
  - 角色：资深中文文档撰写专家。默认简体中文。
  - 注入：文档名/主题/风格三选项中文描述/模板骨架（heading + hint）/参考文档摘录/联网资料/红线（"必须遵守，违反即返工"）/对话上下文（共享，最近 ≤30 条、≤12000 字）。
  - 参考文档摘录：每条 `【参考文档 i：name】` 后接正文；单条 ≤6000 字、总量 ≤16000 字，超出截断并注明。联网资料 `[n] 标题 — URL\n摘要`，总量 ≤6000 字。
  - 大纲要求：6–10 节（模板骨架优先；自由发挥自行设计），每节 2–5 个要点，要点为短句；README 级概览可选。只输出 tag。
  - 成文要求：严格按已确认大纲的标题与顺序；正文完整、有细节、不空话；不编造数据/引用，未知处标注「（待核实）」；有 sources 时用 `[n]` 标注并在文末「参考资料」列出 URL；长度按 style.length 目标；只输出 tag。
  - 对话调整：结合对话上下文理解指代（"第 3 节"、"上一版"），保持与已确认大纲一致；输出简短 reply + 可选完整新版本（不是 diff）。
  - 红线自检：逐条判定 pass/risk，risk 给具体位置与改法；不编造问题。
- job 进度（用 `job?.update(progress, message)`，job 可能为 undefined）：大纲 `10 检索资料 → 30 生成大纲 → 90 校验/保存`；成文 `5 整理大纲与资料 → 15 撰写正文 → 75 红线自检 → 90 排版`。
- maxTokens 建议：大纲 4000；成文 short 5000 / standard 9000 / detailed 14000；对话 9000；自检 3000。
- 引擎不读写磁盘、不碰 store；只接收已组装好的数据（references = `[{name,text}]`）。
- 测试 `test/test-engine.mjs`：假 callModel/search；覆盖 tag 解析、无 tag 回退、JSON 容错、归一化、search 失败 warning、红线 report 归一化、revise 只讨论（无 artifact）与带 artifact 两种情况。

### F. `lib/model.js` / `lib/jobs.js` / `lib/service.js` / `lib/api.js` / `lib/index.js` —— 负责人：Lead（勿动）

- `model.js`：真实 `callModel`（解析 provider/model：project.model → env `DOC_CREATOR_PROVIDER`/`DOC_CREATOR_MODEL` → `agentDefaultModel.currentSelection()` → 第一个可用 provider/model；`ctx.llm.stream` 组装 text-delta，finish 错误抛出；一次重试）、`search`（`ctx.web.search` 归一化 sources）、`listModels()`。
- `service.js`：编排 create/update/list/get/ref 上传/删除/大纲生成/确认/成文生成/对话/下载；job 进度回调；validation 组装（长度/章节覆盖/引用 + engine.checkRedlines）；conversation 持久化；sources 缓存。
- `api.js`：HTTP 路由（下节），`createApiHandler(deps)` + `registerRoutes(ctx, deps)` 两个导出（便于离线测试）。
- `index.js`：cordis 入口，要求 `webServer`；`ctx.inject(["llm","agentDefaultModel"], …)` / `ctx.inject(["web"], …)` 提供可选服务；挂 `/doc-creator/api` 前缀；启动时 ensureDirs。

### G. HTTP API（前缀 `/doc-creator/api`，除注明外 POST JSON）

响应统一：成功 `{ ok:true, value }`；失败 `{ ok:false, error:{ code, message } }`（HTTP 状态码 4xx/5xx）。

| 端点 | 请求 | 响应 value |
|---|---|---|
| `POST /templates` | `{}` | `{ templates: Template[] }` |
| `POST /models` | `{}` | `{ selection: {provider,model}\|null, providers: [{provider,name,models:[{id,name}]}] }`（服务缺失时也 200，selection=null） |
| `POST /list` | `{}` | `{ projects: Summary[] }` |
| `POST /create` | `{ name?, templateId? }` | `{ project: Project }` |
| `POST /get` | `{ projectId }` | `{ project: Project }`（含 conversation.messages、outline.versions 全量 meta、document.versions meta；不含成文正文） |
| `POST /update` | `{ projectId, patch:{ name?, templateId?, topic?, style?, redlines?, webSearch?, model? } }` | `{ project }` |
| `POST /delete` | `{ projectId }` | `{ deleted: true }` |
| `POST /upload-ref?projectId=&name=<encodeURIComponent>` | body = 文件原始字节（application/octet-stream） | `{ project, ref }`（同步抽取文本；失败也返回 200 + ref.status="error"） |
| `POST /delete-ref` | `{ projectId, refId }` | `{ project }` |
| `POST /ref-preview` | `{ projectId, refId, maxChars? }` | `{ name, text }` |
| `POST /outline-generate` | `{ projectId }` | `{ jobId }`（已有 running job 时 409 `busy`） |
| `POST /outline-confirm` | `{ projectId, version }` | `{ project }` |
| `POST /document-generate` | `{ projectId, outlineVersion? }` | `{ jobId }` |
| `POST /chat` | `{ projectId, message, phase: "outline"\|"document" }` | `{ jobId }` |
| `POST /job` | `{ jobId }` | `{ job: Job }` |
| `POST /document` | `{ projectId, version? }` | `{ markdown, meta: DocumentVersionMeta }` |
| `GET /download/<projectId>/<version>.docx` | — | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`，attachment |
| `GET /download/<projectId>/<version>.md` | — | `text/markdown; charset=utf-8`，attachment |

job result：大纲 `{ outlineVersion }`；成文 `{ documentVersion }`；对话 `{ reply, outlineVersion?, documentVersion? }`。
上传上限 50MB；JSON body 上限 4MB。所有错误 message 为中文、可直接展示。

### H. 客户端（浏览器 bundle）—— 负责人：ui-shell（base + app）、ui-review（review）

`node build.js` 把三个文件**按序拼进同一个 module-loader factory**（`require` 可用，React 为 `require("react")`）：
1. `src/client.base.js` —— `const React = require("react");`、base CSS、API 封装、通用组件、ProjectRail、StepBar、SetupView（模板/主题/参考/红线/联网/模型）
2. `src/client.review.js` —— `REVIEW_CSS`、MarkdownView、OutlineView、DocumentView、ChatDock
3. `src/client.app.js` —— `App`、状态与动作、`apply(ctx)`、`module.exports`

规则：
- 无 JSX，一律 `React.createElement`（文件里定义 `const h = React.createElement`）；可用 `useState/useEffect/useCallback/useRef/useMemo`。
- 三文件共享同一闭包：base 里的 `h`、`API`、`post`、`uploadRef`、`fmtTime`、`fmtSize` 等可被 review/app 直接使用；app.js 可引用前两文件的函数（函数声明有提升）。**review.js 不能用 base 的 `const` 之前初始化阶段执行副作用**（顶层只定义常量/函数）。
- CSS：`BASE_CSS`（base.js）+ `REVIEW_CSS`（review.js），app.js 里 `ensureCss()` 注入一个 `<style>`，id `@jichong/dsh-doc-creator/dc.css`。所有 class 前缀 `dc-`；颜色一律用 DSH 设计 token（`var(--dsw-alias-*, 回退色)`，参考 conv-4-inspector / ppt-search 的写法），深浅色都好看；不要 `prefers-color-scheme`。
- 所有 fetch 走 `post()`，失败抛 `Error(message)`；UI 显示中文错误条。
- 所有文案简体中文。

**数据流（app.js）**
- state：`{ templates, projects, models, selectedId, project, view ("setup"|"outline"|"document"), busy: Job|null, jobError, toast, docContent: {markdown,meta}|null, uploading, loading }`
- 初始化：`POST /templates`、`/models`、`/list`；无选中项目时显示空态 + 模板展示。
- `selectProject(id)` → `POST /get`；`view` 取 `project.stage`；切换项目重置 docContent。
- `patchProject(patch)` → `POST /update` 后用返回值刷新 `project`（防抖：输入框可本地 state，失焦/按钮触发保存）。
- `createProject(templateId?)` → `POST /create`，成功后选中并进入 setup。
- `uploadRef(file)` → `POST /upload-ref?projectId=&name=`，body=file bytes，`fetch` 直接发（不走 post），成功后刷新 project；上传中禁用；失败展示。
- `runJob(kind)`：POST 对应端点拿 `jobId`，置 `busy`；每 900ms `POST /job`，完成后：刷新 project、成文任务再拉 `/document`；清 busy；toast 成功/失败；job 期间禁用生成/聊天按钮。
- `sendChat(text, phase)` → `POST /chat`（同样轮询）；消息立即显示（或依赖 job 完成后的 project 刷新）。
- `confirmOutline(version)` → 刷新 project。
- `loadDocument(version)` → `POST /document`。
- 下载：`<a href="/doc-creator/api/download/<id>/<v>.docx">` 直接链接即可（可 `download` 属性）。

**组件 props 契约**
- `ProjectRail({ projects, selectedId, onSelect, onCreate, onDelete, loading })`
- `StepBar({ step, enabled, onStep })`：step 0/1/2；enabled=[true,outlineCount>0,confirmed!=null]
- `SetupView({ project, templates, models, busy, job, onPatch, onCreate, onUploadRef, onRemoveRef, onGenerate })`
  - 模板卡片网格（含「自由发挥」）；选中显示骨架预览；`onPatch({templateId})`
  - 主题与要求：名称、主题 textarea、风格三下拉；`onPatch({name/topic/style})`
  - 参考文档：拖拽/点选上传（accept `.docx,.pdf,.txt,.md,.markdown,.pptx,.json,.csv,.html`），列表显示名称、大小、字数、状态；删除
  - 红线：内置默认红线列表（可勾选/删除）+ 模板建议红线（点击添加）+ 自定义输入添加；`onPatch({redlines})`
  - 联网：开关 + 说明；`onPatch({webSearch:{enabled}})`
  - 模型：下拉（默认模型 / providers），`onPatch({model})`
  - 底部主按钮「生成大纲」（topic 非空才可用）；busy 时显示进度文案
- `OutlineView({ project, busy, job, onVersion, onConfirm, onRegenerate })`
  - 版本 tab（v1..vN，标注「已确认」「最新」、时间、来源）；切换 `onVersion(v)`
  - 当前版本：标题、meta（节数、字数、资料数）、sections 卡片（序号、heading、points 列表、notes）
  - 按钮：「确认大纲并生成成文」（主）、「重新生成大纲」、「换个版本看看」
- `DocumentView({ project, document, busy, job, onVersion, onRegenerate, onDownload, onView })`
  - 版本 tab；渲染 `MarkdownView({markdown})`；字数/时间/大纲版本；红线自检摘要（pass/risk/unknown 计数 + 明细折叠）；参考资料（project.sources）
  - 下载 Word / Markdown 链接；「重新生成」；`onVersion`
- `ChatDock({ phase, messages, busy, job, onSend, onQuick })`
  - 头部「AI 调整 · 大纲阶段/成文阶段 · 共享上下文」；消息列表（用户右侧、助手左侧；action 显示「已更新为大纲 v2」可点击）
  - 快捷建议 chips（大纲：增加章节/精简某节/调整语气；成文：扩写某段/统一术语/补充数据来源）
  - 输入框 + 发送；busy 时禁用并显示「AI 正在处理…」；Enter 发送、Shift+Enter 换行
- `MarkdownView({ markdown })`：纯前端 markdown 渲染（标题/段落/粗斜体/行内代码/列表/引用/代码块/表格/分隔线/链接），样式贴近文档排版；必须防 XSS（只渲染文本节点，链接仅 http/https）。

**布局**
- 顶栏：标题「文档创作」+ 当前项目名 + 状态徽标 + 刷新；左侧项目栏（240px，可折叠/窄屏隐藏）；主区按 `view` 渲染；大纲/成文阶段右侧 340px ChatDock（窄屏 <1000px 时 ChatDock 可折叠成底部抽屉/上下堆叠）。
- 空态：介绍 + 模板卡片，点击模板直接创建。
- 加载/失败/空数据均有中文提示；生成中显示阶段进度条与文案。

### 测试基线

- `node test/test-store.mjs`、`test/test-templates.mjs`、`test/test-extract.mjs`（backend-core）
- `node test/test-docx.mjs`（docx-engine）
- `node test/test-engine.mjs`（llm-engine）
- Lead 另写 `test/test-service.mjs`、`test/test-api.mjs`、`test/run-all.mjs`。
- 全部离线、确定性；测试用临时目录（`fs.mkdtemp(os.tmpdir())`）并在结束时清理。**不得**写 `~/.dsh/data/doc-creator`。

### 写作范围（严禁越界）

- backend-core：`lib/store.js`、`lib/templates.js`、`lib/extract.js`、`test/test-store.mjs`、`test/test-templates.mjs`、`test/test-extract.mjs`、`test/make-extract-fixtures.py`、`test/fixtures/**`
- docx-engine：`lib/docx.js`、`test/test-docx.mjs`、`test/fixtures/docx-*`（仅自己的）
- llm-engine：`lib/engine.js`、`test/test-engine.mjs`
- ui-shell：`src/client.base.js`、`src/client.app.js`
- ui-review：`src/client.review.js`
- Lead：`lib/index.js`、`lib/api.js`、`lib/service.js`、`lib/model.js`、`lib/jobs.js`、`build.js`、`package.json`、`cordis.patch.yml`、`README.md`、`test/test-service.mjs`、`test/test-api.mjs`、`test/run-all.mjs`、安装/重启/验证。
