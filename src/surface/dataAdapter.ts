import type { DailyEntry, NoteBlock, Task, Workspace } from "../shared/types";

export type RecordValue = Record<string, unknown>;

export interface ManagedRecord<T extends RecordValue = RecordValue> {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  value: T;
}

export type CollectionName = "days" | "tasks" | "notes" | "applied-proposals";

export type ReadRequest =
  | { kind: "record-get"; collection: CollectionName; id: string }
  | { kind: "record-list"; collection: CollectionName; query?: { after?: string; limit?: number } };

export type MutationOperation =
  | { kind: "create"; collection: CollectionName; value: RecordValue }
  | { kind: "replace"; collection: CollectionName; id: string; expectedRevision: number; value: RecordValue }
  | { kind: "delete"; collection: CollectionName; id: string; expectedRevision: number };

export interface DataV2 {
  readSnapshot(request: { expectedGeneration?: number; reads: ReadRequest[] }): Promise<unknown>;
  beginBatch(request: { expectedGeneration: number; mutationId: string; operations: MutationOperation[]; documents: [] }): Promise<unknown>;
  appendBatchOperations(request: { batchId: string; mutationId: string; operations: MutationOperation[] }): Promise<unknown>;
  commitBatch(request: { batchId: string; mutationId: string }): Promise<unknown>;
  abortBatch(request: { batchId: string; mutationId: string }): Promise<unknown>;
}

export class DataAdapterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DataAdapterError";
  }
}

export class DataConflictError extends DataAdapterError {
  constructor(message = "Daily Notes changed elsewhere. Reload and review your edit.") {
    super(message);
    this.name = "DataConflictError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new DataAdapterError(`${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new DataAdapterError(`${label} must be a non-empty string`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new DataAdapterError(`${label} must be a positive integer`);
  return value as number;
}

function requireGeneration(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new DataAdapterError(`${label} must be a non-negative integer`);
  return value as number;
}

function childMutationId(mutationId: string, suffix: string): string {
  const tail = `-${suffix}`;
  return `${mutationId.slice(0, 128 - tail.length)}${tail}`;
}

function validateRecordValue(collection: CollectionName, value: Record<string, unknown>, label: string): void {
  const expected = collection === "days"
    ? ["id", "local_date", "title"]
    : collection === "tasks"
      ? ["archived_at", "checked", "completed_at", "id", "parent_id", "rank", "text"]
      : collection === "notes"
        ? ["collapsed", "content", "daily_entry_id", "id", "rank"]
        : ["artifactId", "id", "recordedAt", "status", "targetGeneration"];
  if (Object.keys(value).sort().join(",") !== expected.join(",")) throw new DataAdapterError(`${label}.value has an unexpected shape`);
  requireString(value.id, `${label}.value.id`);
  if (collection === "days") {
    requireString(value.local_date, `${label}.value.local_date`);
    requireString(value.title, `${label}.value.title`);
    return;
  }
  if (collection === "applied-proposals") {
    requireString(value.artifactId, `${label}.value.artifactId`);
    requireString(value.recordedAt, `${label}.value.recordedAt`);
    requireString(value.status, `${label}.value.status`);
    if (value.status !== "applied" && value.status !== "rejected") throw new DataAdapterError(`${label}.value.status is invalid`);
    if (!Number.isInteger(value.targetGeneration) || (value.targetGeneration as number) < 0) throw new DataAdapterError(`${label}.value.targetGeneration is invalid`);
    return;
  }
  requireString(value.rank, `${label}.value.rank`);
  if (!/^[0-9]+$/.test(value.rank as string)) throw new DataAdapterError(`${label}.value.rank must be a decimal rank`);
  if (collection === "tasks") {
    if (value.parent_id !== null) requireString(value.parent_id, `${label}.value.parent_id`);
    if (typeof value.text !== "string" || typeof value.checked !== "boolean") throw new DataAdapterError(`${label}.value task fields are malformed`);
    for (const field of ["completed_at", "archived_at"]) if (value[field] !== null) requireString(value[field], `${label}.value.${field}`);
  } else {
    requireString(value.daily_entry_id, `${label}.value.daily_entry_id`);
    if (typeof value.content !== "string" || typeof value.collapsed !== "boolean") throw new DataAdapterError(`${label}.value note fields are malformed`);
  }
}

function parseRecord(value: unknown, collection: CollectionName, label: string): ManagedRecord {
  const record = requireObject(value, label);
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "createdAt,id,revision,updatedAt,value") throw new DataAdapterError(`${label} has an unexpected record shape`);
  const id = requireString(record.id, `${label}.id`);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new DataAdapterError(`${label}.id must be a canonical host UUID`);
  const recordValue = requireObject(record.value, `${label}.value`);
  validateRecordValue(collection, recordValue, label);
  const parsed = {
    id,
    revision: requirePositiveInteger(record.revision, `${label}.revision`),
    createdAt: requireString(record.createdAt, `${label}.createdAt`),
    updatedAt: requireString(record.updatedAt, `${label}.updatedAt`),
    value: recordValue,
  };
  return parsed;
}

function parseReadResult(value: unknown, request: ReadRequest, index: number): { records: ManagedRecord[]; nextAfter: string | null } {
  const result = requireObject(value, `read result ${index}`);
  if (request.kind === "record-get") {
    if (result.kind !== "record-get" || !Object.hasOwn(result, "record")) throw new DataAdapterError(`read result ${index} does not match its record-get request`);
    return { records: result.record === null ? [] : [parseRecord(result.record, request.collection, `read result ${index}.record`)], nextAfter: null };
  }
  if (result.kind !== "record-list" || !Array.isArray(result.records) || (result.nextAfter !== null && typeof result.nextAfter !== "string")) {
    throw new DataAdapterError(`read result ${index} does not match its record-list request`);
  }
  return { records: result.records.map((record, recordIndex) => parseRecord(record, request.collection, `read result ${index}.records[${recordIndex}]`)), nextAfter: result.nextAfter as string | null };
}

function parseSnapshot(value: unknown, reads: ReadRequest[]): { generation: number; records: Map<CollectionName, ManagedRecord[]>; nextAfter: Map<CollectionName, string | null> } {
  const snapshot = requireObject(value, "data.v2 snapshot");
  const generation = requireGeneration(snapshot.generation, "data.v2 snapshot.generation");
  if (!Array.isArray(snapshot.results) || snapshot.results.length !== reads.length) throw new DataAdapterError("data.v2 snapshot results are not ordered with the reads");
  const records = new Map<CollectionName, ManagedRecord[]>();
  const nextAfter = new Map<CollectionName, string | null>();
  for (const [index, request] of reads.entries()) {
    const result = parseReadResult(snapshot.results[index], request, index);
    records.set(request.collection, result.records);
    nextAfter.set(request.collection, result.nextAfter);
  }
  return { generation, records, nextAfter };
}

function isConflict(error: unknown): boolean {
  return error instanceof Error && /generation|revision|conflict|cas|stale/i.test(error.message);
}

export class DataAdapter {
  private generation = 0;
  private records = new Map<CollectionName, ManagedRecord[]>();

  constructor(private readonly api: DataV2) {}

  static fromHost(host: unknown): DataAdapter {
    if (!isObject(host) || !isObject(host.data) || !isObject(host.data.v2)) throw new DataAdapterError("Kestral data.v2 is unavailable");
    const api = host.data.v2;
    if (typeof api.readSnapshot !== "function" || typeof api.beginBatch !== "function" || typeof api.appendBatchOperations !== "function" || typeof api.commitBatch !== "function" || typeof api.abortBatch !== "function") {
      throw new DataAdapterError("Kestral data.v2 is incomplete");
    }
    return new DataAdapter(api as unknown as DataV2);
  }

  async readWorkspace(): Promise<Workspace> {
    const reads: ReadRequest[] = [
      { kind: "record-list", collection: "days", query: { limit: 1000 } },
      { kind: "record-list", collection: "tasks", query: { limit: 1000 } },
      { kind: "record-list", collection: "notes", query: { limit: 1000 } },
      { kind: "record-list", collection: "applied-proposals", query: { limit: 1000 } },
    ];
    const snapshot = parseSnapshot(await this.api.readSnapshot({ expectedGeneration: this.generation || undefined, reads }), reads);
    this.generation = snapshot.generation;
    this.records = snapshot.records;
    for (const collection of ["days", "tasks", "notes", "applied-proposals"] as const) {
      let after = snapshot.nextAfter.get(collection) ?? null;
      while (after !== null) {
        const page: ReadRequest = { kind: "record-list", collection, query: { after, limit: 1000 } };
        const next = parseSnapshot(await this.api.readSnapshot({ expectedGeneration: this.generation, reads: [page] }), [page]);
        if (next.generation !== this.generation) throw new DataConflictError("Daily Notes changed while it was being read. Reload and try again.");
        this.records.set(collection, [...(this.records.get(collection) ?? []), ...(next.records.get(collection) ?? [])]);
        after = next.nextAfter.get(collection) ?? null;
      }
    }
    return this.workspace();
  }

  currentGeneration(): number {
    return this.generation;
  }

  currentRecords(): Map<CollectionName, ManagedRecord[]> {
    return new Map([...this.records.entries()].map(([collection, records]) => [collection, structuredClone(records)]));
  }

  setSnapshot(generation: number, records: Map<CollectionName, ManagedRecord[]>): void {
    this.generation = generation;
    this.records = records;
  }

  workspace(): Workspace {
    const dayRecords = this.records.get("days") ?? [];
    const taskRecords = this.records.get("tasks") ?? [];
    const noteRecords = this.records.get("notes") ?? [];
    const entries: DailyEntry[] = dayRecords.map((record) => ({
      id: requireString(record.value.id, "days.value.id"),
      local_date: requireString(record.value.local_date, "days.value.local_date"),
      title: requireString(record.value.title, "days.value.title"),
      created_at: record.createdAt,
    }));
    const tasks: Task[] = taskRecords.map((record) => ({
      id: requireString(record.value.id, "tasks.value.id"),
      parent_id: record.value.parent_id === null ? null : requireString(record.value.parent_id, "tasks.value.parent_id"),
      text: typeof record.value.text === "string" ? record.value.text : "",
      checked: record.value.checked === true,
      order: typeof record.value.rank === "string" ? 0 : Number(record.value.order ?? 0),
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      completed_at: record.value.completed_at === null ? null : requireString(record.value.completed_at, "tasks.value.completed_at"),
      archived_at: record.value.archived_at === null ? null : requireString(record.value.archived_at, "tasks.value.archived_at"),
    }));
    const notes: NoteBlock[] = noteRecords.map((record) => ({
      id: requireString(record.value.id, "notes.value.id"),
      daily_entry_id: requireString(record.value.daily_entry_id, "notes.value.daily_entry_id"),
      content: typeof record.value.content === "string" ? record.value.content : "",
      order: typeof record.value.rank === "string" ? 0 : Number(record.value.order ?? 0),
      collapsed: record.value.collapsed === true,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    }));
    this.applyRanks(entries, tasks, notes);
    return { version: 1, entries, tasks, notes };
  }

  private applyRanks(entries: DailyEntry[], tasks: Task[], notes: NoteBlock[]): void {
    const byCollection = this.records;
    const rank = (collection: CollectionName, id: string): string => {
      const record = (byCollection.get(collection) ?? []).find((candidate) => candidate.value.id === id);
      return typeof record?.value.rank === "string" ? record.value.rank : "";
    };
    entries.sort((a, b) => b.local_date.localeCompare(a.local_date));
    const taskRanks = new Map<string, string>();
    for (const task of tasks) taskRanks.set(task.id, rank("tasks", task.id));
    const noteRanks = new Map<string, string>();
    for (const note of notes) noteRanks.set(note.id, rank("notes", note.id));
    tasks.sort((a, b) => taskRanks.get(a.id)!.localeCompare(taskRanks.get(b.id)!) || a.id.localeCompare(b.id));
    notes.sort((a, b) => a.daily_entry_id.localeCompare(b.daily_entry_id) || noteRanks.get(a.id)!.localeCompare(noteRanks.get(b.id)!) || a.id.localeCompare(b.id));
    const setOrder = (items: Array<{ id: string; order: number }>, parent: (item: { id: string }) => string | null, archived: (item: { id: string }) => boolean) => {
      const owners = new Map<string, Array<{ id: string; order: number }>>();
      for (const item of items) {
        const owner = `${parent(item) ?? "root"}:${archived(item) ? "archived" : "active"}`;
        const list = owners.get(owner) ?? [];
        list.push(item);
        owners.set(owner, list);
      }
      for (const list of owners.values()) list.sort((a, b) => rank("tasks", a.id).localeCompare(rank("tasks", b.id)) || a.id.localeCompare(b.id)).forEach((item, index) => { item.order = index; });
    };
    setOrder(tasks, (task) => tasks.find((candidate) => candidate.id === task.id)!.parent_id, (task) => tasks.find((candidate) => candidate.id === task.id)!.archived_at !== null);
    const noteOwners = new Map<string, NoteBlock[]>();
    for (const note of notes) noteOwners.set(note.daily_entry_id, [...(noteOwners.get(note.daily_entry_id) ?? []), note]);
    for (const list of noteOwners.values()) list.sort((a, b) => noteRanks.get(a.id)!.localeCompare(noteRanks.get(b.id)!) || a.id.localeCompare(b.id)).forEach((note, index) => { note.order = index; });
  }

  async commit(expectedGeneration: number, mutationId: string, operations: MutationOperation[]): Promise<void> {
    if (operations.length === 0) return;
    if (operations.length > 2048) throw new DataAdapterError("Daily Notes mutation exceeds the data.v2 batch limit of 2048 operations.");
    let batchId: string | null = null;
    try {
      const begun = requireObject(await this.api.beginBatch({ expectedGeneration, mutationId, operations: operations.slice(0, 64), documents: [] }), "data.v2 beginBatch");
      batchId = requireString(begun.batchId, "data.v2 beginBatch.batchId");
      if (begun.generation !== expectedGeneration || !Array.isArray(begun.documents) || begun.documents.length !== 0) throw new DataAdapterError("data.v2 beginBatch returned an invalid batch");
      for (let offset = 64; offset < operations.length; offset += 64) {
        await this.api.appendBatchOperations({ batchId, mutationId: childMutationId(mutationId, `append-${offset / 64}`), operations: operations.slice(offset, offset + 64) });
      }
      const committed = requireObject(await this.api.commitBatch({ batchId, mutationId: childMutationId(mutationId, "commit") }), "data.v2 commit");
      this.generation = requirePositiveInteger(committed.generation, "data.v2 commit.generation");
    } catch (error) {
      if (batchId !== null) {
        try {
          await this.api.abortBatch({ batchId, mutationId: childMutationId(mutationId, "abort") });
        } catch (abortError) {
          throw new DataAdapterError("Daily Notes data could not be saved, and its incomplete batch could not be aborted.", { cause: new AggregateError([error, abortError]) });
        }
      }
      if (isConflict(error)) throw new DataConflictError(undefined);
      throw new DataAdapterError("Daily Notes data could not be saved.", { cause: error });
    }
    await this.readWorkspace();
  }
}
