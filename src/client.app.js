// doc-creator — 浏览器端 UI（三）：App 状态机、网络动作、任务轮询、布局与宿主接线。
//
// 由 build.js 拼在 client.base.js、client.review.js 之后，与二者共享同一个闭包：
// 这里可以直接用 base 的 h / React / post / 组件，以及 review 的 OutlineView /
// DocumentView / ChatDock / REVIEW_CSS（都是函数声明/顶层 const）。
//
// 职责：
// - 初始化 templates / models / projects，恢复上次选择的项目；
// - 选择/新建/删除/更新项目，上传/删除参考文档；
// - 生成大纲 → 确认 → 生成成文；对话调整；轮询 /job（900ms）；
// - 按 project.stage + 用户导航渲染 准备资料 / 大纲 / 成文；
// - ensureCss() 注入 BASE_CSS + REVIEW_CSS；apply(ctx) 注册侧栏图标与主视图。

const APP_STATE_KEY = "doc-creator:selected-project";
const APP_POLL_MS = 900;

// ── 存储 / 摘要工具 ─────────────────────────────────────────────────────────

function dcReadSelected() {
	try {
		if (typeof window === "undefined") return null;
		return window.localStorage.getItem(APP_STATE_KEY);
	} catch {
		return null;
	}
}

function dcStoreSelected(id) {
	try {
		if (typeof window === "undefined") return;
		if (id) window.localStorage.setItem(APP_STATE_KEY, String(id));
		else window.localStorage.removeItem(APP_STATE_KEY);
	} catch {
		/* 隐私模式下 localStorage 可能不可用，忽略 */
	}
}

function dcSummaryFromProject(project) {
	const outline = project?.outline ?? {};
	const document = project?.document ?? {};
	const outlineVersions = Array.isArray(outline.versions) ? outline.versions : [];
	const documentVersions = Array.isArray(document.versions) ? document.versions : [];
	const messages = Array.isArray(project?.conversation?.messages) ? project.conversation.messages : [];
	const last = messages.length > 0 ? messages[messages.length - 1] : null;
	let stage = project?.stage;
	if (stage !== "setup" && stage !== "outline" && stage !== "document") {
		stage = outlineVersions.length === 0 ? "setup" : outline.confirmed === null || outline.confirmed === undefined ? "outline" : "document";
	}
	return {
		id: project.id,
		name: project.name,
		createdAt: project.createdAt,
		updatedAt: project.updatedAt,
		stage,
		templateId: project.templateId,
		refsCount: Array.isArray(project.refs) ? project.refs.length : 0,
		outlineCount: outlineVersions.length,
		outlineActive: outline.active ?? null,
		confirmed: outline.confirmed ?? null,
		documentCount: documentVersions.length,
		documentActive: document.active ?? null,
		lastMessageAt: last?.at ?? 0,
	};
}

function dcSortProjects(list) {
	return [...(Array.isArray(list) ? list : [])].sort((a, b) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0));
}

function dcUpsertProject(list, project) {
	if (!project?.id) return Array.isArray(list) ? list : [];
	const summary = dcSummaryFromProject(project);
	const rest = (Array.isArray(list) ? list : []).filter((item) => item?.id !== summary.id);
	return dcSortProjects([summary, ...rest]);
}

// ── styles ───────────────────────────────────────────────────────────────────

function ensureCss() {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) !== null) return;
	const tag = document.createElement("style");
	tag.id = CSS_TAG_ID;
	tag.dataset.plugin = "@jichong/dsh-doc-creator";
	tag.dataset.pluginCss = CSS_TAG_ID;
	const reviewCss = typeof REVIEW_CSS === "string" ? REVIEW_CSS : "";
	tag.textContent = `${BASE_CSS}\n${reviewCss}`;
	document.head.appendChild(tag);
}

// ── App ─────────────────────────────────────────────────────────────────────

function App() {
	const [templates, setTemplates] = useState([]);
	const [projects, setProjects] = useState([]);
	const [models, setModels] = useState({ selection: null, providers: [] });
	const [selectedId, setSelectedId] = useState(null);
	const [project, setProject] = useState(null);
	const [view, setView] = useState("setup");
	const [busy, setBusy] = useState(null);
	const [job, setJob] = useState(null);
	const [toast, setToast] = useState(null);
	const [docContent, setDocContent] = useState(null);
	const [uploading, setUploading] = useState(false);
	const [booting, setBooting] = useState(true);
	const [projectsLoading, setProjectsLoading] = useState(false);
	const [loadingProject, setLoadingProject] = useState(false);
	const [creating, setCreating] = useState(null);
	const [deleteTarget, setDeleteTarget] = useState(null);
	const [confirmBusy, setConfirmBusy] = useState(false);
	const [error, setError] = useState(null);
	const [railVisible, setRailVisible] = useState(true);
	const [docFailed, setDocFailed] = useState(false);

	// 镜像到 ref：轮询/异步回调里读最新值，避免闭包过期
	const projectRef = useRef(null);
	const busyRef = useRef(null);
	const selectedRef = useRef(null);
	const docContentRef = useRef(null);
	const selectSeq = useRef(0);
	const docLoadKeyRef = useRef(null);

	projectRef.current = project;
	busyRef.current = busy;
	selectedRef.current = selectedId;
	docContentRef.current = docContent;

	useEffect(() => () => {
		// 卸载后让未完成的 selectProject 失效，避免对已卸载组件 setState
		selectSeq.current += 1;
	}, []);

	const setBusyJob = useCallback((next) => {
		busyRef.current = next;
		setBusy(next);
	}, []);

	const showError = useCallback((message) => {
		setError(typeof message === "string" && message !== "" ? message : String(message));
	}, []);

	// ── 数据加载 ────────────────────────────────────────────────────────────

	const loadProjects = useCallback(async () => {
		setProjectsLoading(true);
		try {
			const value = await post("/list", {});
			const list = Array.isArray(value?.projects) ? value.projects : [];
			setProjects(list);
			return list;
		} catch (err) {
			showError(`加载项目列表失败：${err?.message ?? err}`);
			return null;
		} finally {
			setProjectsLoading(false);
		}
	}, [showError]);

	const loadDocument = useCallback(
		async (projectId, version) => {
			try {
				const body = version === undefined || version === null ? { projectId } : { projectId, version };
				const value = await post("/document", body);
				if (selectedRef.current !== projectId) return null;
				const next = {
					markdown: typeof value?.markdown === "string" ? value.markdown : "",
					meta: value?.meta ?? null,
					version: value?.meta?.version ?? version ?? null,
				};
				docContentRef.current = next;
				setDocFailed(false);
				setDocContent(next);
				return next;
			} catch (err) {
				if (selectedRef.current !== projectId) return null;
				showError(`加载成文失败：${err?.message ?? err}`);
				docContentRef.current = null;
				setDocFailed(true);
				setDocContent(null);
				return null;
			}
		},
		[showError],
	);

	const refreshProject = useCallback(
		async (projectId, options = {}) => {
			const target = projectId ?? projectRef.current?.id;
			if (!target) return null;
			try {
				const value = await post("/get", { projectId: target });
				const next = value?.project ?? null;
				if (!next) return null;
				if (selectedRef.current !== target) return next;
				projectRef.current = next;
				setProject(next);
				setProjects((prev) => dcUpsertProject(prev, next));
				if (options.view !== false && next.stage) setView(next.stage);
				return next;
			} catch (err) {
				if (selectedRef.current === target) showError(`刷新文档失败：${err?.message ?? err}`);
				return null;
			}
		},
		[showError],
	);

	const selectProject = useCallback(
		async (id) => {
			if (!id) {
				selectSeq.current += 1;
				selectedRef.current = null;
				setSelectedId(null);
				projectRef.current = null;
				setProject(null);
				setDocContent(null);
				docContentRef.current = null;
				setDocFailed(false);
				dcStoreSelected(null);
				return null;
			}
			const seq = ++selectSeq.current;
			selectedRef.current = id;
			setSelectedId(id);
			setLoadingProject(true);
			setError(null);
			setDocFailed(false);
			docContentRef.current = null;
			setDocContent(null);
			try {
				const value = await post("/get", { projectId: id });
				if (seq !== selectSeq.current) return null;
				const next = value?.project ?? null;
				if (!next) throw new Error("未找到该文档项目");
				projectRef.current = next;
				setProject(next);
				setProjects((prev) => dcUpsertProject(prev, next));
				dcStoreSelected(id);
				setView(next.stage ?? "setup");
				const activeJob = next.activeJob ?? null;
				if (activeJob?.id) {
					setJob(activeJob);
					setBusyJob(activeJob);
				} else if (!busyRef.current || busyRef.current.projectId === id) {
					setJob(null);
					setBusyJob(null);
				}
				const documentVersion = next.document?.active ?? null;
				if ((next.stage ?? "setup") === "document" && documentVersion !== null) {
					await loadDocument(id, documentVersion);
				}
				return next;
			} catch (err) {
				if (seq !== selectSeq.current) return null;
				showError(`打开文档失败：${err?.message ?? err}`);
				projectRef.current = null;
				selectedRef.current = null;
				setProject(null);
				setSelectedId(null);
				dcStoreSelected(null);
				return null;
			} finally {
				if (seq === selectSeq.current) setLoadingProject(false);
			}
		},
		[loadDocument, setBusyJob, showError],
	);

	// 首屏：模板 / 模型 / 项目列表并行加载；恢复上次项目，否则打开最近一个
	useEffect(() => {
		let alive = true;
		(async () => {
			const results = await Promise.allSettled([post("/templates", {}), post("/models", {}), post("/list", {})]);
			if (!alive) return;
			const [templatesResult, modelsResult, listResult] = results;
			const failures = [];

			if (templatesResult.status === "fulfilled") {
				setTemplates(Array.isArray(templatesResult.value?.templates) ? templatesResult.value.templates : []);
			} else {
				failures.push(`模板：${templatesResult.reason?.message ?? templatesResult.reason}`);
			}
			if (modelsResult.status === "fulfilled") {
				setModels({
					selection: modelsResult.value?.selection ?? null,
					providers: Array.isArray(modelsResult.value?.providers) ? modelsResult.value.providers : [],
				});
			}

			let list = [];
			if (listResult.status === "fulfilled") {
				list = Array.isArray(listResult.value?.projects) ? listResult.value.projects : [];
				setProjects(list);
			} else {
				failures.push(`项目：${listResult.reason?.message ?? listResult.reason}`);
			}
			if (failures.length > 0) showError(`部分数据加载失败（${failures.join("；")}），可点右上角刷新重试。`);
			if (!alive) return;
			setBooting(false);

			const saved = dcReadSelected();
			const pick = list.some((item) => item?.id === saved) ? saved : list[0]?.id ?? null;
			if (pick) await selectProject(pick);
		})();
		return () => {
			alive = false;
		};
	}, [selectProject, showError]);

	// 进入成文阶段或切版本后补齐正文（失败不重试，避免死循环）
	useEffect(() => {
		if (!project || view !== "document") return;
		const version = project.document?.active ?? null;
		if (version === null) return;
		const loaded = docContentRef.current;
		if (loaded && (loaded.version === version || loaded.meta?.version === version)) return;
		const key = `${project.id}:${version}`;
		if (docLoadKeyRef.current === key) return;
		docLoadKeyRef.current = key;
		loadDocument(project.id, version).finally(() => {
			if (docLoadKeyRef.current === key) docLoadKeyRef.current = null;
		});
	}, [project?.id, view, project?.document?.active, loadDocument]); // eslint-disable-line react-hooks/exhaustive-deps

	// ── 项目增删改 ──────────────────────────────────────────────────────────

	const createProject = useCallback(
		async (templateId) => {
			if (busyRef.current) {
				showError("有任务正在进行中，完成后再新建文档。");
				return null;
			}
			setCreating(templateId ?? "blank");
			setError(null);
			try {
				const value = await post("/create", templateId ? { templateId } : {});
				const next = value?.project ?? null;
				if (!next) throw new Error("创建接口没有返回文档");
				selectSeq.current += 1; // 取消可能仍在进行的 selectProject
				selectedRef.current = next.id;
				projectRef.current = next;
				setProject(next);
				setSelectedId(next.id);
				dcStoreSelected(next.id);
				setView("setup");
				setDocContent(null);
				docContentRef.current = null;
				setDocFailed(false);
				setJob(null);
				setBusyJob(null);
				setProjects((prev) => dcUpsertProject(prev, next));
				setToast({ kind: "success", text: `已创建「${next.name || "未命名文档"}」` });
				return next;
			} catch (err) {
				showError(`创建文档失败：${err?.message ?? err}`);
				return null;
			} finally {
				setCreating(null);
			}
		},
		[setBusyJob, showError],
	);

	const startCreate = useCallback(() => {
		if (busyRef.current) {
			showError("有任务正在进行中，完成后再新建文档。");
			return;
		}
		selectSeq.current += 1;
		selectedRef.current = null;
		projectRef.current = null;
		setProject(null);
		setSelectedId(null);
		dcStoreSelected(null);
		setDocContent(null);
		docContentRef.current = null;
		setDocFailed(false);
		setView("setup");
		setJob(null);
		setBusyJob(null);
		setError(null);
	}, [setBusyJob, showError]);

	const promptDeleteProject = useCallback(
		(summary) => {
			if (!summary?.id) return;
			if (busyRef.current) {
				showError("有任务正在进行中，完成后再删除文档。");
				return;
			}
			setDeleteTarget(summary);
		},
		[showError],
	);

	const runDeleteProject = useCallback(async () => {
		const target = deleteTarget;
		if (!target?.id) return;
		setConfirmBusy(true);
		try {
			await post("/delete", { projectId: target.id });
			setProjects((prev) => (Array.isArray(prev) ? prev : []).filter((item) => item.id !== target.id));
			if (selectedRef.current === target.id) {
				selectSeq.current += 1;
				selectedRef.current = null;
				projectRef.current = null;
				setProject(null);
				setSelectedId(null);
				dcStoreSelected(null);
				setDocContent(null);
				docContentRef.current = null;
				setDocFailed(false);
				setView("setup");
				setJob(null);
				setBusyJob(null);
			}
			setDeleteTarget(null);
			setToast({ kind: "success", text: "文档已删除" });
		} catch (err) {
			showError(`删除文档失败：${err?.message ?? err}`);
			setDeleteTarget(null);
		} finally {
			setConfirmBusy(false);
		}
	}, [deleteTarget, setBusyJob, showError]);

	const patchProject = useCallback(
		async (patch) => {
			const current = projectRef.current;
			if (!current) throw new Error("尚未选择文档");
			const projectId = current.id;
			try {
				const value = await post("/update", { projectId, patch });
				const next = value?.project ?? null;
				if (next && selectedRef.current === projectId) {
					projectRef.current = next;
					setProject(next);
					setProjects((prev) => dcUpsertProject(prev, next));
				}
				return next;
			} catch (err) {
				throw err;
			}
		},
		[],
	);

	// ── 参考文档 ────────────────────────────────────────────────────────────

	const handleUploadRef = useCallback(
		async (file) => {
			const current = projectRef.current;
			if (!current || !file) return null;
			setUploading(true);
			setError(null);
			try {
				const value = await uploadRef(current.id, file);
				const ref = value?.ref ?? null;
				const next = value?.project ?? null;
				if (next && selectedRef.current === current.id) {
					projectRef.current = next;
					setProject(next);
					setProjects((prev) => dcUpsertProject(prev, next));
				}
				if (ref?.status === "error") {
					showError(`参考文档「${ref.name ?? file.name}」解析失败：${ref.error ?? "未知原因"}`);
					setToast({ kind: "error", text: "参考文档解析失败" });
				} else {
					setToast({ kind: "success", text: `已添加参考文档：${ref?.name ?? file.name}` });
				}
				return value;
			} catch (err) {
				showError(`上传失败：${err?.message ?? err}`);
				return null;
			} finally {
				setUploading(false);
			}
		},
		[showError],
	);

	const handleRemoveRef = useCallback(
		async (refId) => {
			const current = projectRef.current;
			if (!current || !refId) return;
			setError(null);
			try {
				const value = await post("/delete-ref", { projectId: current.id, refId });
				const next = value?.project ?? null;
				if (next && selectedRef.current === current.id) {
					projectRef.current = next;
					setProject(next);
					setProjects((prev) => dcUpsertProject(prev, next));
				}
				setToast({ kind: "success", text: "已删除参考文档" });
			} catch (err) {
				showError(`删除参考文档失败：${err?.message ?? err}`);
			}
		},
		[showError],
	);

	// ── 任务：生成大纲 / 成文 / 对话 ────────────────────────────────────────

	const startJob = useCallback(
		async (kind, options = {}) => {
			const current = projectRef.current;
			if (!current) return null;
			if (busyRef.current) {
				showError("已有任务正在进行中，请等待完成后再试。");
				return null;
			}
			setError(null);
			try {
				let value = null;
				if (kind === "outline") {
					value = await post("/outline-generate", { projectId: current.id });
				} else if (kind === "document") {
					value = await post(
						"/document-generate",
						options.outlineVersion ? { projectId: current.id, outlineVersion: options.outlineVersion } : { projectId: current.id },
					);
				} else if (kind === "chat") {
					value = await post("/chat", {
						projectId: current.id,
						message: options.message,
						phase: options.phase === "document" ? "document" : "outline",
					});
				} else {
					return null;
				}
				const jobId = value?.jobId;
				if (!jobId) throw new Error("服务未返回任务编号");
				const nextJob = {
					id: jobId,
					kind,
					projectId: current.id,
					phase: kind === "outline" ? "大纲" : kind === "document" ? "成文" : "对话",
					status: "running",
					progress: 0,
					message: kind === "chat" ? "AI 正在理解并处理…" : "任务已提交，正在启动…",
					result: null,
					error: null,
				};
				setBusyJob(nextJob);
				setJob(nextJob);
				return nextJob;
			} catch (err) {
				const message = err?.message ?? String(err);
				showError(
					kind === "outline"
						? `生成大纲失败：${message}`
						: kind === "document"
							? `生成成文失败：${message}`
							: `发送失败：${message}`,
				);
				return null;
			}
		},
		[setBusyJob, showError],
	);

	const finishJob = useCallback(
		async (finished) => {
			const kind = finished?.kind ?? busyRef.current?.kind ?? "outline";
			const projectId = finished?.projectId ?? busyRef.current?.projectId ?? projectRef.current?.id ?? null;
			setBusyJob(null);
			setJob(finished ?? null);
			const isCurrent = projectId !== null ? selectedRef.current === projectId : true;
			const failed = finished?.status === "error" || (finished?.status === "done" && finished?.error);

			if (failed) {
				const what = kind === "outline" ? "生成大纲" : kind === "document" ? "生成成文" : "对话调整";
				showError(`${what}失败：${finished?.error ?? "未知错误"}`);
				setToast({ kind: "error", text: `${what}失败` });
				if (projectId && isCurrent) await refreshProject(projectId, { view: false });
				return;
			}

			if (!isCurrent) {
				setToast({ kind: "success", text: "后台任务已完成，切回该文档可查看结果" });
				return;
			}

			const updated = projectId ? await refreshProject(projectId, { view: false }) : null;
			const stage = updated?.stage ?? projectRef.current?.stage ?? "setup";
			const result = finished?.result ?? {};

			if (kind === "outline") {
				setView("outline");
				setToast({
					kind: "success",
					text: result.outlineVersion ? `大纲 v${result.outlineVersion} 已生成，可在右侧对话里调整` : "大纲已生成，可在右侧对话里调整",
				});
				return;
			}
			if (kind === "document") {
				setView("document");
				const version = result.documentVersion ?? updated?.document?.active ?? null;
				if (projectId && version !== null) await loadDocument(projectId, version);
				const warnings = Array.isArray(updated?.warnings) ? updated.warnings : [];
				setToast({
					kind: warnings.length > 0 ? "info" : "success",
					text: warnings.length > 0 ? `成文已生成，但有 ${warnings.length} 条提示` : version ? `成文 v${version} 已生成` : "成文已生成",
				});
				return;
			}

			// 对话调整：同一项目下刷新会话；成文阶段还有新版本时补拉正文
			if (stage === "document") {
				const active = result.documentVersion ?? updated?.document?.active ?? null;
				if (projectId && active !== null) await loadDocument(projectId, active);
			}
			setToast({
				kind: "success",
				text: result.outlineVersion
					? `已更新为大纲 v${result.outlineVersion}`
					: result.documentVersion
						? `已更新为成文 v${result.documentVersion}`
						: "对话已处理",
			});
		},
		[refreshProject, loadDocument, setBusyJob, showError],
	);

	// 轮询：只在 job id 变化时重开；轮询中更新 busy 对象不会重启
	useEffect(() => {
		const active = busy;
		if (!active || !active.id) return undefined;
		const jobId = active.id;
		let alive = true;
		let timer = null;
		let finished = false;
		let failures = 0;

		const tick = async () => {
			if (!alive || finished) return;
			try {
				const value = await post("/job", { jobId });
				if (!alive || finished) return;
				const next = value?.job ?? null;
				if (!next) {
					finished = true;
					if (timer) clearInterval(timer);
					showError("任务状态丢失，请点击刷新后重试。");
					setBusyJob(null);
					return;
				}
				setJob(next);
				if (next.status === "running" || next.status === "pending" || !next.status) {
					setBusyJob(next);
					return;
				}
				finished = true;
				if (timer) clearInterval(timer);
				await finishJob(next);
			} catch (err) {
				if (!alive) return;
				failures += 1;
				if (failures >= 3) {
					finished = true;
					if (timer) clearInterval(timer);
					showError(`查询任务进度失败：${err?.message ?? err}`);
					setBusyJob(null);
				}
			}
		};

		timer = setInterval(tick, APP_POLL_MS);
		tick();
		return () => {
			alive = false;
			if (timer) clearInterval(timer);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [busy?.id]);

	const confirmOutline = useCallback(
		async (version) => {
			const current = projectRef.current;
			if (!current) return;
			if (busyRef.current) {
				showError("有任务正在进行中，请等待完成。");
				return;
			}
			setError(null);
			try {
				const value = await post("/outline-confirm", { projectId: current.id, version });
				const next = value?.project ?? null;
				if (next && selectedRef.current === current.id) {
					projectRef.current = next;
					setProject(next);
					setProjects((prev) => dcUpsertProject(prev, next));
					setView(next.stage ?? "document");
				}
				setToast({ kind: "success", text: `已确认大纲 v${version}，开始生成成文…` });
				await startJob("document", { outlineVersion: version });
			} catch (err) {
				showError(`确认大纲失败：${err?.message ?? err}`);
			}
		},
		[startJob, showError],
	);

	const sendChat = useCallback(
		async (text, phase) => {
			const current = projectRef.current;
			const content = String(text ?? "").trim();
			if (!current || content === "" || busyRef.current) return null;
			const messagePhase = phase === "document" ? "document" : "outline";
			const optimisticId = dcUid("local-msg");
			const optimistic = {
				id: optimisticId,
				role: "user",
				content,
				phase: messagePhase,
				at: Date.now(),
				error: false,
				action: null,
			};
			setProject((prev) =>
				prev ? { ...prev, conversation: { messages: [...((prev.conversation?.messages) ?? []), optimistic] } } : prev,
			);
			const started = await startJob("chat", { message: content, phase: messagePhase });
			if (!started) {
				setProject((prev) =>
					prev
						? {
								...prev,
								conversation: {
									messages: ((prev.conversation?.messages) ?? []).filter((item) => item.id !== optimisticId),
								},
							}
						: prev,
				);
			}
			return started;
		},
		[startJob],
	);

	// ── 版本切换 / 下载 / 导航 ─────────────────────────────────────────────

	const previewOutlineVersion = useCallback((version) => {
		setProject((prev) => (prev ? { ...prev, outline: { ...(prev.outline ?? {}), active: version } } : prev));
	}, []);

	const previewDocumentVersion = useCallback(
		(version) => {
			const current = projectRef.current;
			if (!current) return;
			setProject((prev) => (prev ? { ...prev, document: { ...(prev.document ?? {}), active: version } } : prev));
			loadDocument(current.id, version);
		},
		[loadDocument],
	);

	const downloadDocument = useCallback(
		(format = "docx", version) => {
			const current = projectRef.current;
			if (!current) return;
			const target = version ?? current.document?.active ?? null;
			if (target === null || target === undefined) {
				showError("还没有可下载的成文版本。");
				return;
			}
			const ext = format === "md" ? "md" : "docx";
			const url = `${API}/download/${encodeURIComponent(current.id)}/${target}.${ext}`;
			try {
				const opened = window.open(url, "_blank", "noopener");
				if (!opened) window.location.href = url;
			} catch {
				window.location.href = url;
			}
		},
		[showError],
	);

	const handleDocumentView = useCallback(
		(arg) => {
			if (typeof arg === "number") {
				previewDocumentVersion(arg);
				return;
			}
			if (arg === "outline" || arg?.kind === "outline") {
				setView("outline");
				return;
			}
			if (typeof arg?.version === "number") previewDocumentVersion(arg.version);
		},
		[previewDocumentVersion],
	);

	const outlineCount = project?.outline?.versions?.length ?? 0;
	const confirmed = project?.outline?.confirmed ?? null;
	const stepIndex = view === "document" ? 2 : view === "outline" ? 1 : 0;
	const stepsEnabled = [true, outlineCount > 0, confirmed !== null];
	const showDock = !!project && view !== "setup";
	const dockPhase = view === "document" ? "document" : "outline";
	const messages = project?.conversation?.messages ?? [];
	const stageMeta = dcStageMeta(project?.stage ?? "setup");

	const handleStep = useCallback(
		(index) => {
			if (index === 0) {
				setView("setup");
				return;
			}
			if (index === 1 && outlineCount > 0) {
				setView("outline");
				return;
			}
			if (index === 2 && confirmed !== null) setView("document");
		},
		[outlineCount, confirmed],
	);

	const refreshAll = useCallback(async () => {
		setError(null);
		await loadProjects();
		const currentId = selectedRef.current;
		if (currentId) await refreshProject(currentId, { view: false });
	}, [loadProjects, refreshProject]);

	const handleSend = useCallback((text) => sendChat(text, dockPhase), [sendChat, dockPhase]);
	const regenerateOutline = useCallback(() => startJob("outline"), [startJob]);
	const regenerateDocument = useCallback(() => startJob("document"), [startJob]);

	// toast 自动消失
	useEffect(() => {
		if (!toast) return undefined;
		const timer = setTimeout(() => setToast(null), 4600);
		return () => clearTimeout(timer);
	}, [toast]);

	// ── 渲染 ────────────────────────────────────────────────────────────────

	const loadingNode = (text) => h("div", { className: "dc-loading" }, h(Spinner, { size: 18 }), text);

	let content = null;
	if (booting) {
		content = loadingNode("正在加载文档创作…");
	} else if (loadingProject) {
		content = loadingNode("正在打开文档…");
	} else if (!project) {
		content = h(TemplateShowcase, {
			templates,
			creating,
			onPick: (templateId) => createProject(templateId),
			onBlank: () => createProject(),
		});
	} else if (view === "setup") {
		content = h(SetupView, {
			project,
			templates,
			models,
			busy,
			job,
			uploading,
			onPatch: patchProject,
			onCreate: createProject,
			onUploadRef: handleUploadRef,
			onRemoveRef: handleRemoveRef,
			onGenerate: regenerateOutline,
		});
	} else if (view === "outline") {
		content = h(OutlineView, {
			project,
			busy,
			job,
			onVersion: previewOutlineVersion,
			onConfirm: confirmOutline,
			onRegenerate: regenerateOutline,
		});
	} else if (docContent) {
		content = h(DocumentView, {
			project,
			document: docContent,
			busy,
			job,
			onVersion: previewDocumentVersion,
			onRegenerate: regenerateDocument,
			onDownload: downloadDocument,
			onView: handleDocumentView,
		});
	} else if (busy) {
		content = h(
			"div",
			{ className: "dc-page" },
			h(
				"div",
				{ className: "dc-page-head" },
				h("div", null, h("h1", { className: "dc-page-title" }, "正在生成成文"), h("div", { className: "dc-page-sub" }, "成文生成时间较长（通常 1–3 分钟），可以留在本页等待，也可以去右侧对话查看进度。")),
			),
			h(SectionCard, { title: "生成进度" }, h(JobProgress, { job: busy })),
		);
	} else if ((project.document?.active ?? null) !== null) {
		content = docFailed
			? h(EmptyState, {
					icon: h(DcIcon, { name: "alert", size: 20 }),
					title: "成文正文加载失败",
					description: "可能是网络或服务暂时不可用。正文仍保存在服务端，可以重试加载。",
					action: h(
						Button,
						{
							variant: "primary",
							icon: h(DcIcon, { name: "refresh", size: 14 }),
							onClick: () => {
								setDocFailed(false);
								loadDocument(project.id, project.document?.active ?? null);
							},
						},
						"重新加载",
					),
				})
			: loadingNode("正在加载成文…");
	} else {
		content = h(EmptyState, {
			icon: h(DcIcon, { name: "file", size: 20 }),
			title: "还没有成文版本",
			description: "先回到大纲阶段，确认一版大纲后就会开始生成成文。",
			action: h(Button, { variant: "primary", onClick: () => setView("outline") }, "去确认大纲"),
		});
	}

	const errorBar = error
		? h(
				"div",
				{ className: "dc-errorbar", role: "alert" },
				h(DcIcon, { name: "alert", size: 15 }),
				h("span", { className: "dc-errorbar-text" }, error),
				h(IconButton, {
					icon: h(DcIcon, { name: "x", size: 13 }),
					label: "关闭错误提示",
					size: "sm",
					onClick: () => setError(null),
				}),
			)
		: null;

	return h(
		"div",
		{ className: "dc" },
		h(
			"header",
			{ className: "dc-header" },
			h(
				"div",
				{ className: "dc-brand" },
				h("span", { className: "dc-brand-icon" }, h(DcIcon, { name: "file-text", size: 16 })),
				h(
					"div",
					{ className: "dc-brand-text" },
					h("span", { className: "dc-brand-title" }, "文档创作"),
					h("span", { className: "dc-brand-sub" }, "AI 引导写作 · 大纲 → 成文"),
				),
			),
			h(
				"div",
				{ className: "dc-header-mid" },
				project
					? h(
							React.Fragment,
							null,
							h("span", { className: "dc-header-sep", "aria-hidden": "true" }),
							h(
								"div",
								{ className: "dc-header-project" },
								h("span", { className: "dc-header-name", title: project.name ?? "" }, project.name || "未命名文档"),
								h(Badge, { tone: stageMeta.tone, className: "dc-header-stage" }, stageMeta.label),
								h(
									"span",
									{ className: "dc-header-count" },
									`大纲 ${outlineCount} · 成文 ${project.document?.versions?.length ?? 0}`,
								),
							),
						)
					: null,
			),
			h(
				"div",
				{ className: "dc-header-actions" },
				h(IconButton, {
					className: "dc-rail-toggle",
					icon: h(DcIcon, { name: "sidebar", size: 15 }),
					label: railVisible ? "隐藏项目栏" : "显示项目栏",
					title: railVisible ? "隐藏项目栏" : "显示项目栏",
					onClick: () => setRailVisible((value) => !value),
				}),
				h(Button, { size: "sm", variant: "subtle", icon: h(DcIcon, { name: "plus", size: 13 }), onClick: startCreate }, "新建"),
				h(IconButton, {
					variant: "bordered",
					icon: h(DcIcon, { name: "refresh", size: 15 }),
					label: "刷新项目与文档",
					title: "刷新",
					onClick: refreshAll,
				}),
			),
		),
		errorBar,
		h(
			"div",
			{ className: cx("dc-body", !railVisible && "no-rail") },
			h(ProjectRail, {
				projects,
				selectedId,
				onSelect: selectProject,
				onCreate: startCreate,
				onDelete: promptDeleteProject,
				loading: projectsLoading || booting,
			}),
			h(
				"div",
				{ className: "dc-stage" },
				project && !booting
					? h(StepBar, { step: stepIndex, enabled: stepsEnabled, onStep: handleStep })
					: null,
				h(
					"div",
					{ className: "dc-workspace" },
					h(
						"div",
						{ className: "dc-main", key: `${project?.id ?? "empty"}:${view}` },
						h(
							"div",
							{ className: cx("dc-main-inner", (view === "outline" || view === "document") && "fill") },
							content,
						),
					),
					showDock
						? h(
								"div",
								{ className: "dc-dock" },
								h(ChatDock, {
									phase: dockPhase,
									messages,
									busy,
									job,
									onSend: handleSend,
									onQuick: handleSend,
								}),
							)
						: null,
				),
			),
		),
		h(Confirm, {
			open: deleteTarget !== null,
			title: "删除文档",
			message: deleteTarget
				? `确定删除「${deleteTarget.name || "未命名文档"}」吗？该项目的大纲、成文版本、参考文档与对话记录都会一并删除，无法恢复。`
				: "",
			confirmText: "删除文档",
			cancelText: "取消",
			danger: true,
			busy: confirmBusy,
			onConfirm: runDeleteProject,
			onCancel: () => {
				if (!confirmBusy) setDeleteTarget(null);
			},
		}),
		h(Toast, { toast, onClose: () => setToast(null) }),
	);
}

// ── 侧栏面板图标 + 槽位注册 ─────────────────────────────────────────────────

/** 左侧面板列表图标：文稿 + 笔。 */
function PanelIcon({ size = 18 }) {
	return h(
		"svg",
		{
			width: size,
			height: size,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.8,
			strokeLinecap: "round",
			strokeLinejoin: "round",
			"aria-hidden": "true",
			focusable: "false",
		},
		h("path", { d: "M13.6 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" }),
		h("path", { d: "M13.6 3.5V9H19" }),
		h("path", { d: "M8.4 13.2h6.4M8.4 16.4h3.6" }),
		h("path", { d: "M14.2 20.2l3.3-3.3 1.4 1.4-3.3 3.3-1.9.5z" }),
	);
}

/** main 槽位的渲染入口（App 用 hooks，包一层函数保证作为组件渲染）。 */
function View() {
	return h(App);
}

function apply(ctx) {
	ensureCss();
	ctx.slots.inject("sidebar.panellist", () =>
		ctx.slots.register({ name: "sidebar.panellist", id: "doc-creator", order: 21, label: "文档创作" }, PanelIcon),
	);
	ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "doc-creator" }, View));
}

module.exports = { name: "doc-creator", inject: ["slots"], apply };
