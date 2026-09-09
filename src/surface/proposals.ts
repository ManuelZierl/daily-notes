import type { Task } from "../shared/types";
import { archiveTaskTree } from "../shared/tasks";
import { MAX_ID_LENGTH, MAX_TASK_TEXT_LENGTH } from "../shared/limits.mjs";

export const APP_ID = "kestral.daily-notes";
export const TASK_PROPOSAL_ARTIFACT = "task-change-proposal";

export const TASK_PROPOSAL_PAYLOAD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["operations"],
  properties: {
    operations: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "text"],
            properties: {
              kind: { const: "create" },
              text: { type: "string", minLength: 1, maxLength: 500, pattern: "^[^\\r\\n]*$" },
              parentId: { anyOf: [{ type: "string", minLength: 1, maxLength: 256 }, { type: "null" }] },
              checked: { type: "boolean" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "taskId"],
            anyOf: [{ required: ["text"] }, { required: ["checked"] }],
            properties: {
              kind: { const: "update" },
              taskId: { type: "string", minLength: 1, maxLength: 256 },
              text: { type: "string", maxLength: 500, pattern: "^[^\\r\\n]*$" },
              checked: { type: "boolean" },
            },
          },
        ],
      },
    },
  },
} as const;

export const TASK_PROPOSAL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["targetGeneration", "payload"],
  properties: {
    targetGeneration: {
      type: "integer",
      minimum: 0,
      "x-kestral-managed-data-scope": { kind: "collection", collection: "tasks" },
    },
    payload: TASK_PROPOSAL_PAYLOAD_SCHEMA,
  },
  "x-kestral-managed-data-proposal": true,
} as const;

export const TASK_PROPOSAL_ARTIFACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["targetAppId", "targetKind", "collection", "resourceId", "targetGeneration", "targetRevision", "payload"],
  properties: {
    targetAppId: { const: APP_ID },
    targetKind: { const: "collection" },
    collection: { const: "tasks" },
    resourceId: { type: "string", minLength: 1, maxLength: 256 },
    targetGeneration: { type: "integer", minimum: 0 },
    targetRevision: { type: ["integer", "null"], minimum: 1 },
    payload: TASK_PROPOSAL_PAYLOAD_SCHEMA,
  },
} as const;

type RawCreate = { kind: "create"; text: string; parentId?: string | null; checked?: boolean };
type RawUpdate = { kind: "update"; taskId: string; text?: string; checked?: boolean };
export type TaskProposalOperation = RawCreate | RawUpdate;
export type TaskProposalPayload = { operations: TaskProposalOperation[] };

export interface ProposalArtifact {
  artifact_id: string;
  artifact_type: string;
  title: string;
  content: unknown;
  provenance: unknown;
}

export interface ParsedTaskProposal {
  artifactId: string;
  title: string;
  targetGeneration: number;
  payload: TaskProposalPayload;
  effects: string[];
}

export interface ProposalReview {
  artifact: ProposalArtifact;
  parsed: ParsedTaskProposal | null;
  state: "ready" | "stale" | "replayed" | "invalid";
  reason: string;
}

export class ProposalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalValidationError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProposalValidationError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ProposalValidationError(`${label} must be a non-empty string`);
  return value;
}

function identifier(value: unknown, label: string): string {
  const result = string(value, label);
  if (Array.from(result).length > MAX_ID_LENGTH) throw new ProposalValidationError(`${label} exceeds ${MAX_ID_LENGTH} characters`);
  return result;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new ProposalValidationError(`${label} has unknown or missing fields`);
}

function parseOperation(value: unknown, index: number): TaskProposalOperation {
  const operation = object(value, `payload.operations[${index}]`);
  if (operation.kind === "create") {
    exactKeys(operation, ["kind", "text", "parentId", "checked"].filter((key) => Object.hasOwn(operation, key)), `payload.operations[${index}]`);
    const text = string(operation.text, `payload.operations[${index}].text`);
    if (Array.from(text).length > MAX_TASK_TEXT_LENGTH || text.includes("\r") || text.includes("\n")) throw new ProposalValidationError(`payload.operations[${index}].text is invalid`);
    if (operation.parentId !== undefined && operation.parentId !== null) identifier(operation.parentId, `payload.operations[${index}].parentId`);
    if (operation.checked !== undefined && typeof operation.checked !== "boolean") throw new ProposalValidationError(`payload.operations[${index}].checked is invalid`);
    return { kind: "create", text, ...(operation.parentId !== undefined ? { parentId: operation.parentId as string | null } : {}), ...(operation.checked !== undefined ? { checked: operation.checked } : {}) };
  }
  if (operation.kind === "update") {
    exactKeys(operation, ["kind", "taskId", ...(Object.hasOwn(operation, "text") ? ["text"] : []), ...(Object.hasOwn(operation, "checked") ? ["checked"] : [])], `payload.operations[${index}]`);
    const taskId = identifier(operation.taskId, `payload.operations[${index}].taskId`);
    if (!Object.hasOwn(operation, "text") && !Object.hasOwn(operation, "checked")) throw new ProposalValidationError(`payload.operations[${index}] must change text or checked`);
    if (operation.text !== undefined && (typeof operation.text !== "string" || Array.from(operation.text).length > MAX_TASK_TEXT_LENGTH || operation.text.includes("\r") || operation.text.includes("\n"))) throw new ProposalValidationError(`payload.operations[${index}].text is invalid`);
    if (operation.checked !== undefined && typeof operation.checked !== "boolean") throw new ProposalValidationError(`payload.operations[${index}].checked is invalid`);
    return { kind: "update", taskId, ...(operation.text !== undefined ? { text: operation.text } : {}), ...(operation.checked !== undefined ? { checked: operation.checked } : {}) };
  }
  throw new ProposalValidationError(`payload.operations[${index}].kind is invalid`);
}

export function parseTaskProposalArtifact(value: unknown): ParsedTaskProposal {
  const artifact = object(value, "artifact");
  const content = object(artifact.content, "artifact.content");
  if (artifact.artifact_type !== TASK_PROPOSAL_ARTIFACT) throw new ProposalValidationError("artifact type is not a Daily Notes task proposal");
  exactKeys(content, ["targetAppId", "targetKind", "collection", "resourceId", "targetGeneration", "targetRevision", "payload"], "artifact.content");
  if (content.targetAppId !== APP_ID || content.targetKind !== "collection" || content.collection !== "tasks") throw new ProposalValidationError("artifact target is not the Daily Notes tasks collection");
  if (content.resourceId !== `app-data:${APP_ID}:tasks`) throw new ProposalValidationError("artifact resource identity does not match the Daily Notes tasks collection");
  if (!Number.isSafeInteger(content.targetGeneration) || (content.targetGeneration as number) < 0) throw new ProposalValidationError("artifact targetGeneration is invalid");
  if (content.targetRevision !== null) throw new ProposalValidationError("collection proposal targetRevision must be null");
  const payload = object(content.payload, "artifact.content.payload");
  exactKeys(payload, ["operations"], "artifact.content.payload");
  if (!Array.isArray(payload.operations) || payload.operations.length < 1 || payload.operations.length > 32) throw new ProposalValidationError("proposal operation count is invalid");
  const operations = payload.operations.map(parseOperation);
  const title = string(artifact.title, "artifact.title");
  return {
    artifactId: string(artifact.artifact_id, "artifact.artifact_id"),
    title,
    targetGeneration: content.targetGeneration as number,
    payload: { operations },
    effects: operations.map((operation) => {
      if (operation.kind === "create") {
        const parent = operation.parentId ? ` under ${operation.parentId}` : "";
        const completion = operation.checked ? (operation.parentId ? " (completed)" : " (completed; archived root)") : "";
        return `Add task${parent}: ${operation.text}${completion}`;
      }
      const changes = [
        ...(operation.text !== undefined ? [`text → ${JSON.stringify(operation.text)}`] : []),
        ...(operation.checked === undefined ? [] : [operation.checked ? "mark complete (archives the tree if this is a root)" : "mark incomplete"]),
      ];
      return `Update task ${operation.taskId}: ${changes.join("; ")}`;
    }),
  };
}

export function reviewTaskProposalArtifacts(values: unknown[], replayedIds: Set<string>, generation: number): ProposalReview[] {
  return values.filter((value) => {
    try { return object(value, "artifact").artifact_type === TASK_PROPOSAL_ARTIFACT; } catch { return false; }
  }).map((value) => {
    const artifact = value as ProposalArtifact;
    try {
      const parsed = parseTaskProposalArtifact(artifact);
      if (replayedIds.has(parsed.artifactId)) return { artifact, parsed, state: "replayed", reason: "Already handled." };
      if (parsed.targetGeneration !== generation) return { artifact, parsed, state: "stale", reason: `This proposal targets generation ${parsed.targetGeneration}; the workspace is now at generation ${generation}.` };
      return { artifact, parsed, state: "ready", reason: "Review the proposed task changes before applying them." };
    } catch (error) {
      return { artifact, parsed: null, state: "invalid", reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function applyProposalOperations(tasks: Task[], operations: TaskProposalOperation[], timestamp = new Date().toISOString(), id: () => string = () => crypto.randomUUID()): { tasks: Task[]; error?: string } {
  let next = structuredClone(tasks);
  let order = next.filter((task) => task.parent_id === null && task.archived_at === null).length;
  for (const operation of operations) {
    if (operation.kind === "create") {
      if (operation.parentId !== undefined && operation.parentId !== null && !next.some((task) => task.id === operation.parentId && task.archived_at === null)) return { tasks, error: `parent task '${operation.parentId}' is not active` };
      const createdAt = timestamp;
      next.push({ id: `task-${id()}`, parent_id: operation.parentId ?? null, text: operation.text, checked: operation.checked ?? false, order: operation.parentId === undefined || operation.parentId === null ? order++ : next.filter((task) => task.parent_id === operation.parentId && task.archived_at === null).length, created_at: createdAt, updated_at: createdAt, completed_at: operation.checked ? createdAt : null, archived_at: operation.checked && (operation.parentId === undefined || operation.parentId === null) ? createdAt : null });
    } else {
      const task = next.find((candidate) => candidate.id === operation.taskId && candidate.archived_at === null);
      if (!task) return { tasks, error: `task '${operation.taskId}' is not active` };
      if (operation.text !== undefined) task.text = operation.text;
      if (operation.checked !== undefined) {
        task.checked = operation.checked;
        task.completed_at = operation.checked ? timestamp : null;
        if (task.parent_id === null && operation.checked) {
          next = archiveTaskTree(next, task.id, timestamp);
        }
      }
      task.updated_at = timestamp;
    }
  }
  next.filter((task) => task.parent_id === null && task.archived_at === null)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .forEach((task, index) => { task.order = index; });
  return { tasks: next };
}
