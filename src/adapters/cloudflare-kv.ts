import type {
  ActionDescriptor,
  Evidence,
  ExecutionIdentity,
  NfActionRuntime,
  NfExecutionRequest,
  NfExecutionResult,
  RecoveryAdapter,
} from "../core/types.js";
import { sameStableExecutionIdentity } from "../core/identity.js";

interface CloudflareKvTarget {
  readonly key: string;
  readonly value: string;
}

interface StoredValue {
  readonly dpcVersion: 1;
  readonly programId: string;
  readonly planId: string;
  readonly planRevision: string;
  readonly actionId: string;
  readonly eventKey: string;
  readonly nfTaskId: string;
  readonly runGeneration: number;
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
const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

export class CloudflareKvEffectRuntime implements NfActionRuntime, RecoveryAdapter {
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;

  public constructor(config: CloudflareKvConfig, fetcher?: FetchLike) {
    const baseUrl = (config.baseUrl ?? CLOUDFLARE_API_BASE_URL).replace(/\/$/, "");
    this.validateBaseUrl(baseUrl, fetcher !== undefined);
    this.baseUrl = baseUrl;
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
      programId: request.identity.programId,
      planId: request.identity.planId,
      planRevision: request.identity.planRevision,
      actionId: request.identity.actionId,
      eventKey: request.identity.eventKey,
      nfTaskId: request.identity.nfTaskId,
      runGeneration: request.identity.runGeneration,
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

  public async cleanup(action: ActionDescriptor, identity: ExecutionIdentity): Promise<void> {
    const target = this.targetFrom(action);
    const existing = await this.get(target.key);
    if (!existing) return;
    if (!sameStableExecutionIdentity(existing, identity) || existing.value !== target.value) {
      throw new Error(`Cloudflare KV cleanup refused an unowned key: ${target.key}`);
    }
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new Error(`Cloudflare KV key contains an unrecognized value: ${key}`, { cause: error });
    }
    if (!this.isStoredValue(parsed)) {
      throw new Error(`Cloudflare KV key contains an unrecognized value: ${key}`);
    }
    return parsed;
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
    return sameStableExecutionIdentity(stored, request.identity)
      && stored.value === target.value;
  }

  private isStoredValue(value: unknown): value is StoredValue {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Record<string, unknown>;
    return candidate.dpcVersion === 1
      && typeof candidate.programId === "string"
      && typeof candidate.planId === "string"
      && typeof candidate.planRevision === "string"
      && typeof candidate.actionId === "string"
      && typeof candidate.eventKey === "string"
      && typeof candidate.nfTaskId === "string"
      && typeof candidate.runGeneration === "number"
      && Number.isInteger(candidate.runGeneration)
      && typeof candidate.value === "string";
  }

  private validateBaseUrl(baseUrl: string, hasInjectedFetcher: boolean): void {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error("Cloudflare KV baseUrl must be a valid URL");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("Cloudflare KV baseUrl must use HTTPS");
    }
    if (!hasInjectedFetcher && baseUrl !== CLOUDFLARE_API_BASE_URL) {
      throw new Error("Cloudflare KV baseUrl must be the official API origin");
    }
  }

  private url(key: string): string {
    return `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}/storage/kv/namespaces/${encodeURIComponent(this.namespaceId)}/values/${encodeURIComponent(key)}`;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiToken}` };
  }
}
