export interface CapabilityRef {
  provider: string;
  capability: string;
}

export interface SurfaceBridge {
  ready(): void;
  reportError(message: string): void;
  onEvent?(callback: () => void): void;
  listArtifacts(): Promise<unknown>;
  invoke(capability: CapabilityRef, input: Record<string, unknown>): Promise<unknown>;
  getState(key: string): Promise<SurfaceStateEntry>;
  putState(key: string, expectedRevision: number, value: Record<string, unknown> | null): Promise<SurfaceStateEntry>;
}

export interface SurfaceStateEntry {
  revision: number;
  value: Record<string, unknown> | null;
}

export type InvocationResult =
  | { kind: "completed"; value: unknown }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; error: string };

export class SurfaceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceContractError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readSurfaceBridge(value: unknown): SurfaceBridge | null {
  if (!isObject(value) || typeof value.ready !== "function" || typeof value.reportError !== "function" || typeof value.invoke !== "function" || typeof value.listArtifacts !== "function" || typeof value.getState !== "function" || typeof value.putState !== "function") return null;
  if (value.onEvent !== undefined && typeof value.onEvent !== "function") return null;
  return value as unknown as SurfaceBridge;
}

export function parseInvocationResult(value: unknown): InvocationResult {
  if (!isObject(value) || !isObject(value.result) || typeof value.result.kind !== "string") {
    throw new SurfaceContractError("Kestral returned a malformed invocation result");
  }
  switch (value.result.kind) {
    case "completed":
      if (!Object.hasOwn(value.result, "result")) throw new SurfaceContractError("Kestral returned a completed invocation without a result");
      return { kind: "completed", value: value.result.result };
    case "refused":
      if (typeof value.result.reason !== "string") throw new SurfaceContractError("Kestral returned a refusal without a reason");
      return { kind: "refused", reason: value.result.reason };
    case "failed":
      if (typeof value.result.error !== "string") throw new SurfaceContractError("Kestral returned a failure without an error message");
      return { kind: "failed", error: value.result.error };
    default:
      throw new SurfaceContractError(`Kestral returned an unknown invocation result '${value.result.kind}'`);
  }
}

export function parseLlmContent(value: unknown): string {
  if (!isObject(value) || !isObject(value.message) || typeof value.message.content !== "string") {
    throw new SurfaceContractError("The LLM provider returned a malformed response");
  }
  return value.message.content;
}
