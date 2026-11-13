import type {
  ActionDescriptor,
  Evidence,
  NfActionRuntime,
  NfExecutionRequest,
  NfExecutionResult,
  RecoveryAdapter,
} from "../core/types.js";

interface CloudflareKvTarget {
  readonly key: string;
  readonly value: string;
}

interface StoredValue {
  readonly dpcVersion: 1;
  readonly nfTaskId: string;
  readonly eventKey: string;
  readonly value: string;
}

interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

type FetchLike = (url: string, init: {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}) => Promise<HttpResponse>;

export interface CloudflareKvConfig {
  readonly accountId: string;
  readonly namespaceId: string;
  readonly apiToken: string;
  readonly baseUrl?: string;
}

/**
 * Cloudflare KV adapter for the final T7 acceptance. It uses a disposable KV
 * key as the external effect, stores the DPC identity in the value, and only
 * overwrites a value when the same identity is replayed.
 */
export class CloudflareKvEffectRuntime implements NfActionRuntime, RecoveryAdapter {
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;

  public constructor(config: CloudflareKvConfig, fetcher?: FetchLike) {
    this.baseUrl = (config.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
    this.fetcher = fetcher ?? (globalThis.fetch as unknown as FetchLike);
    if (!config.accountId || !config.namespaceId || !config.apiToken) {
      throw new Error("Cloudflare KV adapter requires accountId, namespaceId, and apiToken");
    }
    this.accountId = config.accountId;
    this.namespaceId = config.namespaceId;
    this.apiToken = config.apiToken;
  }

  private readonly accountId: string;
  private readonly namespaceId: string;
  private readonly apiToken: string;

  public async execute(request: NfExecutionRequest): Promise<NfExecutionResult> {
    const target = this.targetFrom(request.action);
    const existing = await this.get(target.key);
    if (existing) {
      if (!this.sameValue(existing, request, target)) {
        throw new Error(`Cloudflare KV key conflicts with another DPC identity: ${target.key}`);
      }
      return this.done(request, target, "idempotent-replay");
    }

    const stored: StoredValue = {
      dpcVersion: 1,
      nfTaskId: request.identity.nfTaskId,
      eventKey: request.identity.eventKey,
      value: target.value,
    };
    await this.put(target.key, stored);
    return this.done(request, target, "written");
  }

  public async readback(request: NfExecutionRequest): Promise<NfExecutionResult | undefined> {
    const target = this.targetFrom(request.action);
    const existing = await this.get(target.key);
    if (!existing || !this.sameValue(existing, request, target)) return undefined;
    return this.done(request, target, "readback");
  }

  public async cleanup(action: ActionDescriptor): Promise<void> {
    const target = this.targetFrom(action);
    const response = await this.fetcher(this.url(target.key), {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!response.ok && response.status !== 404) {
      throw new Error(`Cloudflare KV delete failed with status ${response.status}`);
    }
  }

  private async get(key: string): Promise<StoredValue | undefined> {
    const response = await this.fetcher(this.url(key), {
      method: "GET",
      headers: this.headers(),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Cloudflare KV read failed with status ${response.status}`);
    const body = await response.text();
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object") return undefined;
      const value = parsed as Record<string, unknown>;
      if (value.dpcVersion !== 1 || typeof value.nfTaskId !== "string" || typeof value.eventKey !== "string" || typeof value.value !== "string") {
        return undefined;
      }
      return value as unknown as StoredValue;
    } catch {
      return undefined;
    }
  }

  private async put(key: string, value: StoredValue): Promise<void> {
    const response = await this.fetcher(this.url(key), {
      method: "PUT",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!response.ok) throw new Error(`Cloudflare KV write failed with status ${response.status}`);
    const body = await response.text();
    if (body) {
      try {
        const result = JSON.parse(body) as { success?: boolean };
        if (result.success === false) throw new Error("Cloudflare KV returned success=false");
      } catch (error) {
        if (error instanceof Error && error.message === "Cloudflare KV returned success=false") throw error;
      }
    }
  }

  private done(request: NfExecutionRequest, target: CloudflareKvTarget, operation: string): NfExecutionResult {
    const evidence: Evidence = {
      reference: `cloudflare-kv:${target.key}`,
      kind: operation,
      observedAt: Date.now(),
      value: { key: target.key },
    };
    return {
      status: "DONE",
      evidence: [evidence],
      output: { key: target.key, operation },
      identity: request.identity,
    };
  }

  private targetFrom(action: ActionDescriptor): CloudflareKvTarget {
    if (action.actionType !== "cloudflare.kv.put") {
      throw new Error(`Unsupported Cloudflare action type: ${action.actionType}`);
    }
    if (!action.target || typeof action.target !== "object") throw new Error("Cloudflare KV target is required");
    const target = action.target as Record<string, unknown>;
    if (typeof target.key !== "string" || !target.key || typeof target.value !== "string") {
      throw new Error("Cloudflare KV target requires a non-empty key and string value");
    }
    if (new TextEncoder().encode(target.key).length > 512) throw new Error("Cloudflare KV key exceeds 512 bytes");
    return { key: target.key, value: target.value };
  }

  private sameValue(stored: StoredValue, request: NfExecutionRequest, target: CloudflareKvTarget): boolean {
    return stored.nfTaskId === request.identity.nfTaskId
      && stored.eventKey === request.identity.eventKey
      && stored.value === target.value;
  }

  private url(key: string): string {
    return `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}/storage/kv/namespaces/${encodeURIComponent(this.namespaceId)}/values/${encodeURIComponent(key)}`;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiToken}` };
  }
}
