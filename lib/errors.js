// lib/errors.js — 服务层统一错误：code 映射到 HTTP 状态码，message 为可直接展示的中文。

const STATUS_BY_CODE = {
	"bad-request": 400,
	"not-found": 404,
	conflict: 409,
	busy: 409,
	"payload-too-large": 413,
	"model-unavailable": 503,
	"search-unavailable": 503,
	"model-call-failed": 502,
	"search-failed": 502,
	internal: 500,
};

export class AppError extends Error {
	/**
	 * @param {string} code
	 * @param {string} message
	 * @param {{ cause?: unknown, status?: number }} [options]
	 */
	constructor(code, message, options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AppError";
		this.code = code;
		this.status = options.status ?? STATUS_BY_CODE[code] ?? 500;
	}
}

/** 断言失败抛 bad-request。 */
export function assert(condition, message, code = "bad-request") {
	if (!condition) throw new AppError(code, message);
}

/** 把任意异常归一成 AppError（保留已知 code）。 */
export function toAppError(error, fallbackMessage = "服务内部错误") {
	if (error instanceof AppError) return error;
	const message = typeof error?.message === "string" && error.message !== "" ? error.message : fallbackMessage;
	const code = typeof error?.code === "string" && Object.hasOwn(STATUS_BY_CODE, error.code) ? error.code : "internal";
	return new AppError(code, message, { cause: error });
}
