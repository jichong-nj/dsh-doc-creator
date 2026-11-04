// doc-creator — 浏览器端 UI（一）：通用样式、API 封装、基础组件、项目栏、步骤条、准备资料向导。
//
// 本文件由 build.js 拼进 module-loader factory 的函数体（与 client.review.js、
// client.app.js 共用同一个闭包）：React 来自 require("react")，没有 JSX，一律
// React.createElement（这里定义 const h）。样式由 app.js 的 ensureCss() 注入为
// 一个 <style> 标签（BASE_CSS + REVIEW_CSS）。
//
// 约定：所有 class 前缀 dc-；颜色只用 DSH 设计 token（--dsw-alias-*，回退色），
// 深色/浅色由宿主在 body 上切换 token，故这里没有 prefers-color-scheme。

const React = require("react");
const { useState, useEffect, useCallback, useRef, useMemo } = React;
const h = React.createElement;

const API = "/doc-creator/api";
const CSS_TAG_ID = "@jichong/dsh-doc-creator/dc.css";

// ── transport ────────────────────────────────────────────────────────────────

/** 统一 POST：解 { ok:true, value }，失败抛 Error(中文 message)。 */
async function post(path, body) {
	let res;
	try {
		res = await fetch(`${API}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
	} catch (err) {
		throw new Error(`网络请求失败：${err?.message ?? "无法连接文档服务"}`);
	}
	const payload = await res.json().catch(() => null);
	if (payload === null || typeof payload !== "object") {
		throw new Error(res.ok ? "文档服务返回了无法解析的内容" : `请求失败（HTTP ${res.status}）`);
	}
	if (!res.ok || payload.ok !== true) {
		const message = payload?.error?.message;
		throw new Error(typeof message === "string" && message !== "" ? message : `请求失败（HTTP ${res.status}）`);
	}
	return payload.value;
}

/** 上传参考文档：原始字节 POST 到 /upload-ref?projectId=&name=（返回 { project, ref }）。 */
async function uploadRef(projectId, file) {
	const query = `projectId=${encodeURIComponent(projectId)}&name=${encodeURIComponent(file.name ?? "参考文档")}`;
	let res;
	try {
		const body = typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : file;
		res = await fetch(`${API}/upload-ref?${query}`, {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body,
		});
	} catch (err) {
		throw new Error(`上传失败：${err?.message ?? "网络中断"}`);
	}
	const payload = await res.json().catch(() => null);
	if (payload === null || typeof payload !== "object") {
		throw new Error(res.ok ? "上传返回了无法解析的内容" : `上传失败（HTTP ${res.status}）`);
	}
	if (!res.ok || payload.ok !== true) {
		const message = payload?.error?.message;
		throw new Error(typeof message === "string" && message !== "" ? message : `上传失败（HTTP ${res.status}）`);
	}
	return payload.value;
}

// ── formatters / tiny helpers ────────────────────────────────────────────────

function fmtSize(bytes) {
	if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtChars(count) {
	if (typeof count !== "number" || !Number.isFinite(count)) return "—";
	if (count < 10000) return `${Math.round(count).toLocaleString("zh-CN")} 字`;
	const wan = count / 10000;
	return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1).replace(/\.0$/, "")} 万字`;
}

function fmtTime(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "—";
	const date = new Date(ms);
	const now = new Date();
	const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	if (date.toDateString() === now.toDateString()) return `今天 ${hhmm}`;
	const yesterday = new Date(now.getTime() - 86400000);
	if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`;
	if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${hhmm}`;
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function clamp(value, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return min;
	return Math.min(max, Math.max(min, n));
}

/** className 拼接：支持字符串 / 数组 / {class: truthy}。 */
function cx(...parts) {
	const out = [];
	const walk = (part) => {
		if (part === null || part === undefined || part === false || part === "") return;
		if (typeof part === "string") {
			out.push(part);
			return;
		}
		if (Array.isArray(part)) {
			for (const item of part) walk(item);
			return;
		}
		if (typeof part === "object") {
			for (const key of Object.keys(part)) if (part[key]) out.push(key);
		}
	};
	for (const part of parts) walk(part);
	return out.join(" ");
}

function truncateText(value, max = 40) {
	const text = String(value ?? "");
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(1, max - 1))}…`;
}

let dcSeq = 0;
function dcUid(prefix = "dc") {
	dcSeq += 1;
	return `${prefix}-${dcSeq.toString(36)}${Date.now().toString(36).slice(-4)}`;
}

const DC_STAGE_META = {
	setup: { label: "准备资料", tone: "neutral" },
	outline: { label: "大纲", tone: "info" },
	document: { label: "成文", tone: "success" },
};

function dcStageMeta(stage) {
	return DC_STAGE_META[stage] ?? DC_STAGE_META.setup;
}

function dcStageLabel(stage) {
	return dcStageMeta(stage).label;
}

function dcStageTone(stage) {
	return dcStageMeta(stage).tone;
}

// 风格选项（与后端 styleLabels 对齐；前端硬编码，避免多一次请求）
const DC_STYLE_LABELS = {
	audience: { general: "通用读者", management: "管理层", technical: "技术读者", client: "客户 / 外部" },
	tone: { formal: "正式严谨", professional: "专业清晰", friendly: "友好易懂" },
	length: { short: "简短（约 800–1200 字）", standard: "标准（约 2000–3500 字）", detailed: "详尽（约 4500–7000 字）" },
};

// ── icons（内联 SVG，跟随 currentColor）──────────────────────────────────────

const DC_ICON_PATHS = {
	plus: [["path", { d: "M12 5v14M5 12h14" }]],
	x: [["path", { d: "M6 6l12 12M18 6L6 18" }]],
	check: [["path", { d: "M4.5 12.5l5 5L20 6.5" }]],
	"check-circle": [["circle", { cx: 12, cy: 12, r: 9 }], ["path", { d: "M8 12.4l2.6 2.6L16.4 9" }]],
	alert: [
		["path", { d: "M12 3.6L2.7 20h18.6L12 3.6z" }],
		["path", { d: "M12 9.5v4.6" }],
		["circle", { cx: 12, cy: 17.2, r: 0.95, fill: "currentColor", stroke: "none" }],
	],
	info: [
		["circle", { cx: 12, cy: 12, r: 9 }],
		["path", { d: "M12 11v5.4" }],
		["circle", { cx: 12, cy: 7.8, r: 0.95, fill: "currentColor", stroke: "none" }],
	],
	"chevron-right": [["path", { d: "M9 5l7 7-7 7" }]],
	"chevron-down": [["path", { d: "M5 9l7 7 7-7" }]],
	"chevron-up": [["path", { d: "M5 15l7-7 7 7" }]],
	refresh: [["path", { d: "M20 11.5A8 8 0 1 0 18.2 17" }], ["path", { d: "M20 4.5v6h-6" }]],
	trash: [
		["path", { d: "M4 7h16" }],
		["path", { d: "M9.5 7V4.8h5V7" }],
		["path", { d: "M6.5 7l1 12.2h9L17.5 7" }],
		["path", { d: "M10.5 11v5M13.5 11v5" }],
	],
	upload: [["path", { d: "M12 16V4.5" }], ["path", { d: "M7 9.5L12 4.5l5 5" }], ["path", { d: "M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" }]],
	download: [["path", { d: "M12 4.5V16" }], ["path", { d: "M7 11l5 5 5-5" }], ["path", { d: "M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15" }]],
	file: [
		["path", { d: "M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z" }],
		["path", { d: "M14 3.5v5h5" }],
		["path", { d: "M8.5 12.5h7M8.5 16h4.5" }],
	],
	sparkles: [
		["path", { d: "M11.5 3.5l1.9 5.3 5.3 1.9-5.3 1.9-1.9 5.3-1.9-5.3L4.3 10.7l5.3-1.9z" }],
		["path", { d: "M18.4 3.4v2.3M17.2 4.6h2.4" }],
	],
	list: [
		["path", { d: "M8.5 6.5h11M8.5 12h11M8.5 17.5h11" }],
		["circle", { cx: 4.6, cy: 6.5, r: 1.05, fill: "currentColor", stroke: "none" }],
		["circle", { cx: 4.6, cy: 12, r: 1.05, fill: "currentColor", stroke: "none" }],
		["circle", { cx: 4.6, cy: 17.5, r: 1.05, fill: "currentColor", stroke: "none" }],
	],
	layers: [
		["path", { d: "M12 3.5l8.5 4.4L12 12.3 3.5 7.9z" }],
		["path", { d: "M3.5 12.2L12 16.6l8.5-4.4" }],
		["path", { d: "M3.5 16.4L12 20.8l8.5-4.4" }],
	],
	globe: [
		["circle", { cx: 12, cy: 12, r: 9 }],
		["path", { d: "M3.2 12h17.6" }],
		["path", { d: "M12 3c3.4 2.6 3.4 15.4 0 18M12 3c-3.4 2.6-3.4 15.4 0 18" }],
	],
	"arrow-right": [["path", { d: "M4.5 12h15" }], ["path", { d: "M13.5 6l6 6-6 6" }]],
	link: [
		["path", { d: "M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.5 1.5" }],
		["path", { d: "M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.5-1.5" }],
	],
	folder: [["path", { d: "M3.5 7.2a2 2 0 0 1 2-2h4l2 2.4h7a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" }]],
	edit: [["path", { d: "M4.5 19.5l4.2-1 9.6-9.6-3.2-3.2L5.5 15.3z" }], ["path", { d: "M13.8 6.4l3.2 3.2" }]],
	clock: [["circle", { cx: 12, cy: 12, r: 8.5 }], ["path", { d: "M12 7.5V12l3 2" }]],
	search: [["circle", { cx: 11, cy: 11, r: 6.5 }], ["path", { d: "M16 16l4.5 4.5" }]],
	send: [["path", { d: "M4 12l16-7-6.4 16-2.7-6.3z" }], ["path", { d: "M10.9 14.7l9.1-9.7" }]],
	stop: [["rect", { x: 7, y: 7, width: 10, height: 10, rx: 2 }]],
	quote: [
		["path", { d: "M9.4 11.3c0-2.4 1.3-4.2 3.5-5.1l.6 1.3c-1.4.6-2.2 1.5-2.4 2.5h2.2v4.6H9.4z" }],
		["path", { d: "M15.2 11.3c0-2.4 1.3-4.2 3.5-5.1l.6 1.3c-1.4.6-2.2 1.5-2.4 2.5h2.2v4.6h-3.9z" }],
	],
	sidebar: [
		["rect", { x: 3.5, y: 4.5, width: 17, height: 15, rx: 2.5 }],
		["path", { d: "M9.5 4.5v15" }],
	],
};

DC_ICON_PATHS.close = DC_ICON_PATHS.x;
DC_ICON_PATHS["file-text"] = DC_ICON_PATHS.file;

function DcIcon({ name, size = 16, strokeWidth = 1.8, className }) {
	const paths = DC_ICON_PATHS[name] ?? DC_ICON_PATHS.info;
	return h(
		"svg",
		{
			className: cx("dc-svg", className),
			width: size,
			height: size,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
			focusable: "false",
		},
		paths.map(([tag, attrs], index) => h(tag, { key: index, ...attrs })),
	);
}

// ── styles ───────────────────────────────────────────────────────────────────

const BASE_CSS = `
.dc {
  /* 颜色全部映射到 DSH 自己的设计 token：宿主在 body 上切换浅色/深色，
     这里零 prefers-color-scheme。回退值只在 token 缺失（脱离宿主）时生效。 */
  --dc-bg:var(--dsw-alias-bg-base,#151517);
  --dc-bg2:var(--dsw-alias-bg-layer-1,#1e1e20);
  --dc-bg3:var(--dsw-alias-bg-layer-2,#26262a);
  --dc-sf:var(--dsw-alias-bg-layer-1,#1e1e20);
  --dc-sf2:var(--dsw-alias-bg-layer-2,#26262a);
  --dc-fg:var(--dsw-alias-label-primary,#f5f6f8);
  --dc-mut:var(--dsw-alias-label-secondary,#c9ccd2);
  --dc-dim:var(--dsw-alias-label-tertiary,#9599a1);
  --dc-cap:var(--dsw-alias-label-caption,#787d86);
  --dc-bd:var(--dsw-alias-border-l1,#ffffff1f);
  --dc-bd2:var(--dsw-alias-border-l2,#ffffff33);
  --dc-hover:var(--dsw-alias-interactive-bg-hover,#ffffff14);
  --dc-active:var(--dsw-alias-interactive-bg-active,#ffffff24);
  --dc-chip:var(--dsw-alias-bg-skeleton,#ffffff14);
  --dc-accent:var(--dsw-alias-state-business-primary,#7aaaff);
  --dc-accent-fill:var(--dsw-alias-button-primary-fill,#4d6bfe);
  --dc-accent-fg:var(--dsw-alias-label-primary-inverted,#ffffff);
  --dc-green:var(--dsw-alias-state-success-primary,#22c55e);
  --dc-red:var(--dsw-alias-state-error-primary,#f25a5a);
  --dc-warn:var(--dsw-alias-state-warn-primary,#f59e0b);
  --dc-radius:12px;
  --dc-radius-sm:8px;
  --dc-shadow:var(--dsw-elevation-panel,0 12px 34px rgba(0,0,0,.24));
  display:flex; flex-direction:column; height:100%; min-height:0;
  background:var(--dc-bg); color:var(--dc-fg);
  font-family:var(--dsw-font-family,var(--font-ui,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif));
  font-size:13px; line-height:1.55; -webkit-font-smoothing:antialiased;
}
.dc * { box-sizing:border-box; }
.dc button, .dc input, .dc textarea, .dc select { font-family:inherit; font-size:inherit; }
.dc h1, .dc h2, .dc h3, .dc h4 { margin:0; }
.dc p { margin:0; }
.dc a { color:var(--dsw-alias-link,var(--dc-accent)); }

/* ── 顶栏 ── */
.dc-header { flex:0 0 auto; display:flex; align-items:center; gap:12px; min-height:54px;
  padding:9px 16px; border-bottom:1px solid var(--dc-bd); background:var(--dc-bg2); }
.dc-brand { display:flex; align-items:center; gap:9px; min-width:0; flex:0 0 auto; }
.dc-brand-icon { width:29px; height:29px; border-radius:9px; display:grid; place-items:center;
  color:var(--dc-accent-fg); flex:0 0 auto;
  background:linear-gradient(140deg,var(--dc-accent-fill),var(--dsw-alias-state-business-primary,#7aaaff)); }
.dc-brand-text { display:flex; flex-direction:column; min-width:0; line-height:1.25; }
.dc-brand-title { font-size:14.5px; font-weight:650; letter-spacing:.01em; white-space:nowrap; }
.dc-brand-sub { font-size:10.5px; color:var(--dc-dim); white-space:nowrap; }
.dc-header-mid { display:flex; align-items:center; gap:8px; min-width:0; flex:1 1 auto; }
.dc-header-project { display:flex; align-items:center; gap:7px; min-width:0; }
.dc-header-name { font-size:13px; font-weight:500; color:var(--dc-mut); overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; max-width:46ch; }
.dc-header-sep { width:1px; height:15px; background:var(--dc-bd2); flex:0 0 auto; }
.dc-header-stage { font-size:11px; }
.dc-header-actions { display:flex; align-items:center; gap:6px; flex:0 0 auto; }
.dc-header-count { font-size:11px; color:var(--dc-dim); white-space:nowrap; }

/* ── 主体：左侧项目栏 + 步骤/内容 ── */
.dc-body { flex:1 1 auto; min-height:0; display:flex; }
.dc-body.no-rail .dc-rail { display:none; }
.dc-rail { width:250px; flex:0 0 250px; min-height:0; display:flex; flex-direction:column;
  border-right:1px solid var(--dc-bd); background:var(--dc-bg2); }
.dc-rail-head { display:flex; align-items:center; gap:8px; padding:12px 12px 8px; }
.dc-rail-title { display:flex; align-items:center; gap:6px; font-size:11px; font-weight:650;
  letter-spacing:.05em; color:var(--dc-cap); text-transform:uppercase; }
.dc-rail-count { font-size:10.5px; font-weight:600; color:var(--dc-dim);
  background:var(--dc-chip); border-radius:999px; padding:0 6px; letter-spacing:0; text-transform:none; }
.dc-rail-search { padding:0 10px 8px; }
.dc-rail-search .dc-input { padding:6px 9px; font-size:12px; background:var(--dc-bg); border-radius:8px; }
.dc-rail-list { flex:1 1 auto; min-height:0; overflow-y:auto; padding:2px 8px 14px;
  display:flex; flex-direction:column; gap:3px; }
.dc-rail-empty { padding:26px 12px; text-align:center; color:var(--dc-dim); font-size:12px; line-height:1.7; }
.dc-proj { position:relative; display:flex; align-items:stretch; border-radius:10px;
  border:1px solid transparent; transition:background .14s,border-color .14s; }
.dc-proj:hover { background:var(--dc-hover); }
.dc-proj.on { background:var(--dc-sf); border-color:var(--dc-bd2); }
.dc-proj-main { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:4px;
  padding:8px 26px 8px 10px; border:0; border-radius:10px; background:none; color:inherit;
  font:inherit; text-align:left; cursor:pointer; }
.dc-proj-main:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dc-accent)); outline-offset:-2px; }
.dc-proj.on .dc-proj-main { box-shadow:inset 2px 0 0 var(--dc-accent); }
.dc-proj-name { font-size:12.5px; font-weight:500; color:var(--dc-fg); line-height:1.45;
  overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; word-break:break-word; }
.dc-proj.on .dc-proj-name { font-weight:600; }
.dc-proj-meta { display:flex; align-items:center; gap:5px; flex-wrap:wrap; font-size:10.5px; color:var(--dc-dim); }
.dc-proj-counts { display:flex; align-items:center; gap:3px; font-size:10.5px; color:var(--dc-cap); }
.dc-proj-del { position:absolute; top:5px; right:4px; opacity:0; transition:opacity .14s; }
.dc-proj:hover .dc-proj-del, .dc-proj:focus-within .dc-proj-del, .dc-proj-del:focus-visible { opacity:1; }
@media (hover:none) { .dc-proj-del { opacity:.65; } }
.dc-rail-skel { padding:6px 9px; display:flex; flex-direction:column; gap:8px; }

.dc-stage { flex:1 1 auto; min-width:0; min-height:0; display:flex; flex-direction:column; }
.dc-stepsbar { flex:0 0 auto; display:flex; align-items:center; gap:10px; min-height:46px;
  padding:7px 20px; border-bottom:1px solid var(--dc-bd); background:var(--dc-bg); }
.dc-steps { display:flex; align-items:center; gap:2px; min-width:0; flex:1 1 auto; overflow-x:auto; }
.dc-step { display:inline-flex; align-items:center; gap:7px; padding:5px 11px; border-radius:999px;
  border:1px solid transparent; background:none; color:var(--dc-dim); font:inherit; font-size:12.5px;
  white-space:nowrap; cursor:pointer; transition:background .14s,color .14s,border-color .14s; }
.dc-step:hover:not(:disabled) { background:var(--dc-hover); color:var(--dc-fg); }
.dc-step:disabled { cursor:not-allowed; opacity:.5; }
.dc-step:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dc-accent)); outline-offset:1px; }
.dc-step-idx { display:inline-grid; place-items:center; width:19px; height:19px; border-radius:50%;
  background:var(--dc-chip); color:var(--dc-dim); font-size:11px; font-weight:600; flex:0 0 auto; }
.dc-step.on { color:var(--dc-fg); background:var(--dc-sf); border-color:var(--dc-bd2); font-weight:600; }
.dc-step.on .dc-step-idx { background:var(--dc-accent-fill); color:var(--dc-accent-fg); }
.dc-step.done { color:var(--dc-mut); }
.dc-step.done .dc-step-idx { background:var(--dsw-alias-state-success-tertiary,#22c55e22); color:var(--dc-green); }
.dc-step-sep { width:14px; height:1px; background:var(--dc-bd2); flex:0 0 auto; }
.dc-steps-right { display:flex; align-items:center; gap:8px; flex:0 0 auto; font-size:11.5px; color:var(--dc-dim); }

.dc-workspace { flex:1 1 auto; min-height:0; display:flex; }
.dc-main { flex:1 1 auto; min-width:0; min-height:0; overflow-y:auto; padding:20px 24px 28px; }
.dc-main-inner { width:100%; max-width:940px; margin:0 auto; }
.dc-main-inner.wide { max-width:1040px; }
/* 大纲/成文视图是整列布局（review.js 自己内部滚动 + 底部操作条），
   所以给 .dc-main 的剩余高度，避免外层再滚一层。 */
.dc-main-inner.fill { height:100%; display:flex; flex-direction:column; min-height:0; }
.dc-main-inner.fill > * { flex:1 1 auto; min-height:0; }
.dc-dock { width:346px; flex:0 0 346px; min-height:0; border-left:1px solid var(--dc-bd);
  display:flex; background:var(--dc-bg2); }
.dc-dock > * { flex:1 1 auto; min-width:0; min-height:0; }
.dc-emptyworkspace { flex:1 1 auto; min-height:0; overflow-y:auto; }
.dc-loading { display:flex; align-items:center; justify-content:center; gap:10px;
  padding:54px 20px; color:var(--dc-dim); font-size:13px; }
.dc-errorbar { flex:0 0 auto; display:flex; align-items:flex-start; gap:8px; margin:10px 20px 0;
  padding:9px 11px; border-radius:10px; font-size:12.5px; line-height:1.55;
  border:1px solid var(--dsw-alias-state-error-primary,var(--dc-red));
  background:var(--dsw-alias-state-error-secondary,rgba(242,90,90,.13));
  color:var(--dc-red); }
.dc-errorbar-text { flex:1 1 auto; min-width:0; word-break:break-word; }
.dc-errorbar .dc-iconbtn { color:var(--dc-red); }

/* ── 按钮 ── */
.dc-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px;
  border:1px solid var(--dc-bd); background:var(--dc-sf2); color:var(--dc-fg);
  border-radius:9px; padding:6px 13px; font-size:12.5px; font-weight:500; line-height:1.35;
  white-space:nowrap; cursor:pointer; user-select:none;
  transition:background .14s,border-color .14s,color .14s,transform .06s,opacity .14s; }
.dc-btn:hover:not(:disabled) { background:var(--dc-hover); border-color:var(--dc-bd2); }
.dc-btn:active:not(:disabled) { transform:translateY(1px); }
.dc-btn:disabled { opacity:.45; cursor:not-allowed; }
.dc-btn:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dc-accent)); outline-offset:2px; }
.dc-btn.primary { background:var(--dc-accent-fill); border-color:transparent; color:var(--dc-accent-fg); font-weight:600;
  box-shadow:0 1px 2px rgba(0,0,0,.14); }
.dc-btn.primary:hover:not(:disabled) { background:var(--dc-accent-fill); filter:brightness(1.07); }
.dc-btn.ghost { background:transparent; border-color:transparent; color:var(--dc-mut); }
.dc-btn.ghost:hover:not(:disabled) { background:var(--dc-hover); color:var(--dc-fg); border-color:transparent; }
.dc-btn.subtle { background:var(--dc-chip); border-color:transparent; }
.dc-btn.subtle:hover:not(:disabled) { background:var(--dc-hover); border-color:transparent; }
.dc-btn.danger { color:var(--dc-red); border-color:var(--dc-bd); background:transparent; }
.dc-btn.danger:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover-danger,rgba(242,90,90,.12));
  border-color:var(--dc-red); }
.dc-btn.sm { padding:3px 9px; font-size:11.5px; border-radius:7px; gap:5px; }
.dc-btn.lg { padding:10px 20px; font-size:13.5px; border-radius:11px; gap:8px; }
.dc-btn.wide { width:100%; }
.dc-btn.primary .dc-spinner { border-color:rgba(255,255,255,.35); border-top-color:#fff; }
.dc-btn-label { display:inline-flex; align-items:center; gap:6px; min-width:0; }
.dc-iconbtn { display:inline-grid; place-items:center; width:30px; height:30px; padding:0;
  border:1px solid transparent; border-radius:8px; background:transparent; color:var(--dc-mut);
  cursor:pointer; flex:0 0 auto; transition:background .14s,color .14s,border-color .14s; }
.dc-iconbtn:hover:not(:disabled) { background:var(--dc-hover); color:var(--dc-fg); }
.dc-iconbtn:disabled { opacity:.4; cursor:not-allowed; }
.dc-iconbtn:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dc-accent)); outline-offset:1px; }
.dc-iconbtn.sm { width:24px; height:24px; border-radius:6px; }
.dc-iconbtn.bordered { border-color:var(--dc-bd); background:var(--dc-sf2); }
.dc-iconbtn.bordered:hover:not(:disabled) { border-color:var(--dc-bd2); }
.dc-iconbtn.danger:hover:not(:disabled) { color:var(--dc-red);
  background:var(--dsw-alias-interactive-bg-hover-danger,rgba(242,90,90,.12)); }

/* ── 表单 ── */
.dc-field { display:flex; flex-direction:column; gap:6px; min-width:0; }
.dc-field-row { display:flex; align-items:center; gap:8px; min-height:18px; }
.dc-field-label { font-size:12.5px; font-weight:600; color:var(--dc-fg); }
.dc-field-right { margin-left:auto; font-size:11px; color:var(--dc-dim); }
.dc-field-hint { font-size:11.5px; color:var(--dc-dim); line-height:1.55; }
.dc-field-error { font-size:11.5px; color:var(--dc-red); line-height:1.55; }
.dc-req { color:var(--dc-red); margin-left:2px; }
.dc-input, .dc-textarea, .dc-select { width:100%; min-width:0; background:var(--dc-sf);
  color:var(--dc-fg); border:1px solid var(--dc-bd); border-radius:9px; padding:8px 11px;
  font-size:12.5px; line-height:1.5; transition:border-color .14s,box-shadow .14s,background .14s; }
.dc-input::placeholder, .dc-textarea::placeholder { color:var(--dc-cap); }
.dc-input:hover, .dc-textarea:hover, .dc-select:hover { border-color:var(--dc-bd2); }
.dc-input:focus, .dc-textarea:focus, .dc-select:focus { outline:none; border-color:var(--dc-accent);
  box-shadow:0 0 0 3px var(--dsw-focus-ring-color,rgba(122,170,255,.18)); }
.dc-input:disabled, .dc-textarea:disabled, .dc-select:disabled { opacity:.55; cursor:not-allowed; }
.dc-input.sm { padding:6px 9px; font-size:12px; }
.dc-textarea { resize:vertical; min-height:104px; }
.dc-select { appearance:none; -webkit-appearance:none; padding-right:30px; cursor:pointer;
  background-image:url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238a9099' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 9l7 7 7-7'/%3E%3C/svg%3E");
  background-repeat:no-repeat; background-position:right 10px center; }
.dc-select option, .dc-select optgroup { background:var(--dc-bg2); color:var(--dc-fg); }
.dc-fields-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(158px,1fr)); gap:12px; }
.dc-counter { font-size:11px; color:var(--dc-cap); text-align:right; font-variant-numeric:tabular-nums; }

/* ── 徽标 / chip / 分隔 ── */
.dc-badge { display:inline-flex; align-items:center; gap:4px; padding:1px 8px; border-radius:999px;
  border:1px solid var(--dc-bd); background:var(--dc-chip); color:var(--dc-mut);
  font-size:10.5px; font-weight:500; line-height:1.7; white-space:nowrap; }
.dc-badge.info { background:var(--dsw-alias-state-business-tertiary,rgba(122,170,255,.14));
  color:var(--dc-accent); border-color:transparent; }
.dc-badge.success { background:var(--dsw-alias-state-success-tertiary,rgba(34,197,94,.14));
  color:var(--dc-green); border-color:transparent; }
.dc-badge.warn { background:var(--dsw-alias-state-warn-tertiary,rgba(245,158,11,.14));
  color:var(--dc-warn); border-color:transparent; }
.dc-badge.danger { background:var(--dsw-alias-state-error-secondary,rgba(242,90,90,.14));
  color:var(--dc-red); border-color:transparent; }
.dc-badge.accent { background:var(--dc-accent-fill); color:var(--dc-accent-fg); border-color:transparent; }
.dc-badge .dc-dot { width:5px; height:5px; border-radius:50%; background:currentColor; flex:0 0 auto; }
.dc-chip { display:inline-flex; align-items:center; gap:2px; max-width:100%;
  border:1px solid var(--dc-bd); border-radius:999px; background:var(--dc-sf);
  color:var(--dc-mut); font-size:12px; line-height:1.6; vertical-align:middle; }
.dc-chip.static { padding:3px 10px; cursor:default; }
.dc-chip-hit { display:inline-flex; align-items:center; gap:5px; min-width:0; padding:3px 10px;
  border:0; border-radius:999px; background:none; color:inherit; font:inherit; cursor:pointer; }
.dc-chip-hit:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dc-accent)); outline-offset:-1px; }
.dc-chip-hit > span, .dc-chip.static > span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
button.dc-chip-hit:hover { color:var(--dc-accent); }
.dc-chip:hover { border-color:var(--dc-bd2); }
.dc-chip.on { border-color:var(--dc-accent); color:var(--dc-accent);
  background:var(--dsw-alias-state-business-tertiary,rgba(122,170,255,.14)); }
.dc-chip.has-x .dc-chip-hit { padding-right:2px; }
.dc-chip-x { display:inline-grid; place-items:center; width:18px; height:18px; margin-right:2px;
  border:0; border-radius:50%; background:none; color:var(--dc-dim); cursor:pointer; padding:0; }
.dc-chip-x:hover { background:var(--dc-hover); color:var(--dc-red); }
.dc-chips { display:flex; flex-wrap:wrap; gap:6px; }
.dc-divider { height:1px; background:var(--dc-bd); border:0; margin:14px 0; }

/* ── 开关 ── */
.dc-switch { display:flex; align-items:flex-start; gap:10px; padding:0; border:0; background:none;
  color:inherit; font:inherit; text-align:left; cursor:pointer; user-select:none; min-width:0; }
.dc-switch:disabled { opacity:.5; cursor:not-allowed; }
.dc-switch:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dc-accent)); outline-offset:3px; border-radius:8px; }
.dc-switch-track { position:relative; flex:0 0 auto; width:36px; height:20px; margin-top:1px;
  border-radius:999px; background:var(--dc-chip); border:1px solid var(--dc-bd2);
  transition:background .16s,border-color .16s; }
.dc-switch-knob { position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%;
  background:var(--dc-dim); transition:transform .16s,background .16s; }
.dc-switch.on .dc-switch-track { background:var(--dc-accent-fill); border-color:transparent; }
.dc-switch.on .dc-switch-knob { transform:translateX(16px); background:var(--dc-accent-fg); }
.dc-switch-text { display:flex; flex-direction:column; gap:2px; min-width:0; }
.dc-switch-label { font-size:12.5px; font-weight:600; color:var(--dc-fg); }
.dc-switch-desc { font-size:11.5px; color:var(--dc-dim); line-height:1.55; }

/* ── 加载 / 进度 ── */
.dc-spinner { display:inline-block; flex:0 0 auto; border-radius:50%;
  border:2px solid var(--dc-chip); border-top-color:var(--dc-accent); animation:dc-spin .72s linear infinite; }
@keyframes dc-spin { to { transform:rotate(360deg); } }
.dc-skel { background:linear-gradient(90deg,var(--dc-chip) 0%,var(--dc-hover) 45%,var(--dc-chip) 90%);
  background-size:220% 100%; border-radius:6px; animation:dc-shimmer 1.5s linear infinite; }
@keyframes dc-shimmer { to { background-position:-220% 0; } }
.dc-progress { display:flex; flex-direction:column; gap:6px; width:100%; min-width:0; }
.dc-progress-head { display:flex; align-items:center; gap:7px; min-width:0; font-size:12px; color:var(--dc-mut); }
.dc-progress-phase { font-weight:600; color:var(--dc-fg); white-space:nowrap; }
.dc-progress-msg { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dc-dim); }
.dc-progress-pct { margin-left:auto; font-size:11px; color:var(--dc-dim); font-variant-numeric:tabular-nums; }
.dc-progress-track { height:6px; border-radius:999px; background:var(--dc-chip); overflow:hidden; }
.dc-progress-fill { height:100%; border-radius:999px;
  background:linear-gradient(90deg,var(--dc-accent),var(--dc-green)); transition:width .45s ease; }
.dc-progress.indeterminate .dc-progress-fill { width:34%; animation:dc-indet 1.2s ease-in-out infinite; }
@keyframes dc-indet { 0% { transform:translateX(-100%); } 100% { transform:translateX(320%); } }
.dc-progress.error .dc-progress-fill { background:var(--dc-red); }
.dc-progress.done .dc-progress-fill { background:var(--dc-green); }
.dc-progress-err { font-size:11.5px; color:var(--dc-red); word-break:break-word; }
@media (prefers-reduced-motion:reduce) {
  .dc-spinner { animation-duration:2.4s; }
  .dc-skel, .dc-progress.indeterminate .dc-progress-fill { animation:none; }
  .dc-progress.indeterminate .dc-progress-fill { width:100%; opacity:.5; }
}

/* ── 空态 / 卡片 / 折叠 ── */
.dc-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:9px;
  padding:36px 20px; text-align:center; color:var(--dc-dim); }
.dc-empty-icon { width:42px; height:42px; border-radius:13px; display:grid; place-items:center;
  background:var(--dc-chip); color:var(--dc-mut); }
.dc-empty-title { font-size:14px; font-weight:600; color:var(--dc-fg); }
.dc-empty-desc { font-size:12px; line-height:1.65; max-width:48ch; }
.dc-empty-action { margin-top:4px; display:flex; gap:8px; flex-wrap:wrap; justify-content:center; }
.dc-card { border:1px solid var(--dc-bd); border-radius:var(--dc-radius); background:var(--dc-sf);
  overflow:hidden; }
.dc-card-head { display:flex; align-items:flex-start; gap:10px; padding:14px 16px 0; }
.dc-card-icon { width:27px; height:27px; border-radius:8px; display:grid; place-items:center;
  background:var(--dc-chip); color:var(--dc-accent); flex:0 0 auto; margin-top:1px; }
.dc-card-headtext { flex:1 1 auto; min-width:0; }
.dc-card-title { display:flex; align-items:center; gap:8px; font-size:13.5px; font-weight:650; color:var(--dc-fg); }
.dc-card-desc { margin-top:3px; font-size:11.5px; color:var(--dc-dim); line-height:1.6; }
.dc-card-actions { display:flex; align-items:center; gap:6px; flex:0 0 auto; }
.dc-card-body { padding:12px 16px 16px; }
.dc-collapse { border:1px solid var(--dc-bd); border-radius:10px; background:var(--dc-sf); overflow:hidden; }
.dc-collapse-head { display:flex; align-items:center; gap:7px; width:100%; padding:9px 12px;
  border:0; background:none; color:var(--dc-fg); font:inherit; font-size:12.5px; font-weight:600;
  text-align:left; cursor:pointer; }
.dc-collapse-head:hover { background:var(--dc-hover); }
.dc-collapse-head:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dc-accent)); outline-offset:-2px; }
.dc-collapse-chev { display:inline-flex; color:var(--dc-dim); }
.dc-collapse-title { flex:1 1 auto; min-width:0; }
.dc-collapse-right { flex:0 0 auto; font-size:11px; font-weight:400; color:var(--dc-dim); }
.dc-collapse-body { border-top:1px solid var(--dc-bd); padding:11px 12px; }

/* ── 弹层 / 提示 ── */
.dc-overlay { position:fixed; inset:0; z-index:2147483000; display:flex; align-items:center;
  justify-content:center; padding:24px; background:var(--dsw-alias-bg-mask-2,rgba(0,0,0,.48)); }
.dc-modal { display:flex; flex-direction:column; width:min(470px,100%); max-height:84vh;
  background:var(--dc-bg2); border:1px solid var(--dc-bd2); border-radius:14px;
  box-shadow:var(--dc-shadow); overflow:hidden; animation:dc-pop .16s ease-out; }
@keyframes dc-pop { from { opacity:0; transform:translateY(6px) scale(.99); } to { opacity:1; transform:none; } }
.dc-modal-head { display:flex; align-items:center; gap:10px; padding:13px 16px 12px;
  border-bottom:1px solid var(--dc-bd); }
.dc-modal-title { flex:1 1 auto; min-width:0; font-size:14.5px; font-weight:650; }
.dc-modal-body { padding:15px 16px; overflow-y:auto; font-size:12.5px; color:var(--dc-mut); line-height:1.7; }
.dc-modal-foot { display:flex; justify-content:flex-end; gap:8px; padding:11px 16px;
  border-top:1px solid var(--dc-bd); }
.dc-toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); z-index:2147483001;
  display:flex; align-items:center; gap:9px; min-width:220px; max-width:min(540px,92vw);
  padding:9px 10px 9px 13px; border-radius:12px;
  background:var(--dsw-alias-toast-bg,var(--dc-bg3)); color:var(--dsw-alias-toast-label,var(--dc-fg));
  border:1px solid var(--dc-bd2); box-shadow:var(--dc-shadow); font-size:12.5px;
  animation:dc-toast-in .18s ease-out; }
@keyframes dc-toast-in { from { opacity:0; transform:translate(-50%,8px); } to { opacity:1; transform:translate(-50%,0); } }
.dc-toast-icon { flex:0 0 auto; display:inline-flex; color:var(--dc-mut); }
.dc-toast.success .dc-toast-icon { color:var(--dc-green); }
.dc-toast.danger .dc-toast-icon { color:var(--dc-red); }
.dc-toast.info .dc-toast-icon { color:var(--dc-accent); }
.dc-toast-text { flex:1 1 auto; min-width:0; line-height:1.5; word-break:break-word; }

/* ── 页面骨架 ── */
.dc-page { display:flex; flex-direction:column; gap:14px; width:100%; max-width:940px; margin:0 auto; }
.dc-page.wide { max-width:1040px; }
.dc-page-head { display:flex; align-items:flex-start; gap:12px; flex-wrap:wrap; }
.dc-page-title { font-size:19px; font-weight:680; letter-spacing:-.01em; color:var(--dc-fg); }
.dc-page-sub { margin-top:3px; font-size:12px; color:var(--dc-dim); line-height:1.65; max-width:74ch; }
.dc-page-head-actions { margin-left:auto; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.dc-save-hint { display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--dc-dim); }
.dc-save-hint.ok { color:var(--dc-green); }
.dc-save-err { display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--dc-red); }
.dc-hint { font-size:11.5px; color:var(--dc-dim); line-height:1.6; }
.dc-hint.warn { color:var(--dc-warn); }
.dc-hint.error { color:var(--dc-red); }
.dc-mono { font-family:var(--ds-font-family-code,var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace)); }

/* ── 模板选择 ── */
.dc-tpl-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(202px,1fr)); gap:10px; }
.dc-tpl { position:relative; display:flex; flex-direction:column; gap:6px; min-height:104px;
  padding:12px; border:1px solid var(--dc-bd); border-radius:11px; background:var(--dc-bg);
  color:inherit; font:inherit; text-align:left; cursor:pointer;
  transition:border-color .14s,background .14s,transform .1s; }
.dc-tpl:hover:not(:disabled) { border-color:var(--dc-bd2); background:var(--dc-hover); transform:translateY(-1px); }
.dc-tpl:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dc-accent)); outline-offset:1px; }
.dc-tpl:disabled { opacity:.6; cursor:not-allowed; }
.dc-tpl.on { border-color:var(--dc-accent); background:var(--dsw-alias-state-business-tertiary,rgba(122,170,255,.1));
  box-shadow:0 0 0 1px var(--dc-accent) inset; }
.dc-tpl-top { display:flex; align-items:center; gap:7px; min-width:0; }
.dc-tpl-name { flex:1 1 auto; min-width:0; font-size:13px; font-weight:600; color:var(--dc-fg);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dc-tpl-cat { flex:0 0 auto; font-size:10px; color:var(--dc-dim); background:var(--dc-chip);
  border-radius:999px; padding:0 6px; line-height:1.7; }
.dc-tpl-desc { font-size:11.5px; color:var(--dc-dim); line-height:1.55;
  overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
.dc-tpl-foot { display:flex; align-items:center; gap:5px; margin-top:auto;
  font-size:10.5px; color:var(--dc-cap); }
.dc-tpl-check { display:inline-grid; place-items:center; width:16px; height:16px; border-radius:50%;
  background:var(--dc-accent-fill); color:var(--dc-accent-fg); }
.dc-tpl-preview { margin-top:10px; padding:12px 14px; border:1px solid var(--dc-bd);
  border-radius:10px; background:var(--dc-bg); max-height:252px; overflow-y:auto; }
.dc-tpl-preview-head { display:flex; align-items:center; gap:7px; flex-wrap:wrap;
  font-size:11.5px; font-weight:600; color:var(--dc-mut); margin-bottom:9px; }
.dc-tpl-preview-head .dc-hint { font-weight:400; }
.dc-skel-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:7px; }
.dc-skel-item { display:flex; align-items:baseline; gap:8px; min-width:0; }
.dc-skel-idx { flex:0 0 auto; width:17px; height:17px; border-radius:5px; display:grid; place-items:center;
  background:var(--dc-chip); color:var(--dc-dim); font-size:10px; font-variant-numeric:tabular-nums; }
.dc-skel-h { font-size:12px; font-weight:500; color:var(--dc-mut); }
.dc-skel-hint { font-size:11px; color:var(--dc-cap); min-width:0;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dc-free-hints { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:7px;
  font-size:11.5px; color:var(--dc-dim); line-height:1.6; }
.dc-free-hints li { display:flex; gap:7px; }
.dc-free-hints li::before { content:""; width:4px; height:4px; border-radius:50%;
  background:var(--dc-accent); margin-top:7px; flex:0 0 auto; }

/* ── 参考文档 ── */
.dc-drop { display:flex; flex-direction:column; align-items:center; gap:6px; padding:18px;
  border:1.5px dashed var(--dc-bd2); border-radius:11px; background:var(--dc-bg);
  text-align:center; cursor:pointer; transition:border-color .14s,background .14s; }
.dc-drop:hover, .dc-drop.over { border-color:var(--dc-accent);
  background:var(--dsw-alias-state-business-tertiary,rgba(122,170,255,.1)); }
.dc-drop:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dc-accent)); outline-offset:2px; }
.dc-drop-icon { color:var(--dc-mut); display:inline-flex; }
.dc-drop-title { font-size:12.5px; font-weight:500; color:var(--dc-fg); }
.dc-drop-hint { font-size:11px; color:var(--dc-dim); line-height:1.6; }
.dc-drop input[type="file"] { display:none; }
.dc-refs-actions { display:flex; align-items:center; justify-content:center; gap:8px; margin-top:9px; flex-wrap:wrap; }
.dc-ref-list { display:flex; flex-direction:column; gap:8px; margin-top:12px; }
.dc-ref { display:flex; align-items:flex-start; gap:9px; padding:9px 10px;
  border:1px solid var(--dc-bd); border-radius:10px; background:var(--dc-bg); }
.dc-ref.err { border-color:var(--dsw-alias-state-error-primary,var(--dc-red)); }
.dc-ref-icon { flex:0 0 auto; width:28px; height:28px; border-radius:8px; display:grid; place-items:center;
  background:var(--dc-chip); color:var(--dc-mut); margin-top:1px; }
.dc-ref.err .dc-ref-icon { color:var(--dc-red); }
.dc-ref-main { flex:1 1 auto; min-width:0; }
.dc-ref-name { font-size:12px; font-weight:500; color:var(--dc-fg); overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.dc-ref-meta { display:flex; align-items:center; gap:5px; flex-wrap:wrap; margin-top:2px;
  font-size:10.5px; color:var(--dc-dim); }
.dc-ref-warn { color:var(--dc-warn); }
.dc-ref-err { margin-top:3px; font-size:11px; color:var(--dc-red); line-height:1.5; word-break:break-word; }
.dc-refs-summary { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
  font-size:11.5px; color:var(--dc-dim); }

/* ── 红线 ── */
.dc-rl-list { display:flex; flex-direction:column; gap:6px; }
.dc-rl { display:flex; align-items:flex-start; gap:9px; padding:8px 10px;
  border:1px solid var(--dc-bd); border-radius:9px; background:var(--dc-bg); cursor:pointer; }
.dc-rl:hover { border-color:var(--dc-bd2); }
.dc-rl input[type="checkbox"] { flex:0 0 auto; width:14px; height:14px; margin:2px 0 0;
  accent-color:var(--dc-accent-fill); cursor:pointer; }
.dc-rl-text { flex:1 1 auto; min-width:0; font-size:12px; line-height:1.55; color:var(--dc-fg);
  word-break:break-word; }
.dc-rl-tag { flex:0 0 auto; margin-top:1px; font-size:10px; color:var(--dc-cap);
  background:var(--dc-chip); border-radius:999px; padding:0 6px; line-height:1.7; }
.dc-rl-tag.custom { color:var(--dc-accent); }
.dc-rl-removed { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:8px; }
.dc-rl-add { display:flex; align-items:center; gap:7px; margin-top:10px; }
.dc-rl-add .dc-input { flex:1 1 auto; }
.dc-rl-suggest { margin-top:12px; display:flex; flex-direction:column; gap:6px; }

/* ── 生成选项 ── */
.dc-opt-row { display:flex; flex-direction:column; gap:12px; }
.dc-opt-block { display:flex; flex-direction:column; gap:10px; }
.dc-note { padding:9px 11px; border-radius:9px; background:var(--dc-chip);
  font-size:11.5px; color:var(--dc-mut); line-height:1.6; }

/* ── 底部操作栏（sticky）── */
.dc-footer { position:sticky; bottom:0; z-index:6; display:flex; align-items:center; gap:14px;
  margin-top:4px; padding:11px 14px; border:1px solid var(--dc-bd2); border-radius:12px;
  background:var(--dsw-alias-bg-overlay,var(--dc-bg2)); box-shadow:var(--dc-shadow); }
.dc-footer-info { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:3px; }
.dc-footer-hint { font-size:11.5px; color:var(--dc-dim); line-height:1.5; }
.dc-footer-hint b { color:var(--dc-fg); font-weight:600; }
.dc-footer .dc-btn.lg { flex:0 0 auto; }
.dc-footer .dc-progress { max-width:420px; }

/* ── 空态首页（模板展示）── */
.dc-hero { width:100%; max-width:960px; margin:0 auto; padding:24px 24px 36px;
  display:flex; flex-direction:column; gap:20px; }
.dc-hero-card { display:flex; flex-direction:column; gap:9px; padding:22px; border-radius:16px;
  border:1px solid var(--dc-bd);
  background:linear-gradient(135deg,var(--dc-sf) 0%,var(--dc-bg2) 62%,var(--dc-sf2) 100%); }
.dc-hero-badge { display:inline-flex; align-items:center; gap:5px; align-self:flex-start;
  padding:2px 9px; border-radius:999px; font-size:11px; color:var(--dc-accent);
  background:var(--dsw-alias-state-business-tertiary,rgba(122,170,255,.14)); }
.dc-hero-title { font-size:22px; font-weight:700; letter-spacing:-.02em; color:var(--dc-fg); }
.dc-hero-sub { font-size:12.5px; color:var(--dc-mut); line-height:1.75; max-width:66ch; }
.dc-hero-steps { display:flex; gap:20px; flex-wrap:wrap; margin-top:4px; }
.dc-hero-step { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--dc-mut); }
.dc-hero-step-n { display:inline-grid; place-items:center; width:20px; height:20px; border-radius:50%;
  background:var(--dc-chip); color:var(--dc-accent); font-size:11px; font-weight:600; }
.dc-hero-section { display:flex; flex-direction:column; gap:10px; }
.dc-hero-section-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.dc-hero-section-title { font-size:13.5px; font-weight:650; color:var(--dc-fg); }
.dc-hero-section-head .dc-btn { margin-left:auto; }

/* ── 窄屏 ── */
@media (max-width:1100px) {
  .dc-rail { display:none; }
  .dc-rail-toggle { display:none; }
}
@media (max-width:1000px) {
  .dc-workspace { flex-direction:column; overflow-y:auto; }
  .dc-main { overflow:visible; padding:16px 16px 20px; }
  .dc-main-inner.fill { height:auto; }
  .dc-dock { width:auto; flex:0 0 auto; height:380px; border-left:0; border-top:1px solid var(--dc-bd); }
  .dc-footer { position:static; }
  .dc-header-count, .dc-brand-sub { display:none; }
  .dc-header-name { max-width:30ch; }
}
@media (max-width:720px) {
  .dc-header { padding:8px 12px; gap:8px; }
  .dc-stepsbar { padding:6px 12px; }
  .dc-steps-right { display:none; }
  .dc-errorbar { margin:8px 12px 0; }
  .dc-hero { padding:16px 14px 24px; }
  .dc-page-head-actions { margin-left:0; }
}
`;

// ── atoms: Button / IconButton / Badge / Toggle / Select / Field / TextInput / TextArea ──

function Button({
	children,
	variant = "default",
	size = "md",
	icon,
	trailingIcon,
	loading = false,
	disabled = false,
	onClick,
	type = "button",
	title,
	wide = false,
	className,
	...rest
}) {
	return h(
		"button",
		{
			...rest,
			type,
			className: cx("dc-btn", variant !== "default" && variant, size !== "md" && size, wide && "wide", className),
			onClick,
			disabled: disabled || loading,
			title,
			"aria-busy": loading || undefined,
		},
		loading ? h(Spinner, { size: 13 }) : icon ?? null,
		children === undefined || children === null ? null : h("span", { className: "dc-btn-label" }, children),
		trailingIcon ?? null,
	);
}

function IconButton({
	icon,
	label,
	title,
	onClick,
	disabled = false,
	variant = "ghost",
	size = "md",
	className,
	children,
	...rest
}) {
	return h(
		"button",
		{
			...rest,
			type: "button",
			className: cx("dc-iconbtn", variant !== "ghost" && variant, size === "sm" && "sm", className),
			onClick,
			disabled,
			title: title ?? label,
			"aria-label": label,
		},
		icon ?? children ?? null,
	);
}

function Badge({ children, tone = "neutral", dot = false, title, className }) {
	return h(
		"span",
		{ className: cx("dc-badge", tone !== "neutral" && tone, className), title },
		dot ? h("span", { className: "dc-dot" }) : null,
		children,
	);
}

function Toggle({ checked = false, onChange, label, description, disabled = false, className }) {
	return h(
		"button",
		{
			type: "button",
			role: "switch",
			"aria-checked": checked ? "true" : "false",
			"aria-disabled": disabled || undefined,
			disabled,
			className: cx("dc-switch", checked && "on", className),
			onClick: () => {
				if (!disabled) onChange?.(!checked);
			},
		},
		h("span", { className: "dc-switch-track" }, h("span", { className: "dc-switch-knob" })),
		label || description
			? h(
					"span",
					{ className: "dc-switch-text" },
					label ? h("span", { className: "dc-switch-label" }, label) : null,
					description ? h("span", { className: "dc-switch-desc" }, description) : null,
				)
			: null,
	);
}

function Select({ value, onChange, options = [], placeholder, disabled = false, className, id, name, label, ariaLabel }) {
	return h(
		"select",
		{
			id,
			name,
			value: value ?? "",
			onChange,
			disabled,
			className: cx("dc-select", className),
			"aria-label": ariaLabel ?? (typeof label === "string" ? label : undefined),
		},
		placeholder !== undefined ? h("option", { value: "" }, placeholder) : null,
		(options ?? []).map((option, index) => {
			if (option && Array.isArray(option.options)) {
				return h(
					"optgroup",
					{ key: option.group ?? `group-${index}`, label: option.group ?? "" },
					option.options.map((child, childIndex) =>
						h(
							"option",
							{ key: child.value ?? childIndex, value: child.value ?? "", disabled: child.disabled },
							child.label ?? String(child.value ?? ""),
						),
					),
				);
			}
			if (typeof option === "string") return h("option", { key: option, value: option }, option);
			return h(
				"option",
				{ key: option?.value ?? `option-${index}`, value: option?.value ?? "", disabled: option?.disabled },
				option?.label ?? String(option?.value ?? ""),
			);
		}),
	);
}

function Field({ label, hint, error, required = false, htmlFor, right, children, className }) {
	return h(
		"div",
		{ className: cx("dc-field", className) },
		label
			? h(
					"div",
					{ className: "dc-field-row" },
					h(
						"label",
						{ className: "dc-field-label", htmlFor },
						label,
						required ? h("span", { className: "dc-req", "aria-hidden": "true" }, "*") : null,
					),
					right ? h("span", { className: "dc-field-right" }, right) : null,
				)
			: null,
		children,
		error ? h("div", { className: "dc-field-error", role: "alert" }, error) : hint ? h("div", { className: "dc-field-hint" }, hint) : null,
	);
}

function TextInput({
	value,
	onChange,
	placeholder,
	type = "text",
	disabled = false,
	id,
	ariaLabel,
	onBlur,
	onKeyDown,
	onFocus,
	autoFocus = false,
	maxLength,
	className,
	spellCheck = false,
}) {
	return h("input", {
		id,
		type,
		className: cx("dc-input", className),
		value: value ?? "",
		onChange,
		placeholder,
		disabled,
		"aria-label": ariaLabel,
		onBlur,
		onKeyDown,
		onFocus,
		autoFocus,
		maxLength,
		spellCheck,
	});
}

function TextArea({
	value,
	onChange,
	placeholder,
	rows = 5,
	disabled = false,
	id,
	ariaLabel,
	onBlur,
	onKeyDown,
	maxLength,
	className,
	spellCheck = false,
}) {
	return h("textarea", {
		id,
		className: cx("dc-textarea", className),
		value: value ?? "",
		onChange,
		placeholder,
		rows,
		disabled,
		"aria-label": ariaLabel,
		onBlur,
		onKeyDown,
		maxLength,
		spellCheck,
	});
}

// ── atoms: feedback / structure ─────────────────────────────────────────────

function Spinner({ size = 14, label = "加载中", className }) {
	return h("span", {
		className: cx("dc-spinner", className),
		style: { width: size, height: size },
		role: "status",
		"aria-label": label,
	});
}

function Skeleton({ width = "100%", height = 10, radius, className }) {
	return h("div", {
		className: cx("dc-skel", className),
		style: { width, height, borderRadius: radius },
		"aria-hidden": "true",
	});
}

function JobProgress({ job, compact = false, label, className }) {
	if (!job) return null;
	const status = job.status ?? "running";
	const progress = clamp(job.progress ?? 0, 0, 100);
	const indeterminate = status === "running" && (job.progress === undefined || job.progress === null || progress <= 0);
	const phase = job.phase || label || "处理中";
	const message = job.message || (status === "running" ? "正在处理…" : status === "done" ? "已完成" : "已中断");
	const icon =
		status === "running"
			? h(Spinner, { size: 13 })
			: status === "done"
				? h(DcIcon, { name: "check-circle", size: 14 })
				: h(DcIcon, { name: "alert", size: 14 });
	return h(
		"div",
		{
			className: cx("dc-progress", compact && "compact", status === "failed" && "error", status === "done" && "done", indeterminate && "indeterminate", className),
			role: "status",
			"aria-live": "polite",
		},
		h(
			"div",
			{ className: "dc-progress-head" },
			icon,
			compact ? null : h("span", { className: "dc-progress-phase" }, phase),
			h("span", { className: "dc-progress-msg" }, compact ? `${phase} · ${message}` : message),
			h("span", { className: "dc-progress-pct" }, status === "running" ? `${Math.round(progress)}%` : ""),
		),
		h("div", { className: "dc-progress-track" }, h("div", { className: "dc-progress-fill", style: indeterminate ? undefined : { width: `${progress}%` } })),
		job.error ? h("div", { className: "dc-progress-err" }, job.error) : null,
	);
}

function EmptyState({ icon, title, description, action, children, className }) {
	return h(
		"div",
		{ className: cx("dc-empty", className) },
		icon ? h("div", { className: "dc-empty-icon" }, icon) : null,
		title ? h("div", { className: "dc-empty-title" }, title) : null,
		description ? h("div", { className: "dc-empty-desc" }, description) : null,
		action ? h("div", { className: "dc-empty-action" }, action) : null,
		children ?? null,
	);
}

function SectionCard({ title, description, icon, actions, children, className, bodyClassName }) {
	return h(
		"section",
		{ className: cx("dc-card", className) },
		title || description || actions
			? h(
					"div",
					{ className: "dc-card-head" },
					icon ? h("div", { className: "dc-card-icon" }, icon) : null,
					h(
						"div",
						{ className: "dc-card-headtext" },
						title ? h("div", { className: "dc-card-title" }, title) : null,
						description ? h("div", { className: "dc-card-desc" }, description) : null,
					),
					actions ? h("div", { className: "dc-card-actions" }, actions) : null,
				)
			: null,
		h("div", { className: cx("dc-card-body", bodyClassName) }, children),
	);
}

function Chip({ children, onClick, onRemove, active = false, title, tone, icon, className }) {
	const interactive = onClick !== undefined || onRemove !== undefined;
	if (!interactive) {
		return h(
			"span",
			{ className: cx("dc-chip static", tone, className), title },
			icon ?? null,
			h("span", null, children),
		);
	}
	return h(
		"span",
		{ className: cx("dc-chip", active && "on", tone, onRemove !== undefined && "has-x", className), title },
		onClick !== undefined
			? h("button", { type: "button", className: "dc-chip-hit", onClick }, icon ?? null, h("span", null, children))
			: h("span", { className: "dc-chip-hit" }, icon ?? null, h("span", null, children)),
		onRemove !== undefined
			? h(
					"button",
					{ type: "button", className: "dc-chip-x", onClick: onRemove, "aria-label": `移除 ${typeof children === "string" ? children : "此项"}` },
					h(DcIcon, { name: "x", size: 10 }),
				)
			: null,
	);
}

function Collapse({ title, children, defaultOpen = false, open: openProp, onToggle, right, icon, className }) {
	const [ownOpen, setOwnOpen] = useState(defaultOpen);
	const open = openProp === undefined ? ownOpen : openProp;
	const toggle = () => {
		if (openProp === undefined) setOwnOpen((value) => !value);
		onToggle?.();
	};
	return h(
		"div",
		{ className: cx("dc-collapse", open && "open", className) },
		h(
			"button",
			{
				type: "button",
				className: "dc-collapse-head",
				"aria-expanded": open ? "true" : "false",
				onClick: toggle,
			},
			h("span", { className: "dc-collapse-chev" }, h(DcIcon, { name: open ? "chevron-down" : "chevron-right", size: 13 })),
			icon ?? null,
			h("span", { className: "dc-collapse-title" }, title),
			right ? h("span", { className: "dc-collapse-right" }, right) : null,
		),
		open ? h("div", { className: "dc-collapse-body" }, children) : null,
	);
}

function Modal({ open, title, children, footer, onClose, width, className, closeLabel = "关闭" }) {
	useEffect(() => {
		if (!open) return undefined;
		const onKeyDown = (event) => {
			if (event.key === "Escape") onClose?.();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);
	if (!open) return null;
	return h(
		"div",
		{
			className: "dc-overlay",
			onMouseDown: (event) => {
				if (event.target === event.currentTarget) onClose?.();
			},
		},
		h(
			"div",
			{
				className: cx("dc-modal", className),
				style: width ? { width } : undefined,
				role: "dialog",
				"aria-modal": "true",
				"aria-label": typeof title === "string" ? title : undefined,
			},
			h(
				"div",
				{ className: "dc-modal-head" },
				h("div", { className: "dc-modal-title" }, title),
				h(IconButton, { icon: h(DcIcon, { name: "x", size: 15 }), label: closeLabel, onClick: onClose }),
			),
			h("div", { className: "dc-modal-body" }, children),
			footer ? h("div", { className: "dc-modal-foot" }, footer) : null,
		),
	);
}

function Confirm({
	open = false,
	title = "确认操作",
	message,
	confirmText = "确定",
	cancelText = "取消",
	danger = false,
	busy = false,
	onConfirm,
	onCancel,
}) {
	return h(
		Modal,
		{
			open,
			title,
			onClose: busy ? undefined : onCancel,
			footer: [
				h(Button, { key: "cancel", onClick: onCancel, disabled: busy }, cancelText),
				h(Button, { key: "ok", variant: danger ? "danger" : "primary", onClick: onConfirm, loading: busy }, confirmText),
			],
		},
		typeof message === "string" ? h("div", null, message) : message,
	);
}

function Toast({ toast, onClose }) {
	if (!toast) return null;
	const kind = toast.kind === "error" ? "danger" : toast.kind === "success" ? "success" : "info";
	const iconName = toast.kind === "error" ? "alert" : toast.kind === "success" ? "check-circle" : "info";
	return h(
		"div",
		{ className: cx("dc-toast", kind), role: "status", "aria-live": "polite" },
		h("span", { className: "dc-toast-icon" }, h(DcIcon, { name: iconName, size: 16 })),
		h("div", { className: "dc-toast-text" }, toast.text ?? toast.message ?? ""),
		onClose
			? h(IconButton, { icon: h(DcIcon, { name: "x", size: 13 }), label: "关闭提示", size: "sm", onClick: onClose })
			: null,
	);
}

// ── ProjectRail：左侧项目列表 ────────────────────────────────────────────────

function ProjectRail({ projects = [], selectedId = null, onSelect, onCreate, onDelete, loading = false }) {
	const [query, setQuery] = useState("");
	const list = useMemo(() => {
		const all = Array.isArray(projects) ? projects : [];
		const keyword = query.trim().toLowerCase();
		if (keyword === "") return all;
		return all.filter((item) => String(item.name ?? "").toLowerCase().includes(keyword));
	}, [projects, query]);

	const body = loading
		? h(
				"div",
				{ className: "dc-rail-skel" },
				[0, 1, 2, 3].map((index) =>
					h(
						"div",
						{ key: index, style: { display: "flex", flexDirection: "column", gap: 6 } },
						h(Skeleton, { width: `${78 - index * 6}%`, height: 12 }),
						h(Skeleton, { width: "46%", height: 9 }),
					),
				),
			)
		: list.length === 0
			? h(
					"div",
					{ className: "dc-rail-empty" },
					query.trim() === "" ? "还没有文档项目。" : "没有匹配的项目。",
					query.trim() === "" ? h("div", { style: { marginTop: 6 } }, "点右上角 + 新建一个。") : null,
				)
			: list.map((item) => {
					const active = item.id === selectedId;
					const meta = dcStageMeta(item.stage);
					return h(
						"div",
						{ key: item.id, className: cx("dc-proj", active && "on") },
						h(
							"button",
							{
								type: "button",
								className: "dc-proj-main",
								onClick: () => onSelect?.(item.id),
								title: item.name ?? "",
								"aria-current": active ? "true" : undefined,
							},
							h("span", { className: "dc-proj-name" }, item.name || "未命名文档"),
							h(
								"span",
								{ className: "dc-proj-meta" },
								h(Badge, { tone: meta.tone }, meta.label),
								h("span", null, fmtTime(item.updatedAt)),
							),
							h(
								"span",
								{ className: "dc-proj-counts" },
								`参考 ${item.refsCount ?? 0} · 大纲 ${item.outlineCount ?? 0} · 成文 ${item.documentCount ?? 0}`,
							),
						),
						h(IconButton, {
							className: "dc-proj-del",
							size: "sm",
							icon: h(DcIcon, { name: "trash", size: 13 }),
							label: `删除文档「${item.name || "未命名文档"}」`,
							title: "删除文档",
							onClick: () => onDelete?.(item),
						}),
					);
				});

	return h(
		"aside",
		{ className: "dc-rail", "aria-label": "文档项目" },
		h(
			"div",
			{ className: "dc-rail-head" },
			h("div", { className: "dc-rail-title" }, "文档项目", h("span", { className: "dc-rail-count" }, String(projects?.length ?? 0))),
			h("span", { style: { flex: "1 1 auto" } }),
			h(IconButton, {
				variant: "bordered",
				size: "sm",
				icon: h(DcIcon, { name: "plus", size: 15 }),
				label: "新建文档项目",
				title: "新建文档（从模板开始）",
				onClick: onCreate,
			}),
		),
		h(
			"div",
			{ className: "dc-rail-search" },
			h(TextInput, {
				value: query,
				onChange: (event) => setQuery(event.target.value),
				placeholder: "搜索项目名称…",
				ariaLabel: "搜索项目",
				className: "sm",
			}),
		),
		h("div", { className: "dc-rail-list" }, body),
	);
}

// ── StepBar：准备资料 → 大纲 → 成文 ─────────────────────────────────────────

function StepBar({ step = 0, enabled = [true, false, false], onStep }) {
	const labels = ["准备资料", "大纲", "成文"];
	const hints = ["选模板、写主题、传参考", "生成并确认大纲", "生成成文并导出"];
	const enabledList = Array.isArray(enabled) ? enabled : [true, false, false];
	const current = clamp(step, 0, labels.length - 1);
	return h(
		"nav",
		{ className: "dc-stepsbar", "aria-label": "创作步骤" },
		h(
			"div",
			{ className: "dc-steps" },
			labels.map((label, index) => {
				const isCurrent = index === current;
				const isDone = index < current && enabledList[index];
				const disabled = !enabledList[index];
				return h(
					React.Fragment,
					{ key: label },
					index > 0 ? h("span", { className: "dc-step-sep", "aria-hidden": "true" }) : null,
					h(
						"button",
						{
							type: "button",
							className: cx("dc-step", isCurrent && "on", isDone && "done"),
							onClick: () => {
								if (!disabled) onStep?.(index);
							},
							disabled,
							"aria-current": isCurrent ? "step" : undefined,
							title: `${label}：${hints[index]}`,
						},
						h("span", { className: "dc-step-idx" }, isDone ? h(DcIcon, { name: "check", size: 11 }) : String(index + 1)),
						h("span", null, label),
					),
				);
			}),
		),
		h("div", { className: "dc-steps-right" }, `第 ${current + 1} 步 / ${labels.length}`),
	);
}

// ── 模板卡片 / 预览 / 选择器 / 空态展示 ─────────────────────────────────────

function TemplateCard({ template, active = false, onClick, disabled = false, loading = false }) {
	const count = Array.isArray(template?.sections) ? template.sections.length : 0;
	return h(
		"button",
		{
			type: "button",
			className: cx("dc-tpl", active && "on"),
			onClick,
			disabled: disabled || loading,
			"aria-pressed": active ? "true" : undefined,
			title: template?.description ?? "",
		},
		h(
			"span",
			{ className: "dc-tpl-top" },
			h("span", { className: "dc-tpl-name" }, template?.name ?? "未命名模板"),
			h("span", { className: "dc-tpl-cat" }, template?.category ?? "通用"),
		),
		h("span", { className: "dc-tpl-desc" }, template?.description ?? ""),
		h(
			"span",
			{ className: "dc-tpl-foot" },
			loading ? h(Spinner, { size: 12 }) : h(DcIcon, { name: count > 0 ? "list" : "sparkles", size: 12 }),
			loading ? "创建中…" : count > 0 ? `${count} 节骨架` : "自由结构",
			h("span", { style: { flex: "1 1 auto" } }),
			active ? h("span", { className: "dc-tpl-check" }, h(DcIcon, { name: "check", size: 10 })) : null,
		),
	);
}

function TemplatePreview({ template }) {
	if (!template) return null;
	const sections = Array.isArray(template.sections) ? template.sections : [];
	return h(
		"div",
		{ className: "dc-tpl-preview" },
		h(
			"div",
			{ className: "dc-tpl-preview-head" },
			h(DcIcon, { name: "layers", size: 13 }),
			`「${template.name}」大纲骨架`,
			h("span", { className: "dc-hint" }, sections.length > 0 ? "生成时按此结构展开，可在对话中调整" : "无固定骨架，由 AI 根据主题自由设计"),
		),
		sections.length > 0
			? h(
					"ol",
					{ className: "dc-skel-list" },
					sections.map((section, index) =>
						h(
							"li",
							{ key: `${section.heading}-${index}`, className: "dc-skel-item" },
							h("span", { className: "dc-skel-idx" }, String(index + 1)),
							h("span", { className: "dc-skel-h" }, section.heading ?? ""),
							section.hint ? h("span", { className: "dc-skel-hint" }, section.hint) : null,
						),
					),
				)
			: h(
					"ul",
					{ className: "dc-free-hints" },
					[
						"在「主题与要求」里写清写作目的、读者、必须涵盖的要点。",
						"AI 会先给出 6–10 节大纲，确认后按大纲写全文。",
						"建议至少上传一份参考文档，成文会更贴近你的素材。",
					].map((text) => h("li", { key: text }, text)),
				),
	);
}

function TemplatePicker({ templates = [], value, onChange, disabled = false }) {
	const current = useMemo(() => (templates ?? []).find((item) => item.id === value) ?? null, [templates, value]);
	if (!templates || templates.length === 0) {
		return h(EmptyState, {
			icon: h(DcIcon, { name: "layers", size: 20 }),
			title: "没有加载到模板",
			description: "模板服务暂时不可用，你仍然可以直接填写主题后生成大纲。",
		});
	}
	return h(
		"div",
		null,
		h(
			"div",
			{ className: "dc-tpl-grid", role: "group", "aria-label": "选择文档模板" },
			templates.map((template) =>
				h(TemplateCard, {
					key: template.id,
					template,
					active: template.id === value,
					disabled,
					onClick: () => onChange?.(template.id),
				}),
			),
		),
		h(TemplatePreview, { template: current }),
	);
}

function TemplateShowcase({ templates = [], creating = null, onPick, onBlank }) {
	const busy = creating !== null && creating !== undefined;
	return h(
		"div",
		{ className: "dc-hero" },
		h(
			"div",
			{ className: "dc-hero-card" },
			h("span", { className: "dc-hero-badge" }, h(DcIcon, { name: "sparkles", size: 12 }), "AI 引导写作"),
			h("h1", { className: "dc-hero-title" }, "从一页空白，到一份成稿"),
			h(
				"p",
				{ className: "dc-hero-sub" },
				"选一个模板或自由发挥，补上主题、参考文档与红线要求；AI 先出大纲，你确认后再写成文。两个阶段都能用对话继续打磨，最后导出 Word 或 Markdown。",
			),
			h(
				"div",
				{ className: "dc-hero-steps" },
				[
					["1", "选模板 / 写主题"],
					["2", "生成并确认大纲"],
					["3", "成文与导出"],
				].map(([number, text]) =>
					h(
						"div",
						{ key: number, className: "dc-hero-step" },
						h("span", { className: "dc-hero-step-n" }, number),
						h("span", null, text),
					),
				),
			),
		),
		h(
			"div",
			{ className: "dc-hero-section" },
			h(
				"div",
				{ className: "dc-hero-section-head" },
				h("div", { className: "dc-hero-section-title" }, "从模板开始"),
				h(
					Button,
					{ variant: "subtle", size: "sm", icon: h(DcIcon, { name: "edit", size: 13 }), onClick: onBlank, disabled: busy },
					"空白自由发挥",
				),
			),
			templates.length === 0
				? h(EmptyState, {
						icon: h(DcIcon, { name: "file", size: 20 }),
						title: "还没有可用的模板",
						description: "模板列表没有加载出来。可以直接新建空白文档，或稍后刷新重试。",
						action: h(Button, { variant: "primary", onClick: onBlank, loading: busy }, "新建空白文档"),
					})
				: h(
						"div",
						{ className: "dc-tpl-grid", role: "group", "aria-label": "从模板新建文档" },
						templates.map((template) =>
							h(TemplateCard, {
								key: template.id,
								template,
								loading: creating === template.id,
								disabled: busy && creating !== template.id,
								onClick: () => onPick?.(template.id),
							}),
						),
					),
		),
	);
}

// ── SetupView 子块：参考文档 ─────────────────────────────────────────────────

const DC_ALLOWED_EXT = ["docx", "pdf", "txt", "md", "markdown", "pptx", "json", "csv", "html", "htm"];
const DC_REF_MAX_BYTES = 50 * 1024 * 1024;

function SetupRefs({ project, uploading = false, busy = false, onUploadRef, onRemoveRef }) {
	const inputRef = useRef(null);
	const [over, setOver] = useState(false);
	const [localError, setLocalError] = useState(null);
	const refs = Array.isArray(project.refs) ? project.refs : [];
	const readyCount = refs.filter((item) => item.status === "ready").length;
	const totalChars = refs.reduce((sum, item) => sum + (typeof item.chars === "number" ? item.chars : 0), 0);

	const handleFiles = useCallback(
		async (fileList) => {
			const files = Array.from(fileList ?? []);
			if (files.length === 0) return;
			setLocalError(null);
			for (const file of files) {
				const ext = String(file.name ?? "").split(".").pop()?.toLowerCase() ?? "";
				if (ext === "doc") {
					setLocalError("暂不支持 .doc 旧格式，请另存为 .docx 或 PDF 后上传。");
					continue;
				}
				if (!DC_ALLOWED_EXT.includes(ext)) {
					setLocalError(`不支持的文件类型「${file.name}」，支持 .docx / .pdf / .pptx / .txt / .md / .json / .csv / .html。`);
					continue;
				}
				if (file.size > DC_REF_MAX_BYTES) {
					setLocalError(`「${file.name}」超过 50MB 上限，请压缩或拆分后再上传。`);
					continue;
				}
				try {
					await onUploadRef?.(file);
				} catch (err) {
					setLocalError(err?.message ?? String(err));
				}
			}
		},
		[onUploadRef],
	);

	return h(
		"div",
		null,
		h(
			"div",
			{
				className: cx("dc-drop", over && "over"),
				role: "button",
				tabIndex: 0,
				"aria-label": "上传参考文档",
				onClick: () => {
					if (!uploading) inputRef.current?.click();
				},
				onKeyDown: (event) => {
					if ((event.key === "Enter" || event.key === " ") && !uploading) {
						event.preventDefault();
						inputRef.current?.click();
					}
				},
				onDragOver: (event) => {
					event.preventDefault();
					if (!uploading) setOver(true);
				},
				onDragLeave: () => setOver(false),
				onDrop: (event) => {
					event.preventDefault();
					setOver(false);
					if (!uploading) handleFiles(event.dataTransfer?.files);
				},
			},
			uploading ? h(Spinner, { size: 20 }) : h("span", { className: "dc-drop-icon" }, h(DcIcon, { name: "upload", size: 21 })),
			h("span", { className: "dc-drop-title" }, uploading ? "正在上传并解析文本…" : "拖入参考文档，或点击选择文件"),
			h(
				"span",
				{ className: "dc-drop-hint" },
				"支持 .docx / .pdf / .pptx / .txt / .md / .json / .csv / .html，单个文件不超过 50MB；可一次选多个。",
			),
		),
		h("input", {
			ref: inputRef,
			type: "file",
			multiple: true,
			accept: ".docx,.pdf,.txt,.md,.markdown,.pptx,.json,.csv,.html,.htm",
			style: { display: "none" },
			onChange: (event) => {
				handleFiles(event.target.files);
				event.target.value = "";
			},
		}),
		h(
			"div",
			{ className: "dc-refs-actions" },
			h(
				Button,
				{
					size: "sm",
					variant: "subtle",
					icon: h(DcIcon, { name: "upload", size: 13 }),
					onClick: () => {
						if (!uploading) inputRef.current?.click();
					},
					disabled: uploading,
				},
				uploading ? "上传中…" : "选择文件上传",
			),
			h("span", { className: "dc-hint" }, "也可以先把文件拖进来"),
		),
		uploading ? h("div", { style: { marginTop: 10 } }, h(JobProgress, { job: { status: "running", phase: "参考文档", message: "上传并抽取文本…", progress: null } })) : null,
		localError ? h("div", { className: "dc-hint error", style: { marginTop: 8 }, role: "alert" }, localError) : null,
		refs.length > 0
			? h(
					React.Fragment,
					null,
					h(
						"div",
						{ className: "dc-refs-summary", style: { marginTop: 12 } },
						h(DcIcon, { name: "check-circle", size: 13 }),
						h("span", null, `已上传 ${refs.length} 份，可用 ${readyCount} 份`),
						totalChars > 0 ? h("span", null, `· 共抽取 ${fmtChars(totalChars)}`) : null,
					),
					h(
						"div",
						{ className: "dc-ref-list" },
						refs.map((item) => {
							const failed = item.status === "error";
							return h(
								"div",
								{ key: item.id, className: cx("dc-ref", failed && "err") },
								h("span", { className: "dc-ref-icon" }, h(DcIcon, { name: failed ? "alert" : "file", size: 15 })),
								h(
									"div",
									{ className: "dc-ref-main" },
									h("div", { className: "dc-ref-name", title: item.name ?? "" }, item.name ?? "参考文档"),
									h(
										"div",
										{ className: "dc-ref-meta" },
										h("span", null, fmtSize(item.size)),
										!failed && typeof item.chars === "number" ? h("span", null, `· ${fmtChars(item.chars)}`) : null,
										item.truncated ? h("span", { className: "dc-ref-warn" }, "· 内容过长已截断") : null,
										item.addedAt ? h("span", null, `· ${fmtTime(item.addedAt)}`) : null,
										failed ? h(Badge, { tone: "danger" }, "解析失败") : null,
									),
									failed && item.error ? h("div", { className: "dc-ref-err" }, item.error) : null,
								),
								h(IconButton, {
									icon: h(DcIcon, { name: "trash", size: 14 }),
									label: `删除参考文档「${item.name ?? ""}」`,
									title: "删除",
									size: "sm",
									onClick: () => onRemoveRef?.(item.id),
									disabled: busy,
								}),
							);
						}),
					),
				)
			: null,
	);
}

// ── SetupView 子块：红线编辑 ─────────────────────────────────────────────────

function RedlineEditor({ redlines = [], template, onPatch }) {
	const [custom, setCustom] = useState("");
	const [removed, setRemoved] = useState([]);
	const list = Array.isArray(redlines) ? redlines : [];
	const known = new Set(list.map((item) => String(item.text ?? "").trim()));
	const suggestions = (Array.isArray(template?.redlines) ? template.redlines : []).filter(
		(text) => !known.has(String(text ?? "").trim()),
	);

	const apply = (next) => {
		try {
			const result = onPatch?.({ redlines: next });
			if (result && typeof result.catch === "function") result.catch(() => {});
		} catch {
			/* 错误由 app 的错误条展示 */
		}
	};

	const add = (text) => {
		const value = String(text ?? "").trim();
		if (value === "" || known.has(value)) return;
		apply([...list, { id: dcUid("rl"), text: value, builtin: false }]);
	};

	const remove = (item) => {
		apply(list.filter((entry) => entry.id !== item.id).map((entry) => ({ id: entry.id, text: entry.text, builtin: !!entry.builtin })));
		setRemoved((prev) => [...prev.filter((entry) => entry.id !== item.id), item]);
	};

	const restore = (item) => {
		if (known.has(String(item.text ?? "").trim())) {
			setRemoved((prev) => prev.filter((entry) => entry.id !== item.id));
			return;
		}
		apply([...list, { id: item.id, text: item.text, builtin: !!item.builtin }]);
		setRemoved((prev) => prev.filter((entry) => entry.id !== item.id));
	};

	const submitCustom = () => {
		add(custom);
		setCustom("");
	};

	return h(
		"div",
		null,
		list.length > 0
			? h(
					"div",
					{ className: "dc-rl-list" },
					list.map((item) =>
						h(
							"label",
							{ key: item.id, className: "dc-rl", title: "取消勾选即移除该红线" },
							h("input", {
								type: "checkbox",
								checked: true,
								onChange: () => remove(item),
								"aria-label": `移除红线：${item.text ?? ""}`,
							}),
							h("span", { className: "dc-rl-text" }, item.text ?? ""),
							h("span", { className: cx("dc-rl-tag", !item.builtin && "custom") }, item.builtin ? "默认" : "自定义"),
						),
					),
				)
			: h("div", { className: "dc-hint" }, "当前没有启用任何红线要求。建议至少保留几条必须遵守的硬性要求。"),
		removed.length > 0
			? h(
					"div",
					{ className: "dc-rl-removed" },
					h("span", { className: "dc-hint" }, "已移除，点击恢复："),
					removed.map((item) =>
						h(
							Chip,
							{ key: item.id, onClick: () => restore(item), icon: h(DcIcon, { name: "plus", size: 11 }), title: item.text },
							truncateText(item.text, 22),
						),
					),
				)
			: null,
		h(
			"div",
			{ className: "dc-rl-add" },
			h(TextInput, {
				value: custom,
				onChange: (event) => setCustom(event.target.value),
				placeholder: "添加自定义红线，例如：不得出现未公开的内部数据",
				ariaLabel: "自定义红线内容",
				maxLength: 300,
				onKeyDown: (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						submitCustom();
					}
				},
			}),
			h(Button, { variant: "subtle", size: "sm", icon: h(DcIcon, { name: "plus", size: 13 }), onClick: submitCustom, disabled: custom.trim() === "" }, "添加"),
		),
		suggestions.length > 0
			? h(
					"div",
					{ className: "dc-rl-suggest" },
					h("div", { className: "dc-field-hint" }, `模板建议红线（点击添加，共 ${suggestions.length} 条）：`),
					h(
						"div",
						{ className: "dc-chips" },
						suggestions.map((text) =>
							h(
								Chip,
								{ key: text, onClick: () => add(text), icon: h(DcIcon, { name: "plus", size: 11 }), title: text },
								truncateText(text, 26),
							),
						),
					),
				)
			: null,
		h("div", { className: "dc-hint", style: { marginTop: 10 } }, "红线会写进生成提示词，并在成文后逐条自检；确认大纲与成文都以此为准。"),
	);
}

// ── SetupView 子块：生成选项（联网 + 模型）──────────────────────────────────

function SetupOptions({ project, models, onPatch }) {
	const web = project.webSearch ?? { enabled: false };
	const selection = models?.selection ?? null;
	const providers = Array.isArray(models?.providers) ? models.providers : [];
	const current = project.model ?? null;
	const currentValue = current ? `${current.provider}::${current.model}` : "";
	const known = new Set([""]);
	const options = [
		{
			value: "",
			label: selection ? `跟随默认模型（${selection.provider} / ${selection.model}）` : "跟随默认模型",
		},
	];
	for (const provider of providers) {
		const modelsList = Array.isArray(provider.models) ? provider.models : [];
		if (modelsList.length === 0) continue;
		const groupOptions = modelsList.map((item) => ({
			value: `${provider.provider}::${item.id}`,
			label: item.name || item.id,
		}));
		groupOptions.forEach((item) => known.add(item.value));
		options.push({ group: provider.name || provider.provider, options: groupOptions });
	}
	if (currentValue !== "" && !known.has(currentValue)) {
		options.push({ value: currentValue, label: `${current.provider} / ${current.model}（当前）` });
	}

	const changeModel = (event) => {
		const value = event.target.value;
		if (value === "") {
			onPatch?.({ model: null });
			return;
		}
		const index = value.indexOf("::");
		if (index <= 0) return;
		onPatch?.({ model: { provider: value.slice(0, index), model: value.slice(index + 2) } });
	};

	return h(
		"div",
		{ className: "dc-opt-row" },
		h(
			"div",
			{ className: "dc-opt-block" },
			h(Toggle, {
				checked: !!web.enabled,
				onChange: (next) => onPatch?.({ webSearch: { ...web, enabled: next } }),
				label: "允许联网检索资料",
				description: "开启后，生成大纲前会先检索 2–4 条公开资料作为引用素材；可能多花 10–30 秒，检索失败不影响生成。",
			}),
			web.lastSearchAt
				? h("div", { className: "dc-hint" }, `上次检索：${fmtTime(web.lastSearchAt)}${Array.isArray(web.queries) && web.queries.length > 0 ? ` · ${web.queries.length} 条查询` : ""}`)
				: null,
		),
		h("hr", { className: "dc-divider" }),
		h(
			Field,
			{
				label: "使用模型",
				htmlFor: "dc-model-select",
				hint:
					providers.length > 0
						? "默认跟随 DSH 当前选用的模型；也可以只为本文档固定一个模型。"
						: "未能从 DSH 获取模型列表，将跟随默认模型。",
			},
			h(Select, { id: "dc-model-select", value: currentValue, onChange: changeModel, options }),
		),
	);
}

// ── SetupView：准备资料（模板 / 主题 / 参考 / 红线 / 选项 / 生成）────────────

function SetupView({
	project,
	templates = [],
	models = null,
	busy = null,
	job = null,
	uploading = false,
	onPatch,
	onCreate,
	onUploadRef,
	onRemoveRef,
	onGenerate,
}) {
	const projectId = project.id;
	const template = useMemo(() => (templates ?? []).find((item) => item.id === project.templateId) ?? null, [templates, project.templateId]);
	const style = project.style ?? {};
	const audience = style.audience ?? template?.defaults?.audience ?? "general";
	const tone = style.tone ?? template?.defaults?.tone ?? "professional";
	const length = style.length ?? template?.defaults?.length ?? "standard";
	const refs = Array.isArray(project.refs) ? project.refs : [];
	const redlines = Array.isArray(project.redlines) ? project.redlines : [];
	const webEnabled = !!project.webSearch?.enabled;

	const [name, setName] = useState(project.name ?? "");
	const [topic, setTopic] = useState(project.topic ?? "");
	const [saving, setSaving] = useState(null);
	const [saveError, setSaveError] = useState(null);

	// 切换项目时同步本地输入（只在项目 id 变化时重置，避免保存回写覆盖正在输入的内容）
	useEffect(() => {
		setName(project.name ?? "");
		setTopic(project.topic ?? "");
		setSaving(null);
		setSaveError(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [projectId]);

	const commit = useCallback(
		async (patch, label) => {
			if (!onPatch) return false;
			setSaving(label ?? "保存中…");
			setSaveError(null);
			try {
				await onPatch(patch);
				setSaving(null);
				return true;
			} catch (err) {
				setSaving(null);
				setSaveError(err?.message ?? String(err));
				return false;
			}
		},
		[onPatch],
	);

	const commitName = useCallback(() => {
		const next = name.trim();
		if (next === "") {
			setName(project.name ?? "");
			return Promise.resolve(false);
		}
		if (next === (project.name ?? "")) return Promise.resolve(true);
		setName(next);
		return commit({ name: next }, "正在保存名称…");
	}, [name, project.name, commit]);

	const commitTopic = useCallback(() => {
		if (topic === (project.topic ?? "")) return Promise.resolve(true);
		return commit({ topic }, "正在保存主题…");
	}, [topic, project.topic, commit]);

	const changeTemplate = useCallback(
		(id) => {
			if (id === project.templateId) return;
			const next = (templates ?? []).find((item) => item.id === id);
			const defaults = next?.defaults ?? {};
			commit(
				{
					templateId: id,
					style: {
						audience: defaults.audience ?? audience,
						tone: defaults.tone ?? tone,
						length: defaults.length ?? length,
					},
				},
				"正在应用模板…",
			);
		},
		[project.templateId, templates, audience, tone, length, commit],
	);

	const changeStyle = useCallback(
		(key, value) => {
			commit({ style: { audience, tone, length, [key]: value } }, "正在保存风格…");
		},
		[audience, tone, length, commit],
	);

	const handleGenerate = useCallback(async () => {
		const text = topic.trim();
		if (text === "" || busy) return;
		if (topic !== (project.topic ?? "")) {
			const ok = await commit({ topic }, "正在保存主题…");
			if (!ok) return;
		}
		onGenerate?.();
	}, [topic, busy, project.topic, commit, onGenerate]);

	const canGenerate = topic.trim() !== "" && !busy;
	const footerHint = busy
		? null
		: topic.trim() === ""
			? "先填写「主题与要求」，才能生成大纲。"
			: `已就绪：${template ? `「${template.name}」模板` : "自由发挥"}${refs.length > 0 ? ` · 参考文档 ${refs.length} 份` : ""}${redlines.length > 0 ? ` · 红线 ${redlines.length} 条` : ""}${webEnabled ? " · 已开启联网检索" : ""}`;

	return h(
		React.Fragment,
		null,
		h(
			"div",
			{ className: "dc-page" },
			h(
				"div",
				{ className: "dc-page-head" },
				h(
					"div",
					null,
					h("h1", { className: "dc-page-title" }, "准备资料"),
					h(
						"div",
						{ className: "dc-page-sub" },
						"选好模板、写清主题与要求，再补充参考文档和红线。AI 会据此先生成大纲，你确认后再写成文。",
					),
				),
				h(
					"div",
					{ className: "dc-page-head-actions" },
					saving
						? h("span", { className: "dc-save-hint" }, h(Spinner, { size: 11 }), saving)
						: saveError
							? h("span", { className: "dc-save-err" }, h(DcIcon, { name: "alert", size: 12 }), truncateText(saveError, 36))
							: h("span", { className: "dc-save-hint ok" }, h(DcIcon, { name: "check", size: 12 }), "改动会自动保存"),
				),
			),
			h(
				SectionCard,
				{
					title: "选择模板",
					description: "模板决定大纲骨架与建议红线；生成之后仍可以通过对话调整。",
					icon: h(DcIcon, { name: "layers", size: 15 }),
					actions: template ? h(Badge, { tone: "info" }, template.category ?? "模板") : null,
				},
				h(TemplatePicker, { templates, value: project.templateId, onChange: changeTemplate, disabled: !!busy }),
			),
			h(
				SectionCard,
				{
					title: "文档信息",
					description: "主题写得越具体，大纲和成文越贴近你的预期。",
					icon: h(DcIcon, { name: "edit", size: 15 }),
				},
				h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 14 } },
					h(
						Field,
						{ label: "文档名称", htmlFor: "dc-project-name", hint: "留空时会用主题前 30 字作为名称，之后也可以修改。" },
						h(TextInput, {
							id: "dc-project-name",
							value: name,
							onChange: (event) => setName(event.target.value),
							onBlur: commitName,
							onKeyDown: (event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									event.currentTarget.blur();
								}
							},
							placeholder: "例如：Q4 产品规划方案",
							maxLength: 120,
						}),
					),
					h(
						Field,
						{
							label: "主题与要求",
							htmlFor: "dc-project-topic",
							required: true,
							right: h("span", { className: "dc-counter" }, `${topic.length} 字`),
							hint: "建议写清：背景 / 目标读者 / 想达成的目的 / 必须包含或必须避免的内容。失焦后自动保存，Ctrl+Enter 可直接生成大纲。",
						},
						h(TextArea, {
							id: "dc-project-topic",
							value: topic,
							onChange: (event) => setTopic(event.target.value),
							onBlur: commitTopic,
							onKeyDown: (event) => {
								if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
									event.preventDefault();
									handleGenerate();
								}
							},
							rows: 6,
							maxLength: 8000,
							placeholder:
								"例如：为 2025 年 Q4 的产品迭代写一份规划方案，面向管理层。需要包含上季度复盘、市场变化、三个优先事项、里程碑与资源需求；不要空话，预算数字用占位符。",
						}),
					),
					h(
						"div",
						{ className: "dc-fields-row" },
						h(
							Field,
							{ label: "目标读者", htmlFor: "dc-style-audience" },
							h(
								Select,
								{
									id: "dc-style-audience",
									value: audience,
									onChange: (event) => changeStyle("audience", event.target.value),
									options: Object.entries(DC_STYLE_LABELS.audience).map(([value, label]) => ({ value, label })),
								},
							),
						),
						h(
							Field,
							{ label: "语气", htmlFor: "dc-style-tone" },
							h(
								Select,
								{
									id: "dc-style-tone",
									value: tone,
									onChange: (event) => changeStyle("tone", event.target.value),
									options: Object.entries(DC_STYLE_LABELS.tone).map(([value, label]) => ({ value, label })),
								},
							),
						),
						h(
							Field,
							{ label: "篇幅", htmlFor: "dc-style-length" },
							h(
								Select,
								{
									id: "dc-style-length",
									value: length,
									onChange: (event) => changeStyle("length", event.target.value),
									options: Object.entries(DC_STYLE_LABELS.length).map(([value, label]) => ({ value, label })),
								},
							),
						),
					),
				),
			),
			h(
				SectionCard,
				{
					title: "参考文档",
					description: "上传后会自动抽取纯文本，用于把握事实、术语与数据；单条过长会截断。",
					icon: h(DcIcon, { name: "folder", size: 15 }),
					actions: refs.length > 0 ? h(Badge, { tone: "info" }, `${refs.length} 份`) : null,
				},
				h(SetupRefs, {
					project,
					uploading,
					busy: !!busy,
					onUploadRef,
					onRemoveRef,
				}),
			),
			h(
				SectionCard,
				{
					title: "红线要求",
					description: "「必须遵守」的硬性要求：会写进提示词，并在成文后逐条自检。",
					icon: h(DcIcon, { name: "alert", size: 15 }),
					actions: h(Badge, { tone: redlines.length > 0 ? "warn" : "neutral" }, redlines.length > 0 ? `${redlines.length} 条` : "未设置"),
				},
				h(RedlineEditor, { redlines, template, onPatch }),
			),
			h(
				SectionCard,
				{
					title: "生成选项",
					description: "控制是否联网检索，以及本文档使用哪个模型。",
					icon: h(DcIcon, { name: "globe", size: 15 }),
				},
				h(SetupOptions, { project, models, onPatch }),
			),
			h(
				"div",
				{ className: "dc-footer" },
				h(
					"div",
					{ className: "dc-footer-info" },
					busy
						? h(JobProgress, { job: busy, compact: true })
						: h("div", { className: "dc-footer-hint" }, footerHint),
					canGenerate && !busy ? h("div", { className: "dc-footer-hint" }, "生成后可对比多个大纲版本，也能在对话里继续改。") : null,
				),
				h(
					Button,
					{
						variant: "primary",
						size: "lg",
						icon: h(DcIcon, { name: "sparkles", size: 16 }),
						onClick: handleGenerate,
						disabled: !canGenerate,
						loading: !!busy,
					},
					"生成大纲",
				),
			),
		),
	);
}
