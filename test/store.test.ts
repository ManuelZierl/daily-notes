import { describe, expect, it } from "vitest";
import { DataAdapter, DataAdapterError, DataConflictError } from "../src/surface/dataAdapter";
import { FrontendWorkspaceStore } from "../src/surface/workspaceStore";
import { orderedTaskTree, parseMarkdownTasks } from "../src/shared/tasks";
import { MemoryDataV2 } from "./dataV2";

async function fixture() {
  const api = new MemoryDataV2();
  const data = new DataAdapter(api);
  const store = await FrontendWorkspaceStore.open(data, () => new Date("2026-07-28T10:00:00.000Z"), (() => { let id = 0; return () => `id-${++id}`; })());
  return { api, data, store };
}

function taskId(store: FrontendWorkspaceStore, text: string): string {
  return store.snapshot().tasks.find((task) => task.text === text)!.id;
}

describe("frontend data.v2 workspace store", () => {
  it("opens a fresh host store at generation zero", async () => {
    const { api, store } = await fixture();
    expect(store.snapshot().tasks).toEqual([]);
    expect(api.requests[0]).toEqual({
      kind: "readSnapshot",
      value: {
        reads: [
          { kind: "record-list", collection: "days", query: { limit: 1000 } },
          { kind: "record-list", collection: "tasks", query: { limit: 1000 } },
          { kind: "record-list", collection: "notes", query: { limit: 1000 } },
          { kind: "record-list", collection: "applied-proposals", query: { limit: 1000 } },
        ],
      },
    });
  });

  it("uses one generation-CAS batch for reviewed multi-task creation", async () => {
    const { api, store } = await fixture();
    await store.createTasks(["First", "Second"]);
    const batch = api.requests.find((request) => request.kind === "beginBatch")!.value as { expectedGeneration: number; operations: unknown[] };
    expect(batch.expectedGeneration).toBe(0);
    expect(batch.operations).toHaveLength(2);
    expect(api.requests.filter((request) => request.kind === "commitBatch")).toHaveLength(1);
    expect(store.snapshot().tasks.map((task) => task.text)).toEqual(["First", "Second"]);
  });

  it("appends a 1,000-task import in 64-operation chunks and commits once", async () => {
    const { api, store } = await fixture();
    await store.importTasks(Array.from({ length: 1000 }, (_, index) => `- [ ] Imported ${index + 1}`).join("\n"), null);
    const appends = api.requests.filter((request) => request.kind === "appendBatchOperations").map((request) => (request.value as { operations: unknown[] }).operations.length);
    expect(appends).toEqual([...Array(14).fill(64), 40]);
    const mutationIds = api.requests
      .filter((request) => ["beginBatch", "appendBatchOperations", "commitBatch", "abortBatch"].includes(request.kind))
      .map((request) => (request.value as { mutationId: string }).mutationId);
    expect(mutationIds.every((mutationId) => /^[A-Za-z0-9_.-]{1,128}$/.test(mutationId))).toBe(true);
    expect(api.requests.filter((request) => request.kind === "commitBatch")).toHaveLength(1);
    expect(store.snapshot().tasks).toHaveLength(1000);
  });

  it("keeps stable rank values for siblings when inserting between them", async () => {
    const { api, store } = await fixture();
    await store.createTasks(["First", "Last"]);
    const before = new Map(api.records.get("tasks")!.map((record) => [record.value.id as string, record.value.rank as string]));
    await store.createTask({ text: "Middle", parent_id: null, after_id: taskId(store, "First") });
    const batch = [...api.requests].reverse().find((request) => request.kind === "beginBatch")!.value as { operations: Array<{ kind: string; value?: Record<string, unknown> }> };
    expect(batch.operations.filter((operation) => operation.kind === "replace")).toHaveLength(0);
    const after = api.records.get("tasks")!;
    expect(after.find((record) => record.value.id === taskId(store, "First"))?.value.rank).toBe(before.get(taskId(store, "First")));
    expect(orderedTaskTree(store.snapshot().tasks, false).map((task) => task.text)).toEqual(["First", "Middle", "Last"]);
  });

  it("keeps root archive and restore semantics in frontend domain logic", async () => {
    const { store } = await fixture();
    await store.createTask({ text: "Root", parent_id: null, after_id: null });
    const root = taskId(store, "Root");
    await store.createTask({ text: "Checked child", parent_id: root, after_id: null });
    const child = taskId(store, "Checked child");
    await store.toggleTask(child, true);
    await store.toggleTask(root, true);
    expect(orderedTaskTree(store.snapshot().tasks, false)).toHaveLength(0);
    expect(orderedTaskTree(store.snapshot().tasks, true).map((task) => [task.text, task.checked])).toEqual([["Root", true], ["Checked child", true]]);
    await store.restoreTaskTree(root);
    expect(orderedTaskTree(store.snapshot().tasks, false).map((task) => [task.text, task.checked])).toEqual([["Root", false], ["Checked child", true]]);
  });

  it("parses and atomically imports Markdown hierarchy", async () => {
    const { store } = await fixture();
    const markdown = "- [ ] Prepare\n    - [x] Run tests\n- [ ] Publish";
    expect(parseMarkdownTasks(markdown)).toEqual([{ text: "Prepare", checked: false, depth: 0 }, { text: "Run tests", checked: true, depth: 1 }, { text: "Publish", checked: false, depth: 0 }]);
    await store.importTasks(markdown, null);
    expect(orderedTaskTree(store.snapshot().tasks, false).map((task) => [task.text, task.depth, task.checked])).toEqual([["Prepare", 0, false], ["Run tests", 1, true], ["Publish", 0, false]]);
  });

  it("does not publish a local mutation after a generation conflict", async () => {
    const { api, store } = await fixture();
    await store.createTask({ text: "Before", parent_id: null, after_id: null });
    const before = store.snapshot();
    api.generation += 1;
    await expect(store.updateTask(taskId(store, "Before"), "After")).rejects.toBeInstanceOf(DataConflictError);
    expect(store.snapshot()).toEqual(before);
  });

  it("leaves the previous state authoritative when final commit fails", async () => {
    const { api, store } = await fixture();
    await store.createTask({ text: "Before", parent_id: null, after_id: null });
    const before = store.snapshot();
    api.failCommit = true;
    await expect(store.updateTask(taskId(store, "Before"), "After")).rejects.toThrow(/could not be saved/);
    expect(store.snapshot()).toEqual(before);
    expect(api.records.get("tasks")?.find((record) => record.value.id === "task-id-1")?.value.text).toBe("Before");
    expect(api.requests.filter((request) => request.kind === "abortBatch")).toHaveLength(1);
    expect(api.batches.size).toBe(0);
  });

  it("keeps derived mutation IDs valid at the host length limit", async () => {
    const api = new MemoryDataV2();
    const data = new DataAdapter(api);
    await data.readWorkspace();
    api.failCommit = true;
    const operations = Array.from({ length: 65 }, () => ({ kind: "create" as const, collection: "tasks" as const, value: {} }));
    await expect(data.commit(0, "x".repeat(128), operations)).rejects.toThrow(/could not be saved/);
    const mutationIds = api.requests
      .filter((request) => ["beginBatch", "appendBatchOperations", "commitBatch", "abortBatch"].includes(request.kind))
      .map((request) => (request.value as { mutationId: string }).mutationId);
    expect(mutationIds.every((mutationId) => /^[A-Za-z0-9_.-]{1,128}$/.test(mutationId))).toBe(true);
  });

  it("surfaces abort failure when an incomplete batch may remain active", async () => {
    const { api, store } = await fixture();
    await store.createTask({ text: "Before", parent_id: null, after_id: null });
    api.failCommit = true;
    api.failAbort = true;
    await expect(store.updateTask(taskId(store, "Before"), "After")).rejects.toThrow(/incomplete batch could not be aborted/);
    expect(api.batches.size).toBe(1);
  });

  it("rejects malformed data.v2 record envelopes", async () => {
    const api = new MemoryDataV2();
    const data = new DataAdapter(api);
    api.readSnapshot = async () => ({ generation: 1, results: [{ kind: "list", records: [{ id: "x", revision: 1, value: {} }], nextAfter: null }, { kind: "list", records: [], nextAfter: null }, { kind: "list", records: [], nextAfter: null }] });
    await expect(data.readWorkspace()).rejects.toBeInstanceOf(DataAdapterError);
  });
});


describe("workspace operation ordering and proposals", () => {
  it("serializes simultaneous writes and reads without overlapping host batches", async () => {
    const { api, store } = await fixture();
    const first = store.createTasks(["First"]);
    const refresh = store.refresh();
    const second = store.createTasks(["Second"]);
    await Promise.all([first, refresh, second]);
    expect(store.snapshot().tasks.map((task) => task.text)).toEqual(["First", "Second"]);
    expect(api.batches.size).toBe(0);
  });

  it("recovers from a conflict through an explicit refresh without losing the external edit", async () => {
    const { api, store } = await fixture();
    await store.createTasks(["Before"]);
    api.records.get("tasks")![0].value.text = "External edit";
    api.records.get("tasks")![0].revision += 1;
    api.generation += 1;
    await expect(store.createTasks(["Rejected"])).rejects.toBeInstanceOf(DataConflictError);
    await store.refresh();
    await store.createTasks(["After refresh"]);
    expect(store.snapshot().tasks.map((task) => task.text)).toEqual(["External edit", "After refresh"]);
  });

  it("normalizes active task order when a proposal completes a root before other roots", async () => {
    const { data, store } = await fixture();
    await store.createTasks(["Archive", "Keep"]);
    const root = taskId(store, "Archive");
    await store.createTask({ text: "Checked child", parent_id: root, after_id: null, checked: true });
    await store.createTask({ text: "", parent_id: root, after_id: null });
    await store.applyTaskProposal("proposal-archive", data.currentGeneration(), { operations: [{ kind: "update", taskId: root, checked: true }] });
    expect(orderedTaskTree(store.snapshot().tasks, false).map((task) => task.text)).toEqual(["Keep"]);
    expect(orderedTaskTree(store.snapshot().tasks, true).map((task) => [task.text, task.checked])).toEqual([["Archive", true], ["Checked child", true]]);
    await store.restoreTaskTree(root);
    expect(orderedTaskTree(store.snapshot().tasks, false).map((task) => [task.text, task.checked])).toEqual([["Archive", false], ["Checked child", true], ["Keep", false]]);
  });

  it("allows a checked-root creation followed by an active-root creation in one proposal", async () => {
    const { data, store } = await fixture();
    await store.applyTaskProposal("proposal-create", data.currentGeneration(), { operations: [{ kind: "create", text: "Done", checked: true }, { kind: "create", text: "Next" }] });
    expect(orderedTaskTree(store.snapshot().tasks, false).map((task) => task.text)).toEqual(["Next"]);
  });

  it("checks proposal generations at execution time rather than before a queued write", async () => {
    const { data, store } = await fixture();
    const generation = data.currentGeneration();
    const edit = store.createTasks(["Local edit"]);
    const proposal = store.applyTaskProposal("queued-proposal", generation, { operations: [{ kind: "create", text: "Stale proposal" }] });
    await expect(proposal).rejects.toThrow(/stale/);
    await edit;
    expect(store.snapshot().tasks.map((task) => task.text)).toEqual(["Local edit"]);
    expect(store.proposalWasHandled("queued-proposal")).toBe(false);
  });

  it("checks duplicate proposal receipts inside the operation queue", async () => {
    const { api, store } = await fixture();
    const first = store.rejectTaskProposal("same", 0);
    const second = store.rejectTaskProposal("same", 0);
    await first;
    await expect(second).rejects.toThrow(/already been handled/);
    expect(api.records.get("applied-proposals")).toHaveLength(1);
  });
});

describe("acknowledged commit recovery", () => {
  it("does not report an acknowledged create as failed just because reloading it fails", async () => {
    const { api, data, store } = await fixture();
    const read = api.readSnapshot.bind(api);
    api.readSnapshot = async () => { throw new Error("snapshot temporarily unavailable"); };
    const created = await store.createTask({ text: "Saved once", parent_id: null, after_id: null });
    expect(created.workspace.tasks.find((task) => task.id === created.created_id)?.text).toBe("Saved once");
    expect(api.records.get("tasks")).toHaveLength(1);
    expect(data.refreshWarning()).toMatch(/saved.*reload/i);
    await expect(store.createTasks(["Blocked until reload"])).rejects.toThrow(/reload/i);
    expect(api.records.get("tasks")).toHaveLength(1);
    expect(api.requests.filter((request) => request.kind === "abortBatch")).toHaveLength(0);
    api.readSnapshot = read;
    await store.refresh();
    expect(data.refreshWarning()).toBeNull();
    await store.updateTask(created.created_id, "Saved twice, still one task");
    expect(api.records.get("tasks")).toHaveLength(1);
  });
});

describe("archive and restore", () => {
  it("renumbers surviving children when archiving removes an earlier blank leaf", async () => {
    const { store } = await fixture();
    await store.createTasks(["Root"]);
    const root = taskId(store, "Root");
    await store.createTask({ text: "", parent_id: root, after_id: null });
    await store.createTask({ text: "Keep child", parent_id: root, after_id: null });
    await store.toggleTask(root, true);
    await store.restoreTaskTree(root);
    expect(orderedTaskTree(store.snapshot().tasks, false).map((task) => [task.text, task.order])).toEqual([["Root", 0], ["Keep child", 0]]);
  });
});
