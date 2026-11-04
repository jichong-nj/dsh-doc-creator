// lib/jobs.js — 内存任务注册表：长耗时生成（大纲 / 成文 / 对话）在后台跑，
// 客户端用 jobId 轮询进度，避免单个 HTTP 请求超时。
//
// Job 结构见 CONTRACTS.md。任务只保存在进程内存：DSH 重启后未完成的任务丢失，
// 客户端会看到 "任务不存在"，刷新项目即可。

const DEFAULT_MAX_AGE = 6 * 60 * 60 * 1000; // 6 小时

/**
 * @param {{ maxAgeMs?: number, now?: () => number }} [options]
 */
export function createJobs({ maxAgeMs = DEFAULT_MAX_AGE, now = Date.now } = {}) {
	/** @type {Map<string, object>} */
	const store = new Map();
	let counter = 0;

	function prune() {
		const cutoff = now() - maxAgeMs;
		for (const [id, job] of store) {
			if (job.updatedAt < cutoff) store.delete(id);
		}
	}

	function create({ kind, projectId, phase, message = "排队中…" }) {
		prune();
		counter += 1;
		const id = `job-${now().toString(36)}-${counter.toString(36)}`;
		const job = {
			id,
			kind,
			projectId,
			phase,
			status: "running",
			progress: 0,
			message,
			createdAt: now(),
			updatedAt: now(),
			result: null,
			error: null,
		};
		store.set(id, job);
		return job;
	}

	/** 返回浅拷贝，防止调用方改到注册表内部对象。 */
	function get(id) {
		const job = store.get(id);
		return job === undefined ? null : { ...job, result: job.result ?? null };
	}

	/**
	 * 合并更新任务；进度只允许单调递增（引擎可能在异步阶段重复报告）。
	 * @param {string} id
	 * @param {{progress?: number, message?: string, status?: string, result?: any, error?: string|null}} patch
	 */
	function update(id, patch) {
		const job = store.get(id);
		if (job === undefined) return null;
		if (patch.progress !== undefined && Number.isFinite(patch.progress)) {
			job.progress = Math.max(job.progress, Math.min(100, Math.max(0, Math.round(patch.progress))));
		}
		if (typeof patch.message === "string" && patch.message !== "") job.message = patch.message;
		if (patch.status !== undefined) job.status = patch.status;
		if (patch.result !== undefined) job.result = patch.result;
		if (patch.error !== undefined) job.error = patch.error;
		job.updatedAt = now();
		return job;
	}

	/** 项目当前是否有进行中的任务（同一项目串行，避免并发写坏数据）。 */
	function activeForProject(projectId) {
		for (const job of store.values()) {
			if (job.projectId === projectId && job.status === "running") return { ...job };
		}
		return null;
	}

	/** 供测试/诊断：活跃任务数。 */
	function runningCount() {
		let count = 0;
		for (const job of store.values()) if (job.status === "running") count += 1;
		return count;
	}

	return { create, get, update, activeForProject, runningCount, prune };
}
