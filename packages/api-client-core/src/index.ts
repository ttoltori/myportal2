export interface ApiClientConfig {
  baseUrl: string;
  timeout?: number;
  getAccessToken?: () => string | null | undefined;
  fetch?: typeof fetch;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details: unknown | null;
  };
  meta?: { requestId: string };
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  meta?: { requestId: string };
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function httpRequest<T>(
  config: ApiClientConfig,
  method: string,
  path: string,
  options?: {
    body?: unknown;
    query?: Record<string, string | number | boolean | null | undefined>;
    signal?: AbortSignal;
  },
): Promise<T> {
  const fetchFn = config.fetch ?? fetch;
  const timeout = config.timeout ?? 15000;

  const url = new URL(`${config.baseUrl}${path}`);
  if (options?.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value != null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  if (options?.signal) {
    options.signal.addEventListener("abort", () => controller.abort());
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const token = config.getAccessToken?.();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const response = await fetchFn(url.toString(), {
      method,
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const json = (await response.json()) as ApiSuccessResponse<T> | ApiErrorResponse;

    if (!json.success) {
      throw new ApiError(json.error.code, json.error.message, response.status, json.error.details);
    }

    return json.data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new ApiError("TIMEOUT", "Request timed out", 408);
    }
    throw new ApiError("NETWORK_ERROR", "Network request failed", 0);
  } finally {
    clearTimeout(timeoutId);
  }
}
