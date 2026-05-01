import type {
	AliasResponse,
	AnthropicModel,
	ApiAliasResponse,
	ApiFormat,
	ApiModel,
	GeminiModel,
	ModelAliasResponse,
	Model as OpenAIModelDescriptor,
	PaginatedAliasResponse,
	UserAliasResponse,
} from "@bodhiapp/bodhi-js-react/api";
import type { Api, Model, Provider } from "@mariozechner/pi-ai";

export const BODHI_PROVIDER_TAG = "bodhi";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 4_096;
const CATALOG_PATH = "/bodhi/v1/models?page_size=100";

type PiApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

export interface LlmAuthCredential {
	provider: string;
	baseUrl?: string;
	token: string | null;
}

export interface LlmProvider {
	getApiKeyAndHeaders(model: Model<Api>): Promise<{ apiKey: string; headers?: Record<string, string> }>;
	getAvailableModels(): Promise<Model<Api>[]>;
	setAuthToken?(credential: LlmAuthCredential | null): void;
}

export class BodhiProvider implements LlmProvider {
	private token: string | null = null;
	private baseUrl: string | undefined;

	setAuthToken(credential: LlmAuthCredential | null): void {
		if (!credential || credential.provider !== BODHI_PROVIDER_TAG) {
			this.token = null;
			this.baseUrl = undefined;
			return;
		}
		this.token = credential.token;
		this.baseUrl = credential.baseUrl;
	}

	async getApiKeyAndHeaders(_model: Model<Api>): Promise<{ apiKey: string; headers?: Record<string, string> }> {
		return { apiKey: this.token ?? "" };
	}

	async getAvailableModels(): Promise<Model<Api>[]> {
		const { baseUrl, token } = this.requireCredentials();
		const response = await fetch(`${baseUrl}${CATALOG_PATH}`, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
			},
		});
		if (!response.ok) {
			const detail = await this.readErrorDetail(response);
			throw new Error(`Failed to fetch Bodhi model catalog: ${response.status} ${response.statusText}${detail}`);
		}
		const payload = (await response.json()) as PaginatedAliasResponse;
		const entries = payload.data ?? [];
		return entries.flatMap((entry) => this.flattenAlias(entry, baseUrl));
	}

	getBaseUrl(): string | undefined {
		return this.baseUrl;
	}

	private requireCredentials(): { baseUrl: string; token: string } {
		if (!this.baseUrl || !this.token) {
			throw new Error(
				"BodhiProvider: cannot fetch catalog before setAuthToken has been called with a valid Bodhi credential.",
			);
		}
		return { baseUrl: this.stripTrailingSlash(this.baseUrl), token: this.token };
	}

	private stripTrailingSlash(value: string): string {
		return value.replace(/\/$/, "");
	}

	private async readErrorDetail(response: Response): Promise<string> {
		try {
			const text = await response.text();
			return text ? ` — ${text}` : "";
		} catch {
			return "";
		}
	}

	private flattenAlias(entry: AliasResponse, serverRoot: string): Model<Api>[] {
		if (isApiAlias(entry)) {
			return this.flattenApiAlias(entry, serverRoot);
		}
		return [this.buildLocalAliasModel(entry, serverRoot)];
	}

	private flattenApiAlias(entry: ApiAliasResponse, serverRoot: string): Model<Api>[] {
		const prefix = entry.prefix ?? "";
		const fmt = entry.api_format ?? "openai";
		return (entry.models ?? [])
			.map((model) => this.buildApiAliasModel(model, fmt, prefix, serverRoot))
			.filter((m): m is Model<Api> => m !== null);
	}

	private buildApiAliasModel(model: ApiModel, fmt: ApiFormat, prefix: string, serverRoot: string): Model<Api> | null {
		const id = extractApiModelId(model);
		if (!id) return null;
		const { contextWindow, maxTokens } = extractApiModelLimits(model);
		return {
			id: `${prefix}${id}`,
			name: extractApiModelDisplayName(model) ?? `${prefix}${id}`,
			api: apiFormatToPiApi(fmt),
			provider: apiFormatToProvider(fmt),
			baseUrl: baseUrlForFormat(serverRoot, fmt),
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
		};
	}

	private buildLocalAliasModel(entry: UserAliasResponse | ModelAliasResponse, serverRoot: string): Model<Api> {
		const id = "alias" in entry ? entry.alias : (entry as UserAliasResponse).alias;
		const metadata = "metadata" in entry ? entry.metadata : undefined;
		const contextWindow = metadata?.context?.max_input_tokens ?? DEFAULT_CONTEXT_WINDOW;
		const maxTokens = metadata?.context?.max_output_tokens ?? DEFAULT_MAX_TOKENS;
		return {
			id,
			name: id,
			api: "openai-completions",
			provider: "openai",
			baseUrl: baseUrlForFormat(serverRoot, "openai"),
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
		};
	}
}

function isApiAlias(entry: AliasResponse): entry is ApiAliasResponse {
	return "api_format" in entry && "models" in entry;
}

function extractApiModelId(model: ApiModel): string | undefined {
	if (model.provider === "gemini") {
		const name = (model as GeminiModel & { provider: "gemini" }).name;
		if (!name) return undefined;
		return name.startsWith("models/") ? name.slice("models/".length) : name;
	}
	if (model.provider === "anthropic") {
		return (model as AnthropicModel & { provider: "anthropic" }).id;
	}
	return (model as OpenAIModelDescriptor & { provider: "openai" }).id;
}

function extractApiModelDisplayName(model: ApiModel): string | undefined {
	if (model.provider === "anthropic") {
		return (model as AnthropicModel & { provider: "anthropic" }).display_name;
	}
	if (model.provider === "gemini") {
		const gemini = model as GeminiModel & { provider: "gemini" };
		return gemini.displayName ?? undefined;
	}
	return undefined;
}

function extractApiModelLimits(model: ApiModel): {
	contextWindow: number;
	maxTokens: number;
} {
	if (model.provider === "anthropic") {
		const anth = model as AnthropicModel & { provider: "anthropic" };
		return {
			contextWindow: anth.max_input_tokens ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: anth.max_tokens ?? DEFAULT_MAX_TOKENS,
		};
	}
	if (model.provider === "gemini") {
		const gem = model as GeminiModel & { provider: "gemini" };
		return {
			contextWindow: gem.inputTokenLimit ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: gem.outputTokenLimit ?? DEFAULT_MAX_TOKENS,
		};
	}
	return {
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

function apiFormatToPiApi(fmt: ApiFormat): PiApi {
	switch (fmt) {
		case "openai_responses":
			return "openai-responses";
		case "anthropic":
		case "anthropic_oauth":
			return "anthropic-messages";
		case "gemini":
			return "google-generative-ai";
		default:
			return "openai-completions";
	}
}

function apiFormatToProvider(fmt: ApiFormat): Provider {
	if (fmt === "anthropic" || fmt === "anthropic_oauth") return "anthropic";
	if (fmt === "gemini") return "google";
	return "openai";
}

function baseUrlForFormat(serverRoot: string, fmt: ApiFormat): string {
	if (fmt === "anthropic" || fmt === "anthropic_oauth") return `${serverRoot}/anthropic`;
	if (fmt === "gemini") return `${serverRoot}/v1beta`;
	return `${serverRoot}/v1`;
}

export function apiFormatOfModel(model: Model<Api>): ApiFormat {
	switch (model.api) {
		case "openai-responses":
			return "openai_responses";
		case "anthropic-messages":
			return "anthropic";
		case "google-generative-ai":
			return "gemini";
		default:
			return "openai";
	}
}
