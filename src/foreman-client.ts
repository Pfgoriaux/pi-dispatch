import http from "node:http";
import path from "node:path";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

export class ForemanError extends Error {
	constructor(readonly status: number, readonly body: { error: string; refused?: unknown }) {
		super(`Foreman HTTP ${status}: ${body.error}`);
		this.name = "ForemanError";
	}
}

function endpoint(value: string | undefined): http.RequestOptions {
	if (!value) throw new Error("Set FOREMAN_URL to http://host:port or unix:/absolute/path");
	if (value.startsWith("unix:")) {
		const socketPath = value.slice(5);
		if (!path.isAbsolute(socketPath)) throw new Error("FOREMAN_URL needs an absolute Unix socket path");
		return { socketPath };
	}
	let url: URL;
	try { url = new URL(value); }
	catch { throw new Error("FOREMAN_URL must be an HTTP origin or unix:/absolute/path"); }
	if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
		throw new Error("FOREMAN_URL must be an HTTP origin or unix:/absolute/path");
	}
	return { hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || 80 };
}

function readReply<T>(response: http.IncomingMessage, token: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		response.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_RESPONSE_BYTES) {
				response.destroy(new Error("Foreman response exceeds 4 MiB"));
				return;
			}
			chunks.push(chunk);
		});
		response.on("error", reject);
		response.on("end", () => {
			let value;
			try {
				// Redact even if a server reflects the credential in its response.
				const raw = JSON.stringify(JSON.parse(Buffer.concat(chunks).toString("utf8")));
				value = JSON.parse(raw.split(JSON.stringify(token).slice(1, -1)).join("[redacted]"));
			} catch {
				reject(new Error("Foreman returned invalid JSON"));
				return;
			}
			const status = response.statusCode ?? 500;
			if (status >= 400) {
				reject(new ForemanError(status, value));
				return;
			}
			resolve(value as T);
		});
	});
}

/** Environment-based HTTP client; Unix URLs use http.request's socketPath. */
export class ForemanClient {
	readonly #endpoint: http.RequestOptions;
	readonly #token: string;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		this.#endpoint = endpoint(env.FOREMAN_URL);
		if (!env.FOREMAN_TOKEN) throw new Error("Set FOREMAN_TOKEN");
		this.#token = env.FOREMAN_TOKEN;
	}

	async request<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
		const data = body === undefined ? undefined : JSON.stringify(body);
		const headers: http.OutgoingHttpHeaders = { Authorization: `Bearer ${this.#token}` };
		if (data !== undefined) {
			headers["Content-Type"] = "application/json";
			headers["Content-Length"] = Buffer.byteLength(data);
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await new Promise<T>((resolve, reject) => {
				const request = http.request({ ...this.#endpoint, method, path: route, headers }, (response) => {
					void readReply<T>(response, this.#token).then(resolve, reject);
				});
				timer = setTimeout(() => request.destroy(new Error("Foreman request timed out after 60 seconds")), TIMEOUT_MS);
				request.on("error", reject);
				request.end(data);
			});
		} finally {
			clearTimeout(timer);
		}
	}
}
