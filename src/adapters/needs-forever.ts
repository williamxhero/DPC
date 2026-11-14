import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

type ControlRunner = (args: readonly string[], cwd: string) => Promise<string>;

interface LocalFileTarget {
  readonly relativePath: string;
  readonly content: string;
}

interface ControlStatus {
  readonly status?: string;
  readonly phase?: string;
  readonly state_path?: string;
}

export interface NeedsForeverLocalFileConfig {
  /** Absolute path to the installed Needs Forever scripts/control.mjs. */
  readonly controlPath: string;
  /** Disposable root below which one workspace is created per NF task. */
  readonly rootDir: string;
  readonly nodePath?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxWorkerTurns?: number;
  readonly maxMinutes?: number;
  readonly clock?: () => number;
  /** Test seam; production uses execFile with argv separation. */
  readonly runner?: ControlRunner;
}

/**
 * Runs a narrowly-scoped local-file action through the real Needs Forever
 * independent-worker control path. It is an acceptance adapter, not a generic
 * NF API client: the action target is confined to a disposable workspace and
 * the only durable external effect is the verified file content.
 */
export class NeedsForeverLocalFileRuntime implements NfActionRuntime, RecoveryAdapter {
  private readonly controlPath: string;
  private readonly rootDir: string;
  private readonly nodePath: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxWorkerTurns: number | null;
  private readonly maxMinutes: number | null;
  private readonly clock: () => number;
  private readonly runner: ControlRunner;

  public constructor(config: NeedsForeverLocalFileConfig) {
    if (!path.isAbsolute(config.controlPath)) throw new Error("Needs Forever controlPath must be absolute");
    if (!path.isAbsolute(config.rootDir)) throw new Error("Needs Forever rootDir must be absolute");
    this.controlPath = path.resolve(config.controlPath);
    this.rootDir = path.resolve(config.rootDir);
    this.nodePath = config.nodePath ?? process.execPath;
    this.timeoutMs = config.timeoutMs ?? 300_000;
    this.pollIntervalMs = config.pollIntervalMs ?? 1_000;
    this.maxWorkerTurns = config.maxWorkerTurns ?? 8;
    this.maxMinutes = config.maxMinutes ?? 5;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("Needs Forever timeoutMs must be positive");
    if (!Number.isInteger(this.pollIntervalMs) || this.pollIntervalMs <= 0) throw new Error("Needs Forever pollIntervalMs must be positive");
    this.clock = config.clock ?? (() => Date.now());
    this.runner = config.runner ?? ((args, cwd) => this.execControl(args, cwd));
  }

  public async execute(request: NfExecutionRequest): Promise<NfExecutionResult> {
    const target = this.targetFrom(request.action);
    const workspace = this.workspaceFor(request.identity);
    const targetPath = this.safePath(workspace, target.relativePath);
    const existing = await this.readback(request);
    if (existing) return existing;

    await mkdir(workspace, { recursive: true });
    const taskPath = path.join(workspace, "task.json");
    const verifyPath = path.join(workspace, "verify.mjs");
    const identityPath = path.join(workspace, "identity.json");
    const statePath = path.join(workspace, "state.json");
    await this.writeTaskFiles(taskPath, verifyPath, identityPath, request.identity, workspace, target);

    let started: ControlStatus;
    try {
      started = this.parseStatus(await this.runner([
        "start",
        "--control-mode",
        "independent-worker",
        "--task",
        taskPath,
        "--state",
        statePath,
      ], workspace));
    } catch (error) {
      return this.unknown(request.identity, "nf-start-unknown", error);
    }

    const deadline = this.clock() + this.timeoutMs;
    let status = started;
    while (this.clock() <= deadline) {
      if (status.status === "DONE") return this.completed(request.identity, "nf-done", status);
      if (status.status === "WAIT_EXTERNAL") return this.waiting(request.identity, status);
      if (status.status === "PAUSED" || status.status === "INTERRUPTED") {
        return this.unknown(request.identity, `nf-${String(status.status).toLowerCase()}`, status);
      }
      await this.delay(this.pollIntervalMs);
      try {
        status = this.parseStatus(await this.runner(["status", "--state", statePath], workspace));
      } catch (error) {
        return this.unknown(request.identity, "nf-status-unknown", error);
      }
    }
    return this.unknown(request.identity, "nf-observation-timeout", status);
  }

  public async readback(request: NfExecutionRequest): Promise<NfExecutionResult | undefined> {
    const target = this.targetFrom(request.action);
    const workspace = this.workspaceFor(request.identity);
    const marker = await this.readIdentity(workspace);
    if (!marker || !sameStableExecutionIdentity(marker, request.identity)) return undefined;
    const targetPath = this.safePath(workspace, target.relativePath);
    try {
      const actual = await readFile(targetPath, "utf8");
      if (actual !== target.content) {
        return {
          status: "FAILED",
          evidence: [this.evidence(request.identity, "readback-conflict")],
          error: "NF workspace contains a different file value",
          identity: request.identity,
        };
      }
      return this.completed(request.identity, "nf-readback", { status: "DONE" });
    } catch (error) {
      if (this.errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  public async cleanup(action: ActionDescriptor, identity: ExecutionIdentity): Promise<void> {
    this.targetFrom(action);
    const workspace = this.workspaceFor(identity);
    const marker = await this.readIdentity(workspace);
    if (!marker) return;
    if (!sameStableExecutionIdentity(marker, identity)) {
      throw new Error(`Needs Forever cleanup refused an unowned workspace: ${workspace}`);
    }
    const statePath = path.join(workspace, "state.json");
    try {
      await this.runner(["pause", "--state", statePath], workspace);
    } catch {
      // DONE/absent tasks do not accept pause; cleanup still removes only the
      // adapter-owned disposable workspace below rootDir.
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(workspace, { recursive: true, force: true });
        return;
      } catch (error) {
        const code = this.errorCode(error);
        if (code !== "EBUSY" && code !== "EPERM") throw error;
        await this.delay(250);
      }
    }
    throw new Error(`Needs Forever workspace remained busy: ${workspace}`);
  }

  private async writeTaskFiles(
    taskPath: string,
    verifyPath: string,
    identityPath: string,
    identity: ExecutionIdentity,
    workspace: string,
    target: LocalFileTarget,
  ): Promise<void> {
    const task = {
      schema_version: 1,
      task_id: this.taskId(identity),
      workspace,
      goal: `Create ${target.relativePath} with the exact acceptance content and run the verifier.`,
      acceptance: [
        { id: "A1", text: `${target.relativePath} exists with the exact required content.` },
        { id: "A2", text: "The independent verifier exits successfully." },
      ],
      authorization: "Only modify files inside this disposable workspace and run the local verifier; do not access networks, credentials, or any other project.",
      limits: {
        max_worker_turns: this.maxWorkerTurns,
        max_minutes: this.maxMinutes,
      },
      verify: {
        argv: ["node", "verify.mjs"],
        timeout_seconds: 30,
        protected_files: ["verify.mjs"],
      },
    };
    const verify = `import { readFile } from "node:fs/promises";\nconst expected = ${JSON.stringify(target.content)};\nconst actual = await readFile(${JSON.stringify(target.relativePath)}, "utf8");\nif (actual !== expected) process.exit(1);\nconsole.log(JSON.stringify({ ok: true, file: ${JSON.stringify(target.relativePath)} }));\n`;
    await writeFile(taskPath, JSON.stringify(task, null, 2), { encoding: "utf8", flag: "wx" });
    await writeFile(verifyPath, verify, { encoding: "utf8", flag: "wx" });
    await writeFile(identityPath, JSON.stringify(identity, null, 2), { encoding: "utf8", flag: "wx" });
  }

  private async execControl(args: readonly string[], cwd: string): Promise<string> {
    const result = await execFileAsync(this.nodePath, [this.controlPath, ...args], {
      cwd,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  }

  private parseStatus(output: string): ControlStatus {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object") throw new Error("Needs Forever control returned a non-object result");
    return parsed as ControlStatus;
  }

  private async readIdentity(workspace: string): Promise<ExecutionIdentity | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(workspace, "identity.json"), "utf8"));
      if (!parsed || typeof parsed !== "object") return undefined;
      const candidate = parsed as Record<string, unknown>;
      if (typeof candidate.programId !== "string"
        || typeof candidate.planId !== "string"
        || typeof candidate.planRevision !== "string"
        || typeof candidate.actionId !== "string"
        || typeof candidate.eventKey !== "string"
        || typeof candidate.nfTaskId !== "string"
        || typeof candidate.runGeneration !== "number"
        || typeof candidate.claimFence !== "number") return undefined;
      return candidate as unknown as ExecutionIdentity;
    } catch (error) {
      if (this.errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
  }

  private workspaceFor(identity: ExecutionIdentity): string {
    return path.join(this.rootDir, encodeURIComponent(identity.nfTaskId));
  }

  private taskId(identity: ExecutionIdentity): string {
    return `dpc-${identity.nfTaskId.replace(/[^A-Za-z0-9_.-]/g, "-")}`.slice(0, 80);
  }

  private safePath(workspace: string, relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) throw new Error("NF local file path must be a non-empty relative path");
    const target = path.resolve(workspace, relativePath);
    const relative = path.relative(workspace, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("NF local file path escapes the disposable workspace");
    }
    return target;
  }

  private targetFrom(action: ActionDescriptor): LocalFileTarget {
    if (action.actionType !== "needs-forever.local.file.write") {
      throw new Error(`Unsupported Needs Forever action type: ${action.actionType}`);
    }
    if (!action.target || typeof action.target !== "object") throw new Error("Needs Forever local target is required");
    const target = action.target as Record<string, unknown>;
    if (typeof target.relativePath !== "string" || typeof target.content !== "string") {
      throw new Error("Needs Forever local target requires relativePath and string content");
    }
    return { relativePath: target.relativePath, content: target.content };
  }

  private completed(identity: ExecutionIdentity, operation: string, status: ControlStatus): NfExecutionResult {
    return {
      status: "DONE",
      evidence: [this.evidence(identity, operation)],
      output: { taskId: this.taskId(identity), nfStatus: status.status ?? "DONE" },
      identity,
    };
  }

  private waiting(identity: ExecutionIdentity, status: ControlStatus): NfExecutionResult {
    return {
      status: "WAIT_EXTERNAL",
      evidence: [this.evidence(identity, "nf-wait-external")],
      output: { taskId: this.taskId(identity), nfStatus: status.status },
      identity,
    };
  }

  private unknown(identity: ExecutionIdentity, operation: string, detail: unknown): NfExecutionResult {
    return {
      status: "UNKNOWN",
      evidence: [this.evidence(identity, operation)],
      output: { taskId: this.taskId(identity), detail: detail instanceof Error ? detail.message : detail },
      identity,
    };
  }

  private evidence(identity: ExecutionIdentity, operation: string): Evidence {
    return {
      reference: `needs-forever:${identity.nfTaskId}`,
      kind: operation,
      observedAt: this.clock(),
      value: { taskId: this.taskId(identity) },
    };
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private errorCode(error: unknown): string | undefined {
    return error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  }
}
