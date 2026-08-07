import { MAX_NOTE_LENGTH, MAX_TASK_TEXT_LENGTH } from "./shared/limits.mjs";

export const APP_VERSION = "0.2.1";

const ID = { type: "string", minLength: 1, maxLength: 256 };
const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const TIMESTAMP = { anyOf: [{ type: "string", minLength: 1, maxLength: 64 }, { type: "null" }] };

const valueSchema = (properties, required) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const dataCollections = {
  days: {
    schema: valueSchema({ id: ID, local_date: DATE, title: DATE }, ["id", "local_date", "title"]),
    indexes: [],
    operations: ["get", "list", "create", "replace", "delete", "transaction"],
    limits: { records: 10000, record_bytes: 65536, query_results: 1000 },
  },
  tasks: {
    schema: valueSchema({
      id: ID,
      parent_id: { anyOf: [ID, { type: "null" }] },
      text: { type: "string", maxLength: MAX_TASK_TEXT_LENGTH, pattern: "^[^\\r\\n]*$" },
      checked: { type: "boolean" },
      rank: { type: "string", minLength: 1, maxLength: 64, pattern: "^[0-9]+$" },
      completed_at: TIMESTAMP,
      archived_at: TIMESTAMP,
    }, ["id", "parent_id", "text", "checked", "rank", "completed_at", "archived_at"]),
    indexes: [],
    operations: ["get", "list", "create", "replace", "delete", "transaction"],
    limits: { records: 10000, record_bytes: 65536, query_results: 1000 },
  },
  notes: {
    schema: valueSchema({
      id: ID,
      daily_entry_id: ID,
      content: { type: "string", maxLength: MAX_NOTE_LENGTH },
      rank: { type: "string", minLength: 1, maxLength: 64, pattern: "^[0-9]+$" },
      collapsed: { type: "boolean" },
    }, ["id", "daily_entry_id", "content", "rank", "collapsed"]),
    indexes: [],
    operations: ["get", "list", "create", "replace", "delete", "transaction"],
    limits: { records: 10000, record_bytes: 131072, query_results: 1000 },
  },
  "applied-proposals": {
    schema: valueSchema({
      artifactId: ID,
      id: ID,
      recordedAt: { type: "string", minLength: 1, maxLength: 64 },
      status: { enum: ["applied", "rejected"] },
      targetGeneration: { type: "integer", minimum: 0 },
    }, ["artifactId", "id", "recordedAt", "status", "targetGeneration"]),
    indexes: [],
    operations: ["get", "list", "create", "replace", "delete", "transaction"],
    limits: { records: 10000, record_bytes: 65536, query_results: 1000 },
  },
};

export const dataLimits = { total_bytes: 67108864, transaction_operations: 64, batch_operations: 2048 };

export const taskProposalPayloadSchema = {
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
              text: { type: "string", minLength: 1, maxLength: MAX_TASK_TEXT_LENGTH, pattern: "^[^\\r\\n]*$" },
              parentId: { anyOf: [ID, { type: "null" }] },
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
              taskId: ID,
              text: { type: "string", maxLength: MAX_TASK_TEXT_LENGTH, pattern: "^[^\\r\\n]*$" },
              checked: { type: "boolean" },
            },
          },
        ],
      },
    },
  },
};

export const taskProposalInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["targetGeneration", "payload"],
  properties: {
    targetGeneration: { type: "integer", minimum: 0, "x-kestral-managed-data-scope": { kind: "collection", collection: "tasks" } },
    payload: taskProposalPayloadSchema,
  },
  "x-kestral-managed-data-proposal": true,
};

export const taskProposalArtifactSchema = {
  type: "object",
  additionalProperties: false,
  required: ["targetAppId", "targetKind", "collection", "resourceId", "targetGeneration", "targetRevision", "payload"],
  properties: {
    targetAppId: { const: "kestral.daily-notes" },
    targetKind: { const: "collection" },
    collection: { const: "tasks" },
    resourceId: { type: "string", minLength: 1, maxLength: 256 },
    targetGeneration: { type: "integer", minimum: 0 },
    targetRevision: { type: ["integer", "null"], minimum: 1 },
    payload: taskProposalPayloadSchema,
  },
};

export const proposalCapability = {
  name: "propose-task-changes",
  description: "Create a reviewable, bounded proposal to add or update Daily Notes tasks without changing the workspace.",
  input_schema: taskProposalInputSchema,
  output_schema: taskProposalArtifactSchema,
  effect: "local-write",
};
