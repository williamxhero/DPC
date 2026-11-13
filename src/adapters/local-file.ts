import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ActionDescriptor,
  ExecutionIdentity,
  Evidence,
  NfActionRuntime,
  NfExecutionRequest,
  NfExecutionResult,
  RecoveryAdapter,
} from "../core/types.js";

interface LocalFileTarget {
  readonly relativePath: string;
  readonly content: string;
}

interface EffectMarker {
  readonly nfTaskId: string;
  readonly eventKey: string;
  readonly relativePath: string;
  readonly content: string;
}

/**
 * A real, reversible side-effect adapter for local acceptance tests. It is
 * confined to one configured root and records an idempotency marker per NF
 * task, so the DPC Core can exercise the same write/readback seam as a remote
 * provider without touching production data.
 */
export class LocalFileEffectRuntime implements NfActionRuntime, RecoveryAdapter {
  private readonly rootDir: string;
  private readonly markerDir: string;
  private readonly clock: () => number;

  public constructor(rootDir: string, clock = () => Date.now()) {
    this.rootDir = path.resolve(rootDir);
    this.markerDir = path.join(this.rootDir, ".dpc-effects");
    this.clock = clock;
  }

  public async execute(request: NfExecutionRequest): Promise<NfExecutionResult> {
    const target = this.targetFrom(request.action);
    const targetPath = this.safePath(target.relativePath);
    const markerPath = this.markerPath(request.identity);
    const existingMarker = await this.readMarker(markerPath);

    if (existingMarker) {
      if (!this.sameMarker(existingMarker, request, target)) {
        throw new Error(`Idempotency marker conflicts for ${request.identity.nfTaskId}`);
      }
      try {
        const current = await readFile(targetPath, "utf8");
        if (current === target.content) {
          return this.done(request.identity, target, "idempotent-replay");
        }
      } catch (error) {
        if (!this.isMissing(error)) throw error;
      }
      return {
        status: "UNKNOWN",
        evidence: [this.evidence(target, "marker-without-matching-file")],
        identity: request.identity,
      };
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    let current: string | undefined;
    try {
      current = await readFile(targetPath, "utf8");
    } catch (error) {
      if (!this.isMissing(error)) throw error;
    }
    if (current !== undefined && current !== target.content) {
      throw new Error(`Refusing to overwrite a different local file: ${target.relativePath}`);
    }
    if (current === undefined) {
      await writeFile(targetPath, target.content, { encoding: "utf8", flag: "wx" });
    }

    await mkdir(this.markerDir, { recursive: true });
    const marker: EffectMarker = {
      nfTaskId: request.identity.nfTaskId,
      eventKey: request.identity.eventKey,
      relativePath: target.relativePath,
      content: target.content,
    };
    try {
      await writeFile(markerPath, JSON.stringify(marker), { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!this.isAlreadyExists(error)) throw error;
      const racedMarker = await this.readMarker(markerPath);
      if (!racedMarker || !this.sameMarker(racedMarker, request, target)) {
        throw new Error(`Concurrent idempotency marker conflict for ${request.identity.nfTaskId}`);
      }
    }

    return this.done(request.identity, target, "written");
  }

  public async readback(request: NfExecutionRequest): Promise<NfExecutionResult | undefined> {
    const target = this.targetFrom(request.action);
    const targetPath = this.safePath(target.relativePath);
    const marker = await this.readMarker(this.markerPath(request.identity));
    if (!marker || !this.sameMarker(marker, request, target)) {
      return undefined;
    }
    try {
      const current = await readFile(targetPath, "utf8");
      if (current !== target.content) return undefined;
    } catch (error) {
      if (this.isMissing(error)) return undefined;
      throw error;
    }
    return this.done(request.identity, target, "readback");
  }

  public async cleanup(action: ActionDescriptor, identity?: ExecutionIdentity): Promise<void> {
    const target = this.targetFrom(action);
    await rm(this.safePath(target.relativePath), { force: true });
    if (identity) {
      await rm(this.markerPath(identity), { force: true });
    }
  }

  private done(identity: ExecutionIdentity, target: LocalFileTarget, operation: string): NfExecutionResult {
    return {
      status: "DONE",
      evidence: [this.evidence(target, operation)],
      output: { relativePath: target.relativePath, operation },
      identity,
    };
  }

  private evidence(target: LocalFileTarget, operation: string): Evidence {
    return {
      reference: `local-file:${target.relativePath}`,
      kind: operation,
      observedAt: this.clock(),
      value: { relativePath: target.relativePath },
    };
  }

  private targetFrom(action: ActionDescriptor): LocalFileTarget {
    if (action.actionType !== "local.file.write") {
      throw new Error(`Unsupported local action type: ${action.actionType}`);
    }
    if (!action.target || typeof action.target !== "object") {
      throw new Error("Local file action target is required");
    }
    const candidate = action.target as Record<string, unknown>;
    if (typeof candidate.relativePath !== "string" || typeof candidate.content !== "string") {
      throw new Error("Local file action target requires relativePath and string content");
    }
    return { relativePath: candidate.relativePath, content: candidate.content };
  }

  private safePath(relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error("Local file path must be a non-empty relative path");
    }
    const target = path.resolve(this.rootDir, relativePath);
    const relative = path.relative(this.rootDir, target);
    const normalized = relative.split(path.sep).join("/");
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || normalized === ".dpc-effects" || normalized.startsWith(".dpc-effects/")) {
      throw new Error("Local file path escapes the configured root");
    }
    return target;
  }

  private markerPath(identity: ExecutionIdentity): string {
    return path.join(this.markerDir, `${encodeURIComponent(identity.nfTaskId)}.json`);
  }

  private async readMarker(markerPath: string): Promise<EffectMarker | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(markerPath, "utf8"));
      if (!parsed || typeof parsed !== "object") return undefined;
      const marker = parsed as Record<string, unknown>;
      if (typeof marker.nfTaskId !== "string" || typeof marker.eventKey !== "string" || typeof marker.relativePath !== "string" || typeof marker.content !== "string") {
        return undefined;
      }
      return marker as unknown as EffectMarker;
    } catch (error) {
      if (this.isMissing(error)) return undefined;
      throw error;
    }
  }

  private sameMarker(marker: EffectMarker, request: NfExecutionRequest, target: LocalFileTarget): boolean {
    return marker.nfTaskId === request.identity.nfTaskId
      && marker.eventKey === request.identity.eventKey
      && marker.relativePath === target.relativePath
      && marker.content === target.content;
  }

  private isMissing(error: unknown): boolean {
    return this.errorCode(error) === "ENOENT";
  }

  private isAlreadyExists(error: unknown): boolean {
    return this.errorCode(error) === "EEXIST";
  }

  private errorCode(error: unknown): string | undefined {
    return error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  }
}
