import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  ActionDescriptor,
  Evidence,
  NfActionRuntime,
  NfExecutionRequest,
  NfExecutionResult,
  RecoveryAdapter,
} from "../core/types.js";

const execFileAsync = promisify(execFile);

interface WranglerKvTarget {
  readonly key: string;
  readonly value: string;
}

interface StoredValue {
  readonly dpcVersion: 1;
  readonly nfTaskId: string;
  readonly eventKey: string;
  readonly value: string;
}

export interface WranglerKvConfig {
  readonly namespaceId: string;
  readonly wranglerVersion?: string;
  readonly command?: string;
}

/**
 * Cloudflare KV adapter that delegates authentication and remote I/O to the
 * locally authenticated Wrangler CLI. It is intended for acceptance runs,
 * not for a long-lived production worker process.
 */
export class WranglerKvEffectRuntime implements NfActionRuntime, RecoveryAdapter {
  private readonly namespaceId: string;
  private readonly wranglerVersion: string;
  private readonly command: string;

  public constructor(config: WranglerKvConfig) {
    if (!config.namespaceId || !/^[A-Za-z0-9_-]+$/.test(config.namespaceId)) throw new Error("Wrangler KV adapter requires a safe namespaceId");
    this.namespaceId = config.namespaceId;
    this.wranglerVersion = config.wranglerVersion ?? "4.160.1";
    this.command = config.command ?? (process.platform === "win32" ? "npx.cmd" : "npx");
  }

  public async execute(request: NfExecutionRequest): Promise<NfExecutionResult> {
    const target = this.targetFrom(request.action);
    const existing = await this.get(target.key);
    if (existing) {
      if (!this.sameValue(existing, request, target)) {
        throw new Error(`Cloudflare KV key conflicts with another DPC identity: ${target.key}`);
      }
      return this.done(request, target, "idempotent-replay");
    }

    await this.run(
      "kv",
      "key",
      "put",
      target.key,
      this.encode({
        dpcVersion: 1,
        nfTaskId: request.identity.nfTaskId,
        eventKey: request.identity.eventKey,
        value: target.value,
      }),
      "--namespace-id",
      this.namespaceId,
      "--remote",
    );
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
    try {
      await this.run("kv", "key", "delete", target.key, "--namespace-id", this.namespaceId, "--remote");
    } catch (error) {
      if (!this.isMissing(error)) throw error;
    }
  }

  private async get(key: string): Promise<StoredValue | undefined> {
    let output: string;
    try {
      output = await this.run("kv", "key", "get", key, "--namespace-id", this.namespaceId, "--remote");
    } catch (error) {
      if (this.isMissing(error)) return undefined;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(this.decode(output));
      if (!parsed || typeof parsed !== "object") return undefined;
      const value = parsed as Record<string, unknown>;
      if (value.dpcVersion !== 1 || typeof value.nfTaskId !== "string" || typeof value.eventKey !== "string" || typeof value.value !== "string") return undefined;
      return value as unknown as StoredValue;
    } catch {
      return undefined;
    }
  }

  private async run(...args: string[]): Promise<string> {
    const childArgs = ["--yes", `wrangler@${this.wranglerVersion}`, ...args];
    const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : this.command;
    const commandArgs = process.platform === "win32"
      ? ["/d", "/s", "/c", [this.quoteCommand(this.command), ...childArgs].join(" ")]
      : childArgs;
    const result = await execFileAsync(command, commandArgs, {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  }

  private quoteCommand(value: string): string {
    return /^[A-Za-z0-9._-]+$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;
  }

  private encode(value: StoredValue): string {
    return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  }

  private decode(value: string): string {
    return Buffer.from(value.trim(), "base64url").toString("utf8");
  }

  private done(request: NfExecutionRequest, target: WranglerKvTarget, operation: string): NfExecutionResult {
    const evidence: Evidence = {
      reference: `cloudflare-kv:${target.key}`,
      kind: operation,
      observedAt: Date.now(),
      value: { key: target.key, via: "wrangler" },
    };
    return {
      status: "DONE",
      evidence: [evidence],
      output: { key: target.key, operation },
      identity: request.identity,
    };
  }

  private targetFrom(action: ActionDescriptor): WranglerKvTarget {
    if (action.actionType !== "cloudflare.kv.put") throw new Error(`Unsupported Cloudflare action type: ${action.actionType}`);
    if (!action.target || typeof action.target !== "object") throw new Error("Cloudflare KV target is required");
    const target = action.target as Record<string, unknown>;
    if (typeof target.key !== "string" || !target.key || typeof target.value !== "string") throw new Error("Cloudflare KV target requires a non-empty key and string value");
    if (!/^[A-Za-z0-9._/-]+$/.test(target.key)) throw new Error("Cloudflare KV key contains unsupported shell characters");
    if (new TextEncoder().encode(target.key).length > 512) throw new Error("Cloudflare KV key exceeds 512 bytes");
    return { key: target.key, value: target.value };
  }

  private sameValue(stored: StoredValue, request: NfExecutionRequest, target: WranglerKvTarget): boolean {
    return stored.nfTaskId === request.identity.nfTaskId && stored.eventKey === request.identity.eventKey && stored.value === target.value;
  }

  private isMissing(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { stderr?: unknown; message?: unknown };
    const text = `${String(candidate.stderr ?? "")} ${String(candidate.message ?? "")}`;
    return /\b404\b|not found/i.test(text);
  }
}
