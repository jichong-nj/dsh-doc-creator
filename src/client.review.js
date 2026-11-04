// doc-creator — 浏览器端「大纲 / 成文 / Markdown 渲染 / AI 调整对话」视图。
//
// 本文件是 build.js 生成的 module-loader factory 的函数体的一部分，与
// src/client.base.js、src/client.app.js 被拼接进同一个闭包（无 JSX、无打包器，
// 一律 React.createElement）。base.js 声明的 React / h / API / post / fmtTime /
// fmtSize / JobProgress 等可直接使用；本文件顶层只声明常量与函数（无副作用），
// 对外提供：REVIEW_CSS、MarkdownView、OutlineView、DocumentView、ChatDock。
// 其余内部件全部 R 前缀，避免与 base/app 的顶层名字冲突。

const RuseState = React.useState;
const RuseEffect = React.useEffect;
const RuseMemo = React.useMemo;
const RuseRef = React.useRef;
const RuseCallback = React.useCallback;

// base.js 的 API 前缀 / 时间格式化 / JobProgress 在此做一次兜底引用：
// typeof 对未声明的标识符不会抛错，方便本文件单独做语法与渲染烟雾测试。
const R_API_BASE = typeof API === "string" && API !== "" ? API : "/doc-creator/api";
const R_FMT_TIME = typeof fmtTime === "function"
	? fmtTime
	: function (ms) {
		if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
		return new Date(ms).toLocaleString("zh-CN", { hour12: false });
	};
const R_JOB_PROGRESS = typeof JobProgress === "function" ? JobProgress : null;

// ── 小工具 ───────────────────────────────────────────────────────────────────

function Rpad2(n) {
	const v = Math.trunc(Number(n) || 0);
	return v < 10 ? "0" + v : String(v);
}

function RfmtNum(n) {
	if (typeof n !== "number" || !Number.isFinite(n)) return "";
	return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function RfmtTimeShort(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
	const d = new Date(ms);
	const pad = (n) => (n < 10 ? "0" + n : String(n));
	return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/** busy 与 job 在 App 里同值（Job 对象或 null），统一成 Job|null。 */
function RjobOf(busy, job) {
	if (job !== null && typeof job === "object") return job;
	if (busy !== null && typeof busy === "object") return busy;
	return null;
}

function RsafeHref(url) {
	if (typeof url !== "string") return null;
	const u = url.trim();
	return /^https?:\/\//i.test(u) ? u : null;
}

function RdownloadName(project, meta, ext) {
	const title = (meta && meta.title) || (project && project.name) || "文档";
	let safe = String(title).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60);
	if (safe === "") safe = "文档";
	const v = meta && Number(meta.version) > 0 ? Number(meta.version) : 1;
	return safe + "-v" + v + "." + ext;
}

function Rpct(n) {
	if (typeof n !== "number" || !Number.isFinite(n)) return null;
	return Math.max(0, Math.min(100, Math.round(n)));
}

function RpickVersion(preferred, versions) {
	const list = Array.isArray(versions) ? versions : [];
	if (list.length === 0) return null;
	const pv = Number(preferred);
	if (Number.isFinite(pv) && list.some((v) => v && Number(v.version) === pv)) return pv;
	let best = null;
	for (const v of list) {
		const n = v && Number(v.version);
		if (Number.isFinite(n) && (best === null || n > best)) best = n;
	}
	return best;
}

function RversionMeta(versions, version) {
	const list = Array.isArray(versions) ? versions : [];
	for (const v of list) if (v && Number(v.version) === version) return v;
	return null;
}

function Rlist(value) {
	return Array.isArray(value) ? value : [];
}

// ── 状态 / 分类文案 ──────────────────────────────────────────────────────────

const R_VALID_STATUS = {
	pass: { label: "通过", key: "pass" },
	risk: { label: "需关注", key: "risk" },
	unknown: { label: "待确认", key: "unknown" },
};

const R_VALID_KIND = { redline: "红线", length: "长度", section: "结构", citation: "引用" };

const R_PHASE_LABEL = { outline: "大纲阶段", document: "成文阶段" };

const R_CHIPS = {
	outline: [
		"增加「风险与应对」章节",
		"第 3 节再精简一些",
		"语气更偏管理层汇报",
		"补充一节实施计划",
	],
	document: [
		"扩写第 2 节并补充例子",
		"统一全文术语与称谓",
		"给结论补充数据来源",
		"精简到标准篇幅",
	],
};

// ── 图标（内联 SVG，随文字颜色变化） ────────────────────────────────────────

const R_ICON_PATHS = {
	check: ["M3.2 8.6l3.1 3.1 6.5-7.2"],
	alert: ["M8 2.4 14.3 13.6H1.7L8 2.4Z", "M8 6.2v3.4", "M8 11.5v.01"],
	question: ["M8 1.7a6.3 6.3 0 1 0 0 12.6A6.3 6.3 0 0 0 8 1.7Z", "M6.2 6.1a1.85 1.85 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.3", "M8 11.2v.01"],
	refresh: ["M13.2 8a5.2 5.2 0 1 1-1.6-3.8", "M13.2 2.6v3.2H10"],
	download: ["M8 2.6v7.4", "M4.7 7.3 8 10.6l3.3-3.3", "M3 13.3h10"],
	send: ["M8 13V3.4", "M4.1 7.3 8 3.4l3.9 3.9"],
	chevron: ["M4.4 6.4 8 10l3.6-3.6"],
	doc: ["M4 1.9h5l3 3v9.2H4V1.9Z", "M9 1.9v3h3", "M6.2 8.1h3.6", "M6.2 10.6h3.6"],
	spark: ["M8 1.8l1.25 3.35L12.6 6.4l-3.35 1.25L8 11l-1.25-3.35L3.4 6.4l3.35-1.25L8 1.8Z"],
	shield: ["M8 1.9l5 1.85v3.9c0 2.75-2 4.9-5 6.25-3-1.35-5-3.5-5-6.25v-3.9L8 1.9Z", "M5.7 7.9l1.6 1.6 2.9-3.1"],
	link: ["M6.5 9.5l3-3", "M7.2 4.9l.8-.8a2.45 2.45 0 0 1 3.5 3.5l-.8.8", "M8.8 11.1l-.8.8a2.45 2.45 0 0 1-3.5-3.5l.8-.8"],
	info: ["M8 1.7a6.3 6.3 0 1 0 0 12.6A6.3 6.3 0 0 0 8 1.7Z", "M8 7.2v3.4", "M8 4.8v.01"],
};

function RIcon({ name, size, className, strokeWidth }) {
	const paths = R_ICON_PATHS[name] || R_ICON_PATHS.info;
	return h("svg", {
		className: "dcr-icon" + (className ? " " + className : ""),
		width: size || 14,
		height: size || 14,
		viewBox: "0 0 16 16",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: strokeWidth || 1.5,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": "true",
		focusable: "false",
	}, paths.map((d, i) => h("path", { key: i, d })));
}

// ── 通用外观小件 ─────────────────────────────────────────────────────────────

function RBusyBar({ busy, job, compact }) {
	if (!busy) return null;
	const j = RjobOf(busy, job);
	if (typeof R_JOB_PROGRESS === "function") {
		return h("div", { className: "dcr-busy-box" + (compact ? " dcr-is-compact" : "") },
			h(R_JOB_PROGRESS, { job: j }));
	}
	const pct = j ? Rpct(j.progress) : null;
	const msg = j && typeof j.message === "string" && j.message !== "" ? j.message : "正在处理…";
	return h("div", { className: "dcr-busy-box" + (compact ? " dcr-is-compact" : "") },
		h("div", { className: "dcr-busy-line" },
			h("span", { className: "dcr-spinner", "aria-hidden": "true" }),
			h("span", { className: "dcr-busy-msg" }, msg),
			pct === null ? null : h("span", { className: "dcr-busy-pct" }, pct + "%")),
		pct === null ? null : h("div", { className: "dcr-busy-track" },
			h("i", { style: { width: pct + "%" } })));
}

function REmpty({ icon, title, hint, action }) {
	return h("div", { className: "dcr-empty" },
		h("div", { className: "dcr-empty-icon" }, h(RIcon, { name: icon || "doc", size: 22 })),
		h("div", { className: "dcr-empty-title" }, title || "暂无内容"),
		hint ? h("p", { className: "dcr-empty-hint" }, hint) : null,
		action ? h("div", { className: "dcr-empty-action" }, action) : null);
}

function RWarnings({ warnings }) {
	const list = Rlist(warnings).filter((w) => typeof w === "string" && w.trim() !== "");
	if (list.length === 0) return null;
	return h("div", { className: "dcr-warnbar", role: "status" },
		h("span", { className: "dcr-warn-icon" }, h(RIcon, { name: "alert", size: 14 })),
		h("div", { className: "dcr-warn-list" },
			list.map((w, i) => h("div", { key: i, className: "dcr-warn-item" }, w))));
}

// ── 版本 tab ────────────────────────────────────────────────────────────────

function RVersionTabs({ versions, active, confirmed, kind, onVersion }) {
	const list = Rlist(versions).filter((v) => v && Number.isFinite(Number(v.version)));
	if (list.length === 0) return null;
	let latest = null;
	for (const v of list) if (latest === null || Number(v.version) > latest) latest = Number(v.version);
	const isDoc = kind === "document";
	return h("div", {
		className: "dcr-tabs",
		role: "tablist",
		"aria-label": isDoc ? "成文版本切换" : "大纲版本切换",
	}, list.map((v) => {
		const ver = Number(v.version);
		const isActive = ver === active;
		const bits = isDoc
			? [v.wordCount ? RfmtNum(v.wordCount) + " 字" : "", v.outlineVersion ? "大纲 v" + v.outlineVersion : ""]
			: [v.changeNote || "", v.sectionCount ? v.sectionCount + " 节" : ""];
		const sub = [RfmtTimeShort(v.createdAt)].concat(bits.filter(Boolean)).filter(Boolean);
		const badges = [];
		if (Number(confirmed) === ver) badges.push(h("span", { key: "c", className: "dcr-tag dcr-tag-green" }, "已确认"));
		if (ver === latest && list.length > 1) badges.push(h("span", { key: "l", className: "dcr-tag dcr-tag-blue" }, "最新"));
		return h("button", {
			key: ver,
			type: "button",
			role: "tab",
			"aria-selected": isActive ? "true" : "false",
			className: "dcr-tab" + (isActive ? " dcr-is-active" : ""),
			onClick: typeof onVersion === "function" ? () => onVersion(ver) : undefined,
			title: [R_FMT_TIME(v.createdAt), v.changeNote, isDoc
				? [RfmtNum(v.wordCount) ? RfmtNum(v.wordCount) + " 字" : "", v.outlineVersion ? "大纲 v" + v.outlineVersion : ""].filter(Boolean).join(" · ")
				: [v.sectionCount ? "共 " + v.sectionCount + " 节" : "", v.sourceCount ? v.sourceCount + " 份资料" : ""].filter(Boolean).join(" · "),
				Number(confirmed) === ver ? "已确认" : ""].filter(Boolean).join(" · "),
		},
			h("span", { className: "dcr-tab-top" },
				h("span", { className: "dcr-tab-v" }, "v" + ver),
				badges),
			h("span", { className: "dcr-tab-sub" }, sub.join(" · ")));
	}));
}

// ── styles ───────────────────────────────────────────────────────────────────
// 颜色全部取 DSH 设计令牌（--dsw-alias-*，宿主按明暗主题翻转，含回退色）。
// 不要 prefers-color-scheme：外观由 DSH 设置决定，而不是操作系统。

const REVIEW_CSS = `
/* 设计令牌：跟随 DSH 明暗主题 */
.dcr-scope {
  --dcr-bg: var(--dsw-alias-bg-base, #ffffff);
  --dcr-bg2: var(--dsw-alias-bg-layer-1, #f7f8fa);
  --dcr-bg3: var(--dsw-alias-bg-layer-2, #f1f3f5);
  --dcr-surface: var(--dsw-alias-bg-layer-1, #ffffff);
  --dcr-fg: var(--dsw-alias-label-primary, #1f2328);
  --dcr-fg2: var(--dsw-alias-label-secondary, #59636e);
  --dcr-fg3: var(--dsw-alias-label-tertiary, #818b96);
  --dcr-fg4: var(--dsw-alias-label-caption, #9ba0a8);
  --dcr-bd: var(--dsw-alias-border-l3, #d0d7de);
  --dcr-bd-soft: var(--dsw-alias-border-l1, #e6eaef);
  --dcr-bd-strong: var(--dsw-alias-border-l4, #c3cbd4);
  --dcr-hover: var(--dsw-alias-interactive-bg-hover, rgba(31,35,40,.055));
  --dcr-active: var(--dsw-alias-interactive-bg-active, rgba(31,35,40,.09));
  --dcr-blue: var(--dsw-alias-state-business-primary, #4176e6);
  --dcr-blue-soft: var(--dsw-alias-state-business-tertiary, #eaf2ff);
  --dcr-green: var(--dsw-alias-state-success-primary, #1a9f4b);
  --dcr-green-soft: var(--dsw-alias-state-success-tertiary, #e7f7ee);
  --dcr-amber: var(--dsw-alias-state-warn-primary, #d98a0b);
  --dcr-amber-soft: var(--dsw-alias-state-warn-tertiary, #fdf4e5);
  --dcr-red: var(--dsw-alias-state-error-primary, #d93025);
  --dcr-red-soft: color-mix(in srgb, var(--dcr-red) 10%, transparent);
  --dcr-blue-ring: color-mix(in srgb, var(--dcr-blue) 18%, transparent);
  --dcr-accent-fill: var(--dc-accent-fill, var(--dsw-alias-button-primary-fill, #4d6bfe));
  --dcr-accent-fg: var(--dc-accent-fg, var(--dsw-alias-label-primary-inverted, #ffffff));
  --dcr-radius: var(--dsw-radius-md, 8px);
  --dcr-shadow: var(--dc-shadow, 0 1px 2px rgba(16,24,40,.04), 0 10px 30px rgba(16,24,40,.06));
  --dcr-font: var(--dsw-font-family, var(--font-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif));
  --dcr-mono: var(--ds-font-family-code, "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", monospace);
  color: var(--dcr-fg);
  font-family: var(--dcr-font);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
.dcr-scope, .dcr-scope * { box-sizing: border-box; }
.dcr-scope ::-webkit-scrollbar { width: 10px; height: 10px; }
.dcr-scope ::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l1, #c9ced6);
  border: 2px solid transparent; border-radius: 8px; background-clip: content-box; }
.dcr-scope ::-webkit-scrollbar-thumb:hover { background-color: var(--dsw-alias-scrollbar-hover-l1, #b3bac4); }
.dcr-icon { flex: none; display: inline-block; vertical-align: -2px; }

/* 按钮 */
.dcr-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 32px; padding: 0 14px; border-radius: 8px; border: 1px solid transparent;
  font-family: inherit; font-size: 13px; font-weight: 500; line-height: 1;
  color: var(--dcr-fg); background: transparent; cursor: pointer; white-space: nowrap;
  transition: background .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease;
}
.dcr-btn:disabled { opacity: .45; cursor: default; }
.dcr-btn-primary { background: var(--dcr-accent-fill); border-color: var(--dcr-accent-fill); color: var(--dcr-accent-fg); }
.dcr-btn-primary:hover:not(:disabled) { filter: brightness(1.07); }
.dcr-btn-primary:active:not(:disabled) { transform: translateY(1px); }
.dcr-btn-ghost { border-color: var(--dcr-bd); background: var(--dcr-surface); color: var(--dcr-fg2); }
.dcr-btn-ghost:hover:not(:disabled) { border-color: var(--dcr-bd-strong); color: var(--dcr-fg); background: var(--dcr-hover); }
.dcr-btn-soft { background: var(--dcr-blue-soft); color: var(--dcr-blue); }
.dcr-btn-soft:hover:not(:disabled) { filter: brightness(.98); }
.dcr-btn-link { height: auto; padding: 0; border: none; background: none; color: var(--dcr-blue); font-size: 12px; gap: 3px; }
.dcr-btn-link:hover:not(:disabled) { text-decoration: underline; }
a.dcr-btn { text-decoration: none; }
.dcr-scope :where(button, a, textarea):focus-visible { outline: 2px solid var(--dcr-blue); outline-offset: 2px; }

/* 标签 / 徽标 */
.dcr-tag { display: inline-flex; align-items: center; height: 17px; padding: 0 6px; border-radius: 5px;
  font-size: 10.5px; font-weight: 600; letter-spacing: .01em; white-space: nowrap; }
.dcr-tag-green { color: var(--dcr-green); background: var(--dcr-green-soft); }
.dcr-tag-blue { color: var(--dcr-blue); background: var(--dcr-blue-soft); }
.dcr-tag-amber { color: var(--dcr-amber); background: var(--dcr-amber-soft); }
.dcr-tag-red { color: var(--dcr-red); background: var(--dcr-red-soft); }
.dcr-tag-dim { color: var(--dcr-fg3); background: var(--dcr-bg3); }

/* 共用头部 / 元信息行 */
.dcr-view-head { flex: none; padding: 4px 2px 10px; }
.dcr-view-title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dcr-view-title { margin: 0; font-size: 18px; font-weight: 650; line-height: 1.4; letter-spacing: -.01em; color: var(--dcr-fg); }
.dcr-head-badges { display: inline-flex; align-items: center; gap: 6px; }
.dcr-meta-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 14px; margin-top: 8px;
  font-size: 12px; color: var(--dcr-fg3); }
.dcr-meta-item { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.dcr-meta-item .dcr-icon { color: var(--dcr-fg4); }

/* 版本 tabs */
.dcr-tabs { display: flex; align-items: stretch; gap: 8px; overflow-x: auto; padding: 2px 2px 12px;
  scrollbar-width: thin; flex: none; position: sticky; top: 0; z-index: 3;
  background: var(--dcr-bg); }
.dcr-tabs::-webkit-scrollbar { height: 6px; }
.dcr-tab { flex: none; display: flex; flex-direction: column; align-items: flex-start; gap: 3px;
  min-width: 96px; max-width: 220px; padding: 7px 11px; border-radius: 9px;
  border: 1px solid var(--dcr-bd-soft); background: var(--dcr-surface); color: var(--dcr-fg2);
  font-family: inherit; text-align: left; cursor: pointer; transition: border-color .15s, background .15s, color .15s; }
.dcr-tab:hover { border-color: var(--dcr-bd-strong); background: var(--dcr-hover); }
.dcr-tab.dcr-is-active { border-color: color-mix(in srgb, var(--dcr-blue) 32%, transparent);
  background: var(--dcr-blue-soft); color: var(--dcr-fg); box-shadow: 0 1px 2px rgba(16,24,40,.05); }
.dcr-tab-top { display: flex; align-items: center; gap: 5px; }
.dcr-tab-v { font-size: 13px; font-weight: 650; color: var(--dcr-fg); font-variant-numeric: tabular-nums; }
.dcr-tab.dcr-is-active .dcr-tab-v { color: var(--dcr-blue); }
.dcr-tab-sub { display: block; max-width: 190px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-size: 10.5px; color: var(--dcr-fg3); font-variant-numeric: tabular-nums; }

/* 滚动内容区 */
.dcr-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.dcr-outline, .dcr-doc { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dcr-bg); }

/* 大纲小节卡片 */
.dcr-sections { padding: 4px 2px 28px; display: flex; flex-direction: column; gap: 12px; }
.dcr-sec { border: 1px solid var(--dcr-bd-soft); border-radius: 12px; background: var(--dcr-surface);
  padding: 16px 18px; transition: border-color .18s ease, box-shadow .18s ease; }
.dcr-sec:hover { border-color: var(--dcr-bd); box-shadow: 0 2px 10px rgba(16,24,40,.05); }
.dcr-sec-head { display: flex; align-items: flex-start; gap: 10px; }
.dcr-sec-num { flex: none; display: inline-flex; align-items: center; justify-content: center;
  min-width: 24px; height: 24px; padding: 0 6px; border-radius: 7px;
  background: var(--dcr-blue-soft); color: var(--dcr-blue);
  font-size: 11.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
.dcr-sec-title { margin: 0; flex: 1 1 auto; min-width: 0; font-size: 15px; font-weight: 600;
  line-height: 1.45; color: var(--dcr-fg); overflow-wrap: anywhere; }
.dcr-sec-points { margin: 10px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
.dcr-sec-points li { position: relative; padding-left: 15px; font-size: 13px; line-height: 1.65; color: var(--dcr-fg2); overflow-wrap: anywhere; }
.dcr-sec-points li::before { content: ""; position: absolute; left: 3px; top: .72em; width: 4px; height: 4px;
  border-radius: 50%; background: var(--dcr-fg4); }
.dcr-sec-nopoints { margin: 10px 0 0; font-size: 12.5px; color: var(--dcr-fg4); }
.dcr-sec-notes { display: flex; gap: 8px; margin-top: 12px; padding: 8px 10px;
  border-left: 3px solid var(--dcr-amber); border-radius: 6px;
  background: var(--dcr-amber-soft); font-size: 12px; line-height: 1.6; color: var(--dcr-fg2); }
.dcr-sec-notes-label { flex: none; color: var(--dcr-amber); font-weight: 600; }

/* 底部操作条 */
.dcr-actions { flex: none; position: sticky; bottom: 0; z-index: 2; padding: 12px 14px;
  border-top: 1px solid var(--dcr-bd-soft); background: var(--dcr-surface);
  display: flex; flex-direction: column; gap: 10px; }
.dcr-actions-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dcr-actions-gap { flex: 1 1 auto; }
.dcr-actions-hint { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--dcr-fg3); }
.dcr-actions-note { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 11.5px; color: var(--dcr-fg4); }
.dcr-actions-warn { font-size: 11.5px; line-height: 1.5; color: var(--dcr-amber); }
.dcr-meta-link { border: none; background: none; padding: 0; font-family: inherit; font-size: 12px;
  color: var(--dcr-blue); cursor: pointer; }
.dcr-meta-link:hover:not(:disabled) { text-decoration: underline; }
.dcr-meta-link:disabled { color: var(--dcr-fg3); cursor: default; }

/* 进度区 */
.dcr-busy-box { border: 1px solid var(--dcr-bd-soft); border-radius: 9px; background: var(--dcr-bg2);
  padding: 10px 12px; }
.dcr-busy-box.dcr-is-compact { padding: 8px 10px; }
.dcr-busy-line { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--dcr-fg2); }
.dcr-busy-msg { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcr-busy-pct { flex: none; font-size: 11.5px; color: var(--dcr-fg3); font-variant-numeric: tabular-nums; }
.dcr-busy-track { height: 4px; margin-top: 8px; border-radius: 2px; background: var(--dcr-bg3); overflow: hidden; }
.dcr-busy-track > i { display: block; height: 100%; border-radius: 2px; background: var(--dcr-blue);
  transition: width .35s ease; }
.dcr-spinner { flex: none; width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--dcr-blue) 22%, transparent); border-top-color: var(--dcr-blue);
  animation: dcr-spin .8s linear infinite; }
@keyframes dcr-spin { to { transform: rotate(360deg); } }

/* 空态 */
.dcr-empty { display: flex; flex-direction: column; align-items: center; text-align: center;
  padding: 48px 24px; color: var(--dcr-fg3); }
.dcr-empty-icon { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px;
  margin-bottom: 12px; border-radius: 12px; background: var(--dcr-blue-soft); color: var(--dcr-blue); }
.dcr-empty-title { font-size: 14px; font-weight: 600; color: var(--dcr-fg2); }
.dcr-empty-hint { max-width: 420px; margin: 6px 0 0; font-size: 12.5px; line-height: 1.7; color: var(--dcr-fg3); }
.dcr-empty-action { margin-top: 16px; }
.dcr-empty-wrap { flex: 1 1 auto; min-height: 420px; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 12px; padding: 24px; overflow-y: auto; }

/* 警告条 */
.dcr-warnbar { display: flex; gap: 8px; margin-top: 10px; padding: 8px 11px;
  border: 1px solid color-mix(in srgb, var(--dcr-amber) 38%, transparent); border-radius: 8px;
  background: var(--dcr-amber-soft); font-size: 12px; line-height: 1.6; color: var(--dcr-fg2); }
.dcr-warn-icon { flex: none; color: var(--dcr-amber); margin-top: 1px; }
.dcr-warn-list { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dcr-warn-item { overflow-wrap: anywhere; }

/* 卡片（自检 / 参考资料） */
.dcr-doc-stack { width: 100%; padding: 0 0 28px; display: flex; flex-direction: column; gap: 14px; }
.dcr-card { border: 1px solid var(--dcr-bd-soft); border-radius: 12px; background: var(--dcr-surface); overflow: hidden; }
.dcr-card-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 16px;
  border: none; border-bottom: 1px solid transparent; background: transparent; color: var(--dcr-fg);
  font-family: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.dcr-card-head:hover { background: var(--dcr-hover); }
.dcr-card-title { display: inline-flex; align-items: center; gap: 7px; font-weight: 600; color: var(--dcr-fg); }
.dcr-card-title .dcr-icon { color: var(--dcr-fg3); }
.dcr-count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px;
  padding: 0 5px; border-radius: 9px; background: var(--dcr-bg3); color: var(--dcr-fg3);
  font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dcr-collapse { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--dcr-fg3); }
.dcr-chevron { transition: transform .18s ease; }
.dcr-chevron.dcr-is-open { transform: rotate(180deg); }
.dcr-card-body { padding: 4px 16px 14px; border-top: 1px solid var(--dcr-bd-soft); }

/* 红线自检摘要 */
.dcr-checks { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px; }
.dcr-check { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 8px;
  border: 1px solid transparent; font-size: 12px; font-weight: 500; }
.dcr-check b { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
.dcr-check.dcr-is-pass { color: var(--dcr-green); background: var(--dcr-green-soft); }
.dcr-check.dcr-is-risk { color: var(--dcr-red); background: var(--dcr-red-soft); }
.dcr-check.dcr-is-unknown { color: var(--dcr-amber); background: var(--dcr-amber-soft); }
.dcr-check.dcr-is-zero { color: var(--dcr-fg4); background: var(--dcr-bg3); }
.dcr-valid-list { margin: 0; padding: 2px 16px 14px; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.dcr-valid-item { display: flex; align-items: flex-start; gap: 9px; padding: 8px 0;
  border-top: 1px solid var(--dcr-bd-soft); }
.dcr-valid-dot { flex: none; width: 7px; height: 7px; margin-top: 6px; border-radius: 50%; }
.dcr-valid-item.dcr-is-pass .dcr-valid-dot { background: var(--dcr-green); }
.dcr-valid-item.dcr-is-risk .dcr-valid-dot { background: var(--dcr-red); }
.dcr-valid-item.dcr-is-unknown .dcr-valid-dot { background: var(--dcr-amber); }
.dcr-valid-body { flex: 1 1 auto; min-width: 0; }
.dcr-valid-label { font-size: 12.5px; line-height: 1.55; color: var(--dcr-fg); overflow-wrap: anywhere; }
.dcr-valid-note { margin-top: 2px; font-size: 11.5px; line-height: 1.6; color: var(--dcr-fg3); overflow-wrap: anywhere; }
.dcr-valid-kind { flex: none; font-size: 10.5px; color: var(--dcr-fg4); padding-top: 2px; }
.dcr-valid-empty { padding: 0 16px 14px; font-size: 12px; color: var(--dcr-fg4); }

/* 参考资料 */
.dcr-src-list { margin: 0; padding: 4px 16px 14px; list-style: none; display: flex; flex-direction: column; gap: 2px; }
.dcr-src-item { display: flex; align-items: flex-start; gap: 9px; padding: 8px 0; border-top: 1px solid var(--dcr-bd-soft); }
.dcr-src-n { flex: none; min-width: 22px; padding-top: 1px; color: var(--dcr-fg4);
  font-size: 11px; font-variant-numeric: tabular-nums; }
.dcr-src-body { flex: 1 1 auto; min-width: 0; }
.dcr-src-title { font-size: 12.5px; font-weight: 500; line-height: 1.55; color: var(--dcr-fg); overflow-wrap: anywhere; }
.dcr-src-url { display: inline-block; max-width: 100%; margin-top: 2px; font-size: 11.5px; line-height: 1.55;
  color: var(--dcr-blue); text-decoration: none; overflow-wrap: anywhere; }
.dcr-src-url:hover { text-decoration: underline; }

/* 成文纸张 */
.dcr-doc-head { flex: none; padding: 10px 2px 2px; }
.dcr-doc-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.dcr-downloads { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dcr-paper { margin: 0 0 16px; padding: 40px 48px 52px; border: 1px solid var(--dcr-bd-soft);
  border-radius: 14px; background: var(--dcr-surface); box-shadow: var(--dcr-shadow); }
.dcr-paper-loading { display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 64px 20px; color: var(--dcr-fg3); font-size: 12.5px; }

/* ── Markdown 文档排版 ───────────────────────────────────────────────────── */
.dcr-md { color: var(--dcr-fg); font-size: 14.5px; line-height: 1.85; overflow-wrap: anywhere; }
.dcr-md .dcr-md-h { margin: 1.35em 0 .55em; color: var(--dcr-fg); font-weight: 650; line-height: 1.4; letter-spacing: -.005em; }
.dcr-md > :first-child { margin-top: 0; }
.dcr-md .dcr-md-h1 { font-size: 25px; margin-top: 0; padding-bottom: .35em; border-bottom: 1px solid var(--dcr-bd-soft); }
.dcr-md .dcr-md-h2 { font-size: 19.5px; padding-bottom: .28em; border-bottom: 1px solid var(--dcr-bd-soft); }
.dcr-md .dcr-md-h3 { font-size: 16.5px; }
.dcr-md .dcr-md-h4 { font-size: 15px; }
.dcr-md .dcr-md-h5 { font-size: 14px; color: var(--dcr-fg2); }
.dcr-md .dcr-md-h6 { font-size: 13px; color: var(--dcr-fg3); text-transform: uppercase; letter-spacing: .04em; }
.dcr-md .dcr-md-p { margin: 0 0 .95em; }
.dcr-md .dcr-md-ul, .dcr-md .dcr-md-ol { margin: .35em 0 .95em; padding-left: 1.6em; }
.dcr-md .dcr-md-ul { list-style: disc; }
.dcr-md .dcr-md-ol { list-style: decimal; }
.dcr-md .dcr-md-ul .dcr-md-ul { list-style: circle; margin-bottom: .3em; }
.dcr-md .dcr-md-ul .dcr-md-ol, .dcr-md .dcr-md-ol .dcr-md-ul, .dcr-md .dcr-md-ol .dcr-md-ol { margin-bottom: .3em; }
.dcr-md .dcr-md-li { margin: .22em 0; padding-left: .15em; }
.dcr-md .dcr-md-li-text { display: inline; }
.dcr-md .dcr-md-quote { margin: .8em 0 1em; padding: .5em .95em; border-left: 3px solid var(--dcr-bd-strong);
  border-radius: 0 8px 8px 0; background: var(--dcr-bg2); color: var(--dcr-fg2); }
.dcr-md .dcr-md-quote > :last-child { margin-bottom: 0; }
.dcr-md .dcr-md-hr { margin: 1.8em 0; border: none; border-top: 1px solid var(--dcr-bd-soft); }
.dcr-md .dcr-md-code { padding: 2px 5px; border-radius: 5px; background: var(--dsw-alias-markdown-inline-code, var(--dcr-bg3));
  color: var(--dcr-fg); font-family: var(--dcr-mono); font-size: .88em; }
.dcr-md .dcr-md-codeblock { margin: .9em 0 1.1em; border: 1px solid var(--dcr-bd-soft); border-radius: 10px;
  overflow: hidden; background: var(--dsw-alias-markdown-code-block, var(--dcr-bg2)); }
.dcr-md .dcr-md-codehead { display: flex; align-items: center; gap: 6px; padding: 6px 12px;
  border-bottom: 1px solid var(--dcr-bd-soft); background: var(--dsw-alias-markdown-code-block-banner, var(--dcr-bg3)); }
.dcr-md .dcr-md-codelang { font-size: 10.5px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase;
  color: var(--dcr-fg3); font-family: var(--dcr-mono); }
.dcr-md .dcr-md-pre { margin: 0; padding: 12px 14px; overflow-x: auto; }
.dcr-md .dcr-md-pre code { display: block; font-family: var(--dcr-mono); font-size: 12.5px; line-height: 1.65;
  color: var(--dcr-fg2); white-space: pre; tab-size: 2; }
.dcr-md .dcr-md-tablewrap { margin: .9em 0 1.1em; overflow-x: auto; border: 1px solid var(--dcr-bd-soft); border-radius: 9px; }
.dcr-md .dcr-md-table { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 1.6; }
.dcr-md .dcr-md-table th, .dcr-md .dcr-md-table td { padding: 8px 12px; border-bottom: 1px solid var(--dcr-bd-soft);
  text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.dcr-md .dcr-md-table th { background: var(--dcr-bg2); font-weight: 600; color: var(--dcr-fg); white-space: nowrap; }
.dcr-md .dcr-md-table tbody tr:last-child td { border-bottom: none; }
.dcr-md .dcr-md-table tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--dcr-fg) 2.5%, transparent); }
.dcr-md .dcr-md-link { color: var(--dcr-blue); text-decoration: none; }
.dcr-md .dcr-md-link:hover { text-decoration: underline; }
.dcr-md .dcr-md-link-off { color: var(--dcr-fg3); }
.dcr-md .dcr-md-pagebreak { display: flex; align-items: center; gap: 10px; margin: 2em 0;
  color: var(--dcr-fg4); font-size: 10.5px; letter-spacing: .08em; }
.dcr-md .dcr-md-pagebreak::before, .dcr-md .dcr-md-pagebreak::after { content: ""; flex: 1 1 auto;
  border-top: 1px dashed var(--dcr-bd); }
.dcr-md.dcr-md-empty { display: flex; flex-direction: column; align-items: center; justify-content: center;
  min-height: 160px; color: var(--dcr-fg4); font-size: 13px; text-align: center; }
.dcr-md.dcr-md-empty .dcr-md-empty-icon { margin-bottom: 8px; color: var(--dcr-fg4); }

/* ── AI 调整对话 ─────────────────────────────────────────────────────────── */
.dcr-chat { display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--dcr-bg2); }
.dcr-chat-head { flex: none; padding: 14px 16px 10px; border-bottom: 1px solid var(--dcr-bd-soft); }
.dcr-chat-titlewrap { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.dcr-chat-title { display: inline-flex; align-items: center; gap: 6px; margin: 0;
  font-size: 13.5px; font-weight: 650; color: var(--dcr-fg); }
.dcr-chat-title .dcr-icon { color: var(--dcr-blue); }
.dcr-pill { display: inline-flex; align-items: center; height: 19px; padding: 0 7px; border-radius: 999px;
  font-size: 10.5px; font-weight: 500; white-space: nowrap; }
.dcr-pill-blue { color: var(--dcr-blue); background: var(--dcr-blue-soft); }
.dcr-pill-dim { color: var(--dcr-fg3); background: var(--dcr-bg3); }
.dcr-chat-sub { margin-top: 5px; font-size: 11.5px; color: var(--dcr-fg3); }
.dcr-ctx-wrap { flex: none; padding: 8px 14px 0; }
.dcr-chat-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 12px; padding: 14px 14px 8px; scroll-behavior: smooth; }
.dcr-msg { display: flex; flex-direction: column; max-width: 100%; }
.dcr-msg.dcr-is-user { align-items: flex-end; }
.dcr-msg.dcr-is-ai { align-items: flex-start; }
.dcr-msg-col { display: flex; flex-direction: column; max-width: 88%; }
.dcr-msg.dcr-is-user .dcr-msg-col { align-items: flex-end; }
.dcr-msg-tags { display: flex; align-items: center; gap: 5px; margin-bottom: 4px; }
.dcr-bubble { padding: 9px 12px; border-radius: 12px; font-size: 12.8px; line-height: 1.65;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.dcr-msg.dcr-is-user .dcr-bubble { background: var(--dcr-accent-fill); color: var(--dcr-accent-fg);
  border-bottom-right-radius: 4px; }
.dcr-msg.dcr-is-ai .dcr-bubble { background: var(--dcr-surface); color: var(--dcr-fg);
  border: 1px solid var(--dcr-bd-soft); border-bottom-left-radius: 4px; }
.dcr-msg.dcr-is-error .dcr-bubble { background: var(--dcr-red-soft); color: var(--dcr-fg);
  border: 1px solid color-mix(in srgb, var(--dcr-red) 32%, transparent); }
.dcr-msg-meta { margin-top: 4px; font-size: 10.5px; color: var(--dcr-fg4); font-variant-numeric: tabular-nums; }
.dcr-act-chip { display: inline-flex; align-items: center; gap: 4px; margin-top: 6px; padding: 3px 9px;
  border-radius: 999px; border: 1px solid color-mix(in srgb, var(--dcr-blue) 30%, transparent);
  background: var(--dcr-blue-soft); color: var(--dcr-blue); font-size: 11px; font-weight: 500;
  cursor: default; user-select: none; }
.dcr-ctx-bar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border: 1px dashed var(--dcr-bd);
  border-radius: 8px; background: var(--dcr-surface); font-size: 11.5px; color: var(--dcr-fg3); }
.dcr-ctx-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcr-chat-empty { margin: auto 0; padding: 28px 18px; display: flex; flex-direction: column;
  align-items: center; text-align: center; color: var(--dcr-fg3); }
.dcr-chat-empty-icon { display: flex; align-items: center; justify-content: center; width: 40px; height: 40px;
  margin-bottom: 10px; border-radius: 11px; background: var(--dcr-blue-soft); color: var(--dcr-blue); }
.dcr-chat-empty-title { font-size: 13px; font-weight: 600; color: var(--dcr-fg2); }
.dcr-chat-empty p { max-width: 260px; margin: 6px 0 0; font-size: 12px; line-height: 1.7; color: var(--dcr-fg3); }
.dcr-chat-foot { flex: none; padding: 8px 14px 12px; display: flex; flex-direction: column; gap: 8px; }
.dcr-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dcr-chip { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 999px;
  border: 1px solid var(--dcr-bd); background: var(--dcr-surface); color: var(--dcr-fg2);
  font-family: inherit; font-size: 11.5px; white-space: nowrap; cursor: pointer;
  transition: border-color .15s, color .15s, background .15s; }
.dcr-chip:hover:not(:disabled) { border-color: var(--dcr-blue); color: var(--dcr-blue); background: var(--dcr-blue-soft); }
.dcr-chip:disabled { opacity: .5; cursor: default; }
.dcr-composer { border: 1px solid var(--dcr-bd); border-radius: 12px; background: var(--dcr-surface);
  padding: 8px 10px 7px; transition: border-color .15s, box-shadow .15s; }
.dcr-composer:focus-within { border-color: var(--dcr-blue); box-shadow: 0 0 0 3px var(--dcr-blue-ring); }
.dcr-composer.dcr-is-busy { background: var(--dcr-bg2); }
.dcr-textarea { display: block; width: 100%; min-height: 44px; max-height: 160px; padding: 0;
  border: none; background: transparent; color: var(--dcr-fg); resize: none; overflow-y: auto;
  font-family: inherit; font-size: 13px; line-height: 1.6; }
.dcr-textarea:focus-visible { outline: none; }
.dcr-textarea::placeholder { color: var(--dcr-fg4); }
.dcr-textarea:disabled { cursor: default; }
.dcr-composer-bar { display: flex; align-items: center; gap: 8px; margin-top: 5px; }
.dcr-hint { flex: 1 1 auto; min-width: 0; font-size: 10.5px; color: var(--dcr-fg4);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dcr-send { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 11px;
  border: none; border-radius: 8px; background: var(--dcr-accent-fill); color: var(--dcr-accent-fg);
  font-family: inherit; font-size: 12px; font-weight: 500; cursor: pointer;
  transition: filter .15s, opacity .15s; }
.dcr-send:hover:not(:disabled) { filter: brightness(1.07); }
.dcr-send:disabled { opacity: .42; cursor: default; }

/* 窄屏：两栏堆叠由 App 的 .dc-workspace/.dc-dock 负责；这里只调纸张与操作条 */
@media (max-width: 1000px) {
  .dcr-paper { padding: 30px 28px 40px; }
  .dcr-actions { padding: 10px 10px; }
  .dcr-outline, .dcr-doc { height: auto; }
  .dcr-actions { position: static; }
}
@media (max-width: 720px) {
  .dcr-view-title { font-size: 16px; }
  .dcr-md { font-size: 14px; line-height: 1.8; }
  .dcr-paper { padding: 22px 18px 30px; border-radius: 10px; }
  .dcr-md .dcr-md-h1 { font-size: 21px; }
  .dcr-md .dcr-md-h2 { font-size: 17.5px; }
  .dcr-md .dcr-md-tablewrap { border-radius: 8px; }
  .dcr-actions-row { gap: 8px; }
  .dcr-actions-row .dcr-btn { flex: 1 1 auto; }
  .dcr-actions-gap { display: none; }
  .dcr-actions-hint { flex-basis: 100%; }
  .dcr-msg-col { max-width: 94%; }
}
@media (prefers-reduced-motion: reduce) {
  .dcr-scope *, .dcr-spinner { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
`;

// ── Markdown：块级解析（MarkdownView 用 useMemo 缓存结果） ──────────────────
// 纯 React 节点输出，全程不使用 dangerouslySetInnerHTML；链接只放行 http(s)。

const R_MD_HEADING = /^(#{1,6})[ \t]+(.*)$/;
const R_MD_HR = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const R_MD_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const R_MD_FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;
const R_MD_LI = /^([ \t]*)([-*+]|\d{1,3}[.)])[ \t]+(.*)$/;
const R_MD_QUOTE = /^[ \t]{0,3}>[ \t]?(.*)$/;
const R_MD_PAGEBREAK = /^[ \t]{0,3}<!--\s*pagebreak\s*-->[ \t]*$/i;
const R_MD_TABLE_SEP = /^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

function RindentOf(line) {
	let n = 0;
	for (let i = 0; i < line.length; i++) {
		const ch = line.charAt(i);
		if (ch === " ") n += 1;
		else if (ch === "\t") n += 4;
		else break;
	}
	return n;
}

function RnextNonBlank(lines, from) {
	for (let i = from; i < lines.length; i++) if (!/^[ \t]*$/.test(lines[i])) return i;
	return -1;
}

function RsplitTableRow(line) {
	let s = String(line || "").trim();
	if (s.charAt(0) === "|") s = s.slice(1);
	if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
	const cells = [];
	let buf = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s.charAt(i);
		if (ch === "\\" && s.charAt(i + 1) === "|") {
			buf += "|";
			i++;
			continue;
		}
		if (ch === "|") {
			cells.push(buf.trim());
			buf = "";
			continue;
		}
		buf += ch;
	}
	cells.push(buf.trim());
	return cells;
}

function RtableAlign(cell) {
	const c = String(cell || "").trim();
	if (c === "") return "";
	const left = c.charAt(0) === ":";
	const right = c.charAt(c.length - 1) === ":";
	if (left && right) return "center";
	if (right) return "right";
	if (left) return "left";
	return "";
}

function RstartsBlock(lines, i) {
	const line = lines[i];
	if (line === undefined) return true;
	if (R_MD_FENCE.test(line) || R_MD_HEADING.test(line) || R_MD_HR.test(line) ||
		R_MD_QUOTE.test(line) || R_MD_PAGEBREAK.test(line) || R_MD_LI.test(line)) return true;
	if (line.indexOf("|") >= 0 && i + 1 < lines.length && lines[i + 1].indexOf("|") >= 0 &&
		R_MD_TABLE_SEP.test(lines[i + 1])) return true;
	return false;
}

function RparseList(lines, start) {
	const first = R_MD_LI.exec(lines[start]);
	const baseIndent = RindentOf(lines[start]);
	const ordered = /^\d/.test(first[2]);
	const startNum = ordered ? parseInt(first[2], 10) : 1;
	const items = [];
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		if (/^[ \t]*$/.test(line)) {
			const nxt = RnextNonBlank(lines, i + 1);
			if (nxt < 0) break;
			if (RindentOf(lines[nxt]) > baseIndent) {
				i = nxt;
				continue;
			}
			break;
		}
		const ind = RindentOf(line);
		const m = R_MD_LI.exec(line);
		if (m === null || ind > baseIndent + 1) break;
		const isOrdered = /^\d/.test(m[2]);
		if (isOrdered !== ordered) break;
		const item = { text: m[3], children: [] };
		items.push(item);
		i++;
		while (i < lines.length) {
			const l2 = lines[i];
			if (/^[ \t]*$/.test(l2)) {
				const nxt = RnextNonBlank(lines, i + 1);
				if (nxt < 0) break;
				if (RindentOf(lines[nxt]) > baseIndent + 1) {
					i = nxt;
					continue;
				}
				break;
			}
			const lind = RindentOf(l2);
			const nm = R_MD_LI.exec(l2);
			if (nm !== null && lind >= baseIndent + 2) {
				const nested = RparseList(lines, i);
				if (nested.block.items.length > 0) item.children.push(nested.block);
				i = nested.next;
				continue;
			}
			if (lind > baseIndent && nm === null) {
				item.text += "\n" + l2.replace(/^[ \t]+/, "");
				i++;
				continue;
			}
			break;
		}
	}
	return { block: { type: "list", ordered, start: startNum, items }, next: i };
}

function RparseMarkdown(source, depth) {
	const blocks = [];
	if (typeof source !== "string" || source.trim() === "") return blocks;
	const level = typeof depth === "number" ? depth : 0;
	const lines = source.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (/^[ \t]*$/.test(line)) {
			i++;
			continue;
		}
		// 代码围栏（``` 或 ~~~，可带语言标识）
		const fence = R_MD_FENCE.exec(line);
		if (fence !== null) {
			const fenceChar = fence[1].charAt(0);
			const fenceLen = fence[1].length;
			const info = fence[2] ? fence[2].trim() : "";
			const lang = info === "" ? "" : info.split(/[ \t]+/)[0];
			const buf = [];
			i++;
			while (i < lines.length) {
				const close = R_MD_FENCE_CLOSE.exec(lines[i]);
				if (close !== null && close[1].charAt(0) === fenceChar && close[1].length >= fenceLen) {
					i++;
					break;
				}
				buf.push(lines[i]);
				i++;
			}
			blocks.push({ type: "code", lang, text: buf.join("\n") });
			continue;
		}
		// 分页标记（成文导出用的 <!-- pagebreak -->）
		if (R_MD_PAGEBREAK.test(line)) {
			blocks.push({ type: "pagebreak" });
			i++;
			continue;
		}
		// 标题
		const heading = R_MD_HEADING.exec(line);
		if (heading !== null) {
			const text = heading[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
			blocks.push({ type: "heading", level: heading[1].length, text });
			i++;
			continue;
		}
		// 分隔线
		if (R_MD_HR.test(line)) {
			blocks.push({ type: "hr" });
			i++;
			continue;
		}
		// 引用（可多行，内部递归解析）
		if (R_MD_QUOTE.test(line)) {
			const inner = [];
			while (i < lines.length) {
				const q = R_MD_QUOTE.exec(lines[i]);
				if (q === null) break;
				inner.push(q[1]);
				i++;
			}
			blocks.push({
				type: "quote",
				children: level < 4
					? RparseMarkdown(inner.join("\n"), level + 1)
					: [{ type: "paragraph", text: inner.join("\n") }],
			});
			continue;
		}
		// GFM 表格（表头行 + 分隔行）
		if (line.indexOf("|") >= 0 && i + 1 < lines.length && lines[i + 1].indexOf("|") >= 0 &&
			R_MD_TABLE_SEP.test(lines[i + 1])) {
			const header = RsplitTableRow(line);
			const sepCells = RsplitTableRow(lines[i + 1]);
			const aligns = header.map((_, ci) => RtableAlign(sepCells[ci] || ""));
			const rows = [];
			i += 2;
			while (i < lines.length) {
				const rowLine = lines[i];
				if (/^[ \t]*$/.test(rowLine) || rowLine.indexOf("|") < 0) break;
				if (RstartsBlock(lines, i)) break;
				rows.push(RsplitTableRow(rowLine));
				i++;
			}
			blocks.push({ type: "table", header, aligns, rows });
			continue;
		}
		// 列表
		if (R_MD_LI.test(line)) {
			const parsed = RparseList(lines, i);
			blocks.push(parsed.block);
			i = parsed.next;
			continue;
		}
		// 段落（软换行保留为 <br>，贴合中文文档习惯）
		const buf = [line.replace(/^[ \t]+/, "")];
		i++;
		while (i < lines.length && !/^[ \t]*$/.test(lines[i]) && !RstartsBlock(lines, i)) {
			buf.push(lines[i].replace(/^[ \t]+/, ""));
			i++;
		}
		blocks.push({ type: "paragraph", text: buf.join("\n") });
	}
	return blocks;
}

// ── Markdown：行内 token ────────────────────────────────────────────────────

function RinlineTokens(text, depth) {
	const out = [];
	if (typeof text !== "string" || text === "") return out;
	const level = typeof depth === "number" ? depth : 0;
	let buf = "";
	let i = 0;
	const flush = () => {
		if (buf !== "") {
			out.push({ t: "text", v: buf });
			buf = "";
		}
	};
	while (i < text.length) {
		const ch = text.charAt(i);
		// 反斜杠转义
		if (ch === "\\" && i + 1 < text.length) {
			buf += text.charAt(i + 1);
			i += 2;
			continue;
		}
		// 软换行
		if (ch === "\n") {
			flush();
			out.push({ t: "br" });
			i++;
			continue;
		}
		// 行内代码
		if (ch === "`") {
			let n = 1;
			while (text.charAt(i + n) === "`") n++;
			const fence = "`".repeat(n);
			const end = text.indexOf(fence, i + n);
			if (end >= i + n) {
				flush();
				out.push({ t: "code", v: text.slice(i + n, end).replace(/\n/g, " ") });
				i = end + n;
				continue;
			}
			buf += ch;
			i++;
			continue;
		}
		// 粗体 / 斜体 / 删除线
		if (ch === "*" || ch === "_" || ch === "~") {
			const dbl = text.charAt(i + 1) === ch;
			if (dbl) {
				const marker = ch + ch;
				const end = text.indexOf(marker, i + 2);
				if (end > i + 2) {
					const inner = text.slice(i + 2, end);
					flush();
					out.push({
						t: ch === "~" ? "del" : "strong",
						c: level < 6 ? RinlineTokens(inner, level + 1) : [{ t: "text", v: inner }],
					});
					i = end + 2;
					continue;
				}
				buf += ch;
				i++;
				continue;
			}
			if (ch === "~") {
				buf += ch;
				i++;
				continue;
			}
			// 单字符强调：前后做边界判断，避免误伤 snake_case / 路径
			const prev = i > 0 ? text.charAt(i - 1) : "";
			const nextCh = text.charAt(i + 1);
			const boundary = nextCh !== "" && !/\s/.test(nextCh) &&
				(ch === "*" || !/[A-Za-z0-9]/.test(prev));
			let end = -1;
			if (boundary) {
				for (let j = i + 1; j < text.length; j++) {
					const cj = text.charAt(j);
					if (cj === "\n") break;
					if (cj === ch) {
						const prevJ = text.charAt(j - 1);
						const afterJ = text.charAt(j + 1);
						if (!/\s/.test(prevJ) && (ch === "*" || afterJ === "" || !/[A-Za-z0-9]/.test(afterJ))) {
							end = j;
							break;
						}
					}
				}
			}
			if (end > i + 1) {
				flush();
				out.push({ t: "em", c: RinlineTokens(text.slice(i + 1, end), level + 1) });
				i = end + 1;
				continue;
			}
			buf += ch;
			i++;
			continue;
		}
		// [文本](url)
		if (ch === "[") {
			const close = text.indexOf("]", i + 1);
			if (close > i && text.charAt(close + 1) === "(") {
				const end = text.indexOf(")", close + 2);
				if (end > close) {
					flush();
					out.push({
						t: "link",
						label: text.slice(i + 1, close),
						url: text.slice(close + 2, end).trim(),
					});
					i = end + 1;
					continue;
				}
			}
			buf += ch;
			i++;
			continue;
		}
		// 裸 http(s) 链接
		if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(text.slice(i, i + 9))) {
			const prev = i > 0 ? text.charAt(i - 1) : "";
			if (!/[A-Za-z0-9]/.test(prev)) {
				const m = /^https?:\/\/[^\s<>"'`）】」』，。、；：！？（）【】《》〈〉“”‘’]+/i.exec(text.slice(i));
				if (m !== null) {
					const url = m[0].replace(/[.,;:!?，。、；：！？]+$/, "");
					flush();
					out.push({ t: "link", label: url, url, bare: true });
					i += url.length;
					continue;
				}
			}
		}
		buf += ch;
		i++;
	}
	flush();
	return out;
}

function RrenderLink(tok, key) {
	const safe = typeof tok.url === "string" && /^https?:\/\//i.test(tok.url);
	const label = typeof tok.label === "string" && tok.label.trim() !== "" ? tok.label : tok.url;
	if (!safe) return h("span", { key, className: "dcr-md-link-off" }, label);
	return h("a", {
		key,
		className: "dcr-md-link",
		href: tok.url,
		target: "_blank",
		rel: "noreferrer noopener",
		title: tok.url,
	}, label);
}

function RrenderInlineTokens(tokens, keyPrefix) {
	if (!Array.isArray(tokens)) return null;
	const prefix = keyPrefix || "i";
	return tokens.map((tk, idx) => {
		if (tk === null || tk === undefined) return null;
		const key = prefix + idx;
		switch (tk.t) {
			case "text":
				return tk.v;
			case "br":
				return h("br", { key });
			case "code":
				return h("code", { key, className: "dcr-md-code" }, tk.v);
			case "strong":
				return h("strong", { key }, RrenderInlineTokens(tk.c, key + "s"));
			case "em":
				return h("em", { key }, RrenderInlineTokens(tk.c, key + "e"));
			case "del":
				return h("del", { key }, RrenderInlineTokens(tk.c, key + "d"));
			case "link":
				return RrenderLink(tk, key);
			default:
				return tk.v || null;
		}
	});
}

function Rinline(text, keyPrefix) {
	return RrenderInlineTokens(RinlineTokens(text), keyPrefix);
}

// ── Markdown：块级渲染 ──────────────────────────────────────────────────────

function RrenderList(block, key) {
	const tag = block.ordered ? "ol" : "ul";
	const props = { key, className: block.ordered ? "dcr-md-ol" : "dcr-md-ul" };
	if (block.ordered && Number(block.start) > 1) props.start = Number(block.start);
	return h(tag, props, block.items.map((item, idx) => h("li", {
		key: idx,
		className: "dcr-md-li",
	},
		h("span", { className: "dcr-md-li-text" }, Rinline(item.text, key + "l" + idx + "_")),
		item.children.length > 0
			? item.children.map((child, ci) => RrenderList(child, key + "n" + idx + "_" + ci))
			: null)));
}

function RrenderTable(block, key) {
	const aligns = Array.isArray(block.aligns) ? block.aligns : [];
	const cellStyle = (ci) => (aligns[ci] === "center" || aligns[ci] === "right" ? { textAlign: aligns[ci] } : undefined);
	return h("div", { key, className: "dcr-md-tablewrap" },
		h("table", { className: "dcr-md-table" },
			h("thead", null, h("tr", null, block.header.map((cell, ci) => h("th", {
				key: ci,
				style: cellStyle(ci),
			}, Rinline(cell, key + "th" + ci + "_"))))),
			h("tbody", null, block.rows.map((row, ri) => h("tr", { key: ri }, row.map((cell, ci) => h("td", {
				key: ci,
				style: cellStyle(ci),
			}, Rinline(cell, key + "td" + ri + "_" + ci + "_"))))))));
}

function RrenderMarkdownBlock(block, key) {
	switch (block.type) {
		case "heading": {
			const level = Math.max(1, Math.min(6, block.level));
			return h("h" + level, {
				key,
				className: "dcr-md-h dcr-md-h" + level,
			}, Rinline(block.text, key + "h_"));
		}
		case "paragraph":
			return h("p", { key, className: "dcr-md-p" }, Rinline(block.text, key + "p_"));
		case "list":
			return RrenderList(block, key);
		case "quote":
			return h("blockquote", { key, className: "dcr-md-quote" },
				RrenderMarkdownBlocks(block.children, key + "q_"));
		case "code":
			return h("div", { key, className: "dcr-md-codeblock" },
				h("div", { className: "dcr-md-codehead" },
					h("span", { className: "dcr-md-codelang" }, block.lang || "code")),
				h("pre", { className: "dcr-md-pre" },
					h("code", null, block.text)));
		case "table":
			return RrenderTable(block, key);
		case "hr":
			return h("hr", { key, className: "dcr-md-hr" });
		case "pagebreak":
			return h("div", { key, className: "dcr-md-pagebreak" }, h("span", null, "分页"));
		default:
			return null;
	}
}

function RrenderMarkdownBlocks(blocks, keyPrefix) {
	if (!Array.isArray(blocks)) return null;
	const prefix = keyPrefix || "b";
	return blocks.map((block, idx) => RrenderMarkdownBlock(block, prefix + idx));
}

// ── MarkdownView：安全的纯 React Markdown 渲染（无 dangerouslySetInnerHTML） ──

function MarkdownView({ markdown }) {
	const blocks = RuseMemo(() => RparseMarkdown(typeof markdown === "string" ? markdown : ""), [markdown]);
	if (blocks.length === 0) {
		return h("div", { className: "dcr-scope dcr-md dcr-md-empty" },
			h("div", { className: "dcr-md-empty-icon" }, h(RIcon, { name: "doc", size: 24 })),
			h("div", null, "暂无正文内容"));
	}
	return h("div", { className: "dcr-scope dcr-md" }, RrenderMarkdownBlocks(blocks, "md"));
}

// ── 大纲视图 ────────────────────────────────────────────────────────────────

/** Lead 约定：project.outline.versions[i] 自带完整 sections；其余形状做兜底。 */
function RoutlineBody(project, version) {
	const outline = (project && project.outline) || {};
	const meta = RversionMeta(outline.versions, version);
	if (meta !== null) {
		if (Array.isArray(meta.sections)) return meta;
		if (meta.outline && Array.isArray(meta.outline.sections)) return meta.outline;
	}
	const current = outline.current;
	if (current && Array.isArray(current.sections)) return current;
	if (current && current.outline && Array.isArray(current.outline.sections)) return current.outline;
	if (Array.isArray(outline.sections)) return outline;
	return null;
}

function RMetaItem({ icon, children }) {
	return h("span", { className: "dcr-meta-item" },
		icon ? h(RIcon, { name: icon, size: 12 }) : null,
		h("span", null, children));
}

function RSectionCard({ section, index }) {
	const heading = section && typeof section.heading === "string" && section.heading.trim() !== ""
		? section.heading
		: "未命名小节";
	const points = Rlist(section && section.points)
		.filter((p) => typeof p === "string" && p.trim() !== "");
	const notes = section && typeof section.notes === "string" ? section.notes.trim() : "";
	return h("section", { className: "dcr-sec" },
		h("div", { className: "dcr-sec-head" },
			h("span", { className: "dcr-sec-num" }, Rpad2(index + 1)),
			h("h3", { className: "dcr-sec-title" }, heading)),
		points.length > 0
			? h("ul", { className: "dcr-sec-points" }, points.map((p, i) => h("li", { key: i }, p)))
			: h("p", { className: "dcr-sec-nopoints" }, "本节暂无要点"),
		notes !== ""
			? h("div", { className: "dcr-sec-notes" },
				h("span", { className: "dcr-sec-notes-label" }, "写作提示"),
				h("span", null, notes))
			: null);
}

function OutlineView({ project, busy, job, onVersion, onConfirm, onRegenerate }) {
	const outline = (project && project.outline) || {};
	const versions = Rlist(outline.versions).filter((v) => v && Number.isFinite(Number(v.version)));
	const active = RpickVersion(outline.active, versions);
	const meta = RversionMeta(versions, active);
	const body = RoutlineBody(project, active);
	const sections = Rlist(body && body.sections);
	const confirmed = outline.confirmed;
	const isConfirmed = confirmed !== null && confirmed !== undefined && Number(confirmed) === active;
	const busyOn = busy !== null && busy !== undefined && busy !== false;
	const warnings = Rlist(project && project.warnings);
	const title = (body && typeof body.title === "string" && body.title.trim() !== "" ? body.title
		: (meta && typeof meta.title === "string" && meta.title !== "" ? meta.title
			: ((project && project.name) || "未命名文档")));
	const canRegen = typeof onRegenerate === "function";
	const canConfirm = typeof onConfirm === "function" && meta !== null && active !== null;

	if (versions.length === 0) {
		return h("div", { className: "dcr-scope dcr-outline" },
			h("div", { className: "dcr-empty-wrap" },
				h(REmpty, {
					icon: "doc",
					title: busyOn ? "正在生成大纲…" : "还没有生成大纲",
					hint: busyOn
						? "AI 正在结合主题、模板、参考文档与红线要求组织文档结构，完成后会在这里展示。"
						: "先在「准备」步骤填写主题与参考资料，再点击生成大纲；生成后可以逐版本查看、对话调整，确认后生成成文。",
					action: busyOn || !canRegen ? null : h("button", {
						type: "button",
						className: "dcr-btn dcr-btn-primary",
						onClick: () => onRegenerate(),
					}, h(RIcon, { name: "refresh", size: 14 }), "生成大纲"),
				}),
				busyOn ? h(RBusyBar, { busy, job }) : null));
	}

	const metaItems = [];
	if (meta !== null) {
		const sectionCount = meta.sectionCount || sections.length;
		if (sectionCount > 0) metaItems.push(h(RMetaItem, { key: "s", icon: "list" }, "共 " + sectionCount + " 节"));
		if (meta.chars) metaItems.push(h(RMetaItem, { key: "c", icon: "doc" }, "约 " + RfmtNum(meta.chars) + " 字"));
		if (meta.sourceCount) metaItems.push(h(RMetaItem, { key: "src", icon: "link" }, meta.sourceCount + " 份联网资料"));
		if (meta.createdAt) metaItems.push(h(RMetaItem, { key: "t", icon: "refresh" }, "生成于 " + RfmtTimeShort(meta.createdAt)));
		if (meta.changeNote) metaItems.push(h(RMetaItem, { key: "n", icon: "info" }, meta.changeNote));
	}

	return h("div", { className: "dcr-scope dcr-outline" },
		h("div", { className: "dcr-view-head" },
			h("div", { className: "dcr-view-title-row" },
				h("h2", { className: "dcr-view-title" }, title),
				h("div", { className: "dcr-head-badges" },
					isConfirmed ? h("span", { className: "dcr-tag dcr-tag-green" }, "已确认") : null,
					active !== null ? h("span", { className: "dcr-tag dcr-tag-dim" }, "v" + active) : null)),
			metaItems.length > 0 ? h("div", { className: "dcr-meta-row" }, metaItems) : null,
			h(RWarnings, { warnings })),
		h(RVersionTabs, { versions, active, confirmed, kind: "outline", onVersion }),
		h("div", { className: "dcr-scroll" },
			h("div", { className: "dcr-sections" },
				sections.length > 0
					? sections.map((section, index) => h(RSectionCard, { key: index, section, index }))
					: h(REmpty, {
						icon: "doc",
						title: "大纲正文未加载",
						hint: "当前版本的章节内容没有随项目返回。可以切换其他版本，或重新生成大纲。",
					}))),
		h("div", { className: "dcr-actions" },
			busyOn ? h(RBusyBar, { busy, job }) : null,
			h("div", { className: "dcr-actions-row" },
				h("button", {
					type: "button",
					className: "dcr-btn dcr-btn-ghost",
					disabled: busyOn || !canRegen,
					onClick: canRegen ? () => onRegenerate() : undefined,
				}, h(RIcon, { name: "refresh", size: 14 }), "重新生成大纲"),
				h("div", { className: "dcr-actions-gap" }),
				h("span", { className: "dcr-actions-hint" },
					isConfirmed ? "此版本已确认，可再次确认并按当前版本生成成文" : "确认后会按当前版本生成成文"),
				h("button", {
					type: "button",
					className: "dcr-btn dcr-btn-primary",
					disabled: busyOn || !canConfirm,
					onClick: canConfirm ? () => onConfirm(active) : undefined,
				}, h(RIcon, { name: "check", size: 14 }), "确认大纲，生成成文"))));
}

// ── 成文视图 ────────────────────────────────────────────────────────────────

function RValidationPanel({ items }) {
	const list = Rlist(items);
	const [open, setOpen] = RuseState(false);
	const counts = { pass: 0, risk: 0, unknown: 0 };
	for (const it of list) {
		const status = it && it.status;
		if (status === "pass") counts.pass++;
		else if (status === "risk") counts.risk++;
		else counts.unknown++;
	}
	const chips = [
		{ key: "pass", icon: "check", label: "通过", n: counts.pass },
		{ key: "risk", icon: "alert", label: "需关注", n: counts.risk },
		{ key: "unknown", icon: "question", label: "待确认", n: counts.unknown },
	];
	return h("section", { className: "dcr-card dcr-valid" },
		h("button", {
			type: "button",
			className: "dcr-card-head",
			onClick: () => setOpen(!open),
			"aria-expanded": open ? "true" : "false",
		},
			h("span", { className: "dcr-card-title" },
				h(RIcon, { name: "shield", size: 14 }),
				"红线自检",
				h("span", { className: "dcr-count" }, list.length)),
			h("span", { className: "dcr-collapse" },
				open ? "收起明细" : "查看明细",
				h(RIcon, { name: "chevron", size: 12, className: "dcr-chevron" + (open ? " dcr-is-open" : "") }))),
		h("div", { className: "dcr-checks" }, chips.map((c) => h("span", {
			key: c.key,
			className: "dcr-check dcr-is-" + c.key + (c.n === 0 ? " dcr-is-zero" : ""),
		},
			h(RIcon, { name: c.icon, size: 13 }),
			c.label,
			h("b", null, String(c.n))))),
		list.length === 0
			? h("div", { className: "dcr-valid-empty" }, "本次生成没有返回红线自检结果。")
			: (open ? h("ul", { className: "dcr-valid-list" }, list.map((it, index) => {
				const status = R_VALID_STATUS[it && it.status] || R_VALID_STATUS.unknown;
				return h("li", { key: index, className: "dcr-valid-item dcr-is-" + status.key },
					h("span", { className: "dcr-valid-dot" }),
					h("div", { className: "dcr-valid-body" },
						h("div", { className: "dcr-valid-label" }, (it && it.label) || "检查项"),
						it && typeof it.note === "string" && it.note.trim() !== ""
							? h("div", { className: "dcr-valid-note" }, it.note)
							: null),
					h("span", { className: "dcr-valid-kind" }, R_VALID_KIND[it && it.kind] || ""));
			})) : null));
}

function RSourcesPanel({ sources }) {
	const list = Rlist(sources).filter((s) => s && typeof s === "object");
	const [open, setOpen] = RuseState(false);
	if (list.length === 0) return null;
	return h("section", { className: "dcr-card dcr-src" },
		h("button", {
			type: "button",
			className: "dcr-card-head",
			onClick: () => setOpen(!open),
			"aria-expanded": open ? "true" : "false",
		},
			h("span", { className: "dcr-card-title" },
				h(RIcon, { name: "link", size: 14 }),
				"参考资料",
				h("span", { className: "dcr-count" }, list.length)),
			h("span", { className: "dcr-collapse" },
				open ? "收起" : "展开",
				h(RIcon, { name: "chevron", size: 12, className: "dcr-chevron" + (open ? " dcr-is-open" : "") }))),
		open ? h("ol", { className: "dcr-src-list" }, list.map((source, index) => {
			const href = RsafeHref(source.url);
			return h("li", { key: source.id || index, className: "dcr-src-item" },
				h("span", { className: "dcr-src-n" }, "[" + (index + 1) + "]"),
				h("div", { className: "dcr-src-body" },
					source.title ? h("div", { className: "dcr-src-title" }, source.title) : null,
					href !== null
						? h("a", {
							className: "dcr-src-url",
							href,
							target: "_blank",
							rel: "noreferrer noopener",
							title: source.title || href,
						}, href)
						: h("span", { className: "dcr-src-url" }, source.url || "")));
		})) : null);
}

function DocumentView({ project, document, busy, job, onVersion, onRegenerate, onDownload, onView }) {
	const docState = (project && project.document) || {};
	const versions = Rlist(docState.versions).filter((v) => v && Number.isFinite(Number(v.version)));
	const active = RpickVersion(docState.active, versions);
	const versionMeta = RversionMeta(versions, active);
	const docMeta = document && document.meta && typeof document.meta === "object" ? document.meta : null;
	const meta = docMeta || versionMeta;
	const loadingDoc = document === null || document === undefined;
	const markdown = document && typeof document.markdown === "string" ? document.markdown : "";
	const validation = Rlist(meta && meta.validation ? meta.validation : (versionMeta && versionMeta.validation));
	const sourceList = Rlist(project && project.sources);
	const warnings = Rlist(project && project.warnings);
	const busyOn = busy !== null && busy !== undefined && busy !== false;
	const canRegen = typeof onRegenerate === "function";
	const canDownload = typeof onDownload === "function";
	const title = (meta && meta.title) || (versionMeta && versionMeta.title) || (project && project.name) || "成文";
	const projectId = project && project.id ? String(project.id) : "";

	const formats = Rlist(meta && meta.format);
	const canFormat = (fmt) => formats.length === 0 || formats.indexOf(fmt) >= 0;
	const downloadHref = (fmt) => R_API_BASE + "/download/" + encodeURIComponent(projectId) + "/" + active + "." + fmt;
	const downloadName = (fmt) => RdownloadName(project, meta || { version: active, title }, fmt);

	const renderDownload = (fmt, primary) => {
		const label = fmt === "docx" ? "下载 Word" : "下载 Markdown";
		const className = "dcr-btn " + (primary ? "dcr-btn-primary" : "dcr-btn-ghost");
		const enabled = active !== null && canFormat(fmt);
		const hint = enabled ? "" : "该版本未生成 " + (fmt === "docx" ? "Word" : "Markdown") + " 文件";
		if (canDownload) {
			return h("button", {
				type: "button",
				className,
				disabled: busyOn || !enabled,
				title: hint,
				onClick: enabled ? () => onDownload(fmt, active) : undefined,
			}, h(RIcon, { name: "download", size: 14 }), label);
		}
		if (!enabled) {
			return h("button", { type: "button", className, disabled: true, title: hint },
				h(RIcon, { name: "download", size: 14 }), label);
		}
		return h("a", {
			className,
			href: downloadHref(fmt),
			download: downloadName(fmt),
		}, h(RIcon, { name: "download", size: 14 }), label);
	};

	if (versions.length === 0) {
		return h("div", { className: "dcr-scope dcr-doc" },
			h("div", { className: "dcr-empty-wrap" },
				h(REmpty, {
					icon: "doc",
					title: busyOn ? "正在生成成文…" : "还没有成文",
					hint: busyOn
						? "AI 正在按已确认的大纲撰写正文，完成后可以在这里预览并下载 Word / Markdown。"
						: "确认大纲后即可生成成文，支持在线预览、红线自检与 Word / Markdown 下载。",
					action: busyOn || !canRegen ? null : h("button", {
						type: "button",
						className: "dcr-btn dcr-btn-primary",
						onClick: () => onRegenerate(),
					}, h(RIcon, { name: "refresh", size: 14 }), "生成成文"),
				}),
				busyOn ? h(RBusyBar, { busy, job }) : null,
				h(RWarnings, { warnings })));
	}

	const metaItems = [];
	if (meta !== null) {
		if (meta.wordCount) metaItems.push(h(RMetaItem, { key: "w", icon: "doc" }, RfmtNum(meta.wordCount) + " 字"));
		if (meta.createdAt) metaItems.push(h(RMetaItem, { key: "t", icon: "refresh" }, "生成于 " + RfmtTimeShort(meta.createdAt)));
		if (meta.outlineVersion) {
			metaItems.push(h("button", {
				key: "ov",
				type: "button",
				className: "dcr-meta-item dcr-meta-link",
				onClick: typeof onView === "function" ? () => onView("outline") : undefined,
				disabled: typeof onView !== "function",
				title: typeof onView === "function" ? "回到大纲阶段查看" : "",
			},
				h(RIcon, { name: "list", size: 12 }),
				h("span", null, "大纲 v" + meta.outlineVersion)));
		}
		if (formats.length > 0) {
			metaItems.push(h(RMetaItem, { key: "f", icon: "download" },
				formats.map((f) => (f === "docx" ? "Word" : f === "md" ? "Markdown" : String(f))).join(" · ")));
		}
		if (meta.model && (meta.model.model || meta.model.provider)) {
			metaItems.push(h(RMetaItem, { key: "m", icon: "spark" }, String(meta.model.model || meta.model.provider)));
		}
	}

	return h("div", { className: "dcr-scope dcr-doc" },
		h(RVersionTabs, { versions, active, confirmed: null, kind: "document", onVersion }),
		h("div", { className: "dcr-doc-head" },
			metaItems.length > 0 ? h("div", { className: "dcr-meta-row" }, metaItems) : null,
			h(RWarnings, { warnings })),
		h("div", { className: "dcr-doc-body" },
			h("div", { className: "dcr-doc-stack" },
				loadingDoc
					? h("article", { className: "dcr-paper dcr-paper-loading" },
						h("span", { className: "dcr-spinner" }),
						h("span", null, "正在加载成文正文…"))
					: (markdown.trim() === ""
						? h("article", { className: "dcr-paper" },
							h(REmpty, {
								icon: "doc",
								title: "该版本没有正文",
								hint: "可以切换到其他版本，或重新生成成文。",
							}))
						: h("article", { className: "dcr-paper" }, h(MarkdownView, { markdown }))),
				h(RValidationPanel, { items: validation }),
				h(RSourcesPanel, { sources: sourceList }))),
		h("div", { className: "dcr-actions" },
			busyOn ? h(RBusyBar, { busy, job }) : null,
			h("div", { className: "dcr-actions-row" },
				h("div", { className: "dcr-downloads" },
					renderDownload("docx", true),
					renderDownload("md", false)),
				h("div", { className: "dcr-actions-gap" }),
				title ? h("span", { className: "dcr-actions-note" }, title) : null,
				h("button", {
					type: "button",
					className: "dcr-btn dcr-btn-ghost",
					disabled: busyOn || !canRegen,
					onClick: canRegen ? () => onRegenerate() : undefined,
				}, h(RIcon, { name: "refresh", size: 14 }), "重新生成成文")),
			meta !== null && formats.length > 0 && !canFormat("docx")
				? h("div", { className: "dcr-actions-warn" }, "该版本未能导出 Word 文件，可先下载 Markdown。")
				: null));
}

// ── AI 调整对话 ─────────────────────────────────────────────────────────────

const R_HAS_PHASE = (m) => m != null && (m.phase === "outline" || m.phase === "document");

function RchatMessage({ message, currentPhase, showPhase }) {
	const role = message && message.role === "user" ? "user" : "assistant";
	const content = message && typeof message.content === "string" ? message.content : "";
	const error = !!(message && message.error);
	const action = message && message.action && (message.action.kind === "outline" || message.action.kind === "document")
		? message.action
		: null;
	const phase = message && message.phase === "document" ? "document" : "outline";
	const showTag = showPhase || (R_HAS_PHASE(message) && phase !== currentPhase);
	const actionText = action === null
		? ""
		: (Number.isFinite(Number(action.version))
			? "已更新为" + (action.kind === "document" ? "成文" : "大纲") + " v" + action.version
			: "已更新" + (action.kind === "document" ? "成文" : "大纲"));
	return h("div", {
		className: "dcr-msg " + (role === "user" ? "dcr-is-user" : "dcr-is-ai") + (error ? " dcr-is-error" : ""),
	},
		h("div", { className: "dcr-msg-col" },
			showTag || error ? h("div", { className: "dcr-msg-tags" },
				showTag ? h("span", { className: "dcr-tag dcr-tag-dim" }, R_PHASE_LABEL[phase]) : null,
				error ? h("span", { className: "dcr-tag dcr-tag-red" }, "失败") : null) : null,
			h("div", { className: "dcr-bubble" },
				content !== "" ? content : (error ? "生成失败，请重试。" : "（空回复）")),
			action !== null
				? h("span", { className: "dcr-act-chip", title: "可在上方版本 tabs 中切换查看" },
					h(RIcon, { name: "check", size: 11 }),
					actionText)
				: null,
			message && message.at ? h("div", { className: "dcr-msg-meta" }, R_FMT_TIME(message.at)) : null));
}

function ChatDock({ phase, messages, busy, job, onSend, onQuick }) {
	const currentPhase = phase === "document" ? "document" : "outline";
	const list = Rlist(messages).filter((m) => m && typeof m === "object");
	const busyOn = busy !== null && busy !== undefined && busy !== false;
	const listRef = RuseRef(null);
	const taRef = RuseRef(null);
	const [draft, setDraft] = RuseState("");
	const [showPrev, setShowPrev] = RuseState(false);
	const prev = list.filter((m) => R_HAS_PHASE(m) && m.phase !== currentPhase);
	const current = list.filter((m) => !R_HAS_PHASE(m) || m.phase === currentPhase);
	const visible = showPrev ? list : current;
	const canSend = typeof onSend === "function";
	const canQuick = typeof onQuick === "function" || canSend;
	const chips = R_CHIPS[currentPhase] || R_CHIPS.outline;

	RuseEffect(() => {
		const el = listRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [list.length, busyOn, showPrev]);

	RuseEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = Math.min(160, Math.max(44, ta.scrollHeight)) + "px";
	}, [draft]);

	const submit = RuseCallback(() => {
		const text = draft.trim();
		if (text === "" || busyOn || typeof onSend !== "function") return;
		onSend(text);
		setDraft("");
	}, [draft, busyOn, onSend]);

	const quick = (text) => {
		if (busyOn) return;
		if (typeof onQuick === "function") onQuick(text);
		else if (typeof onSend === "function") onSend(text);
	};

	const onKeyDown = (event) => {
		if (event.key !== "Enter") return;
		const native = event.nativeEvent || event;
		if (event.shiftKey || native.isComposing || event.isComposing) return;
		event.preventDefault();
		submit();
	};

	const emptyHint = currentPhase === "document"
		? "可以让我扩写某段、精简篇幅、统一术语，或为结论补充数据来源；调整后会生成新的成文版本。"
		: "可以让我增加或合并章节、调整顺序与语气，也可以直接讨论内容思路；调整后会生成新的大纲版本。";

	return h("div", { className: "dcr-scope dcr-chat" },
		h("div", { className: "dcr-chat-head" },
			h("div", { className: "dcr-chat-titlewrap" },
				h("div", { className: "dcr-chat-title" },
					h(RIcon, { name: "spark", size: 15 }),
					"AI 调整"),
				h("span", { className: "dcr-pill dcr-pill-blue" }, R_PHASE_LABEL[currentPhase]),
				h("span", { className: "dcr-pill dcr-pill-dim" }, "共享上下文")),
			h("div", { className: "dcr-chat-sub" }, "对话上下文在两个阶段间共享，可随时要求调整内容")),
		prev.length > 0
			? h("div", { className: "dcr-ctx-wrap" },
				h("div", { className: "dcr-ctx-bar" },
					h(RIcon, { name: "info", size: 12 }),
					h("span", { className: "dcr-ctx-text" },
						"已继承" + R_PHASE_LABEL[prev[0].phase] + "的 " + prev.length + " 条对话上下文"),
					h("button", {
						type: "button",
						className: "dcr-btn dcr-btn-link",
						onClick: () => setShowPrev(!showPrev),
					}, showPrev ? "隐藏" : "展开")))
			: null,
		h("div", { className: "dcr-chat-list", ref: listRef },
			visible.length === 0
				? h("div", { className: "dcr-chat-empty" },
					h("div", { className: "dcr-chat-empty-icon" }, h(RIcon, { name: "spark", size: 20 })),
					h("div", { className: "dcr-chat-empty-title" },
						currentPhase === "document" ? "用对话调整成文" : "用对话调整大纲"),
					h("p", null, prev.length > 0 && !showPrev
						? "本阶段还没有对话。已继承" + prev.length + " 条来自" + R_PHASE_LABEL[prev[0].phase] + "的上下文，可点上方「展开」查看。"
						: emptyHint))
				: visible.map((message, index) => h(RchatMessage, {
					key: message.id || ("msg-" + index),
					message,
					currentPhase,
					showPhase: showPrev,
				}))),
		h("div", { className: "dcr-chat-foot" },
			busyOn ? h(RBusyBar, { busy, job, compact: true }) : null,
			h("div", { className: "dcr-chips" }, chips.map((text) => h("button", {
				key: text,
				type: "button",
				className: "dcr-chip",
				disabled: busyOn || !canQuick,
				onClick: () => quick(text),
			}, text))),
			h("div", { className: "dcr-composer" + (busyOn ? " dcr-is-busy" : "") },
				h("textarea", {
					ref: taRef,
					className: "dcr-textarea",
					rows: 2,
					value: draft,
					placeholder: busyOn
						? "AI 正在处理，请稍候…"
						: (currentPhase === "document"
							? "描述你想如何调整成文，例如：把第 2 节扩写到 800 字…"
							: "描述你想如何调整大纲，例如：把第 4 节拆成两节…"),
					disabled: busyOn,
					onChange: (event) => setDraft(event.target.value),
					onKeyDown,
					"aria-label": "向 AI 描述调整要求",
				}),
				h("div", { className: "dcr-composer-bar" },
					h("span", { className: "dcr-hint" },
						busyOn ? "AI 正在处理，请稍候…" : "Enter 发送 · Shift+Enter 换行"),
					h("button", {
						type: "button",
						className: "dcr-send",
						disabled: busyOn || draft.trim() === "" || !canSend,
						onClick: submit,
						title: "发送（Enter）",
					},
						h(RIcon, { name: "send", size: 13 }),
						"发送")))));
}
