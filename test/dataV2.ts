import { randomUUID } from "node:crypto";
import type { CollectionName, DataV2, ManagedRecord, MutationOperation, ReadRequest } from "../src/surface/dataAdapter";

const MUTATION_ID = /^[A-Za-z0-9_.-]{1,128}$/;

function validateMutationId(mutationId: string): void {
  if (!MUTATION_ID.test(mutationId)) throw new Error("invalid mutation id");
}

export class MemoryDataV2 implements DataV2 {
  generation = 0;
  readonly records = new Map<CollectionName, ManagedRecord[]>();
  readonly batches = new Map<string, { expectedGeneration: number; operations: MutationOperation[] }>();
  readonly requests: Array<{ kind: string; value: unknown }> = [];
  failCommit = false;
  failAbort = false;

  constructor() {
    for (const collection of ["days", "tasks", "notes", "applied-proposals"] as const) this.records.set(collection, []);
  }

  seed(collection: CollectionName, value: Record<string, unknown>): string {
    const id = randomUUID();
    this.records.get(collection)!.push({ id, revision: 1, createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T10:00:00.000Z", value: structuredClone(value) });
    return id;
  }

  readSnapshot(request: { expectedGeneration?: number; reads: ReadRequest[] }): Promise<unknown> {
    this.requests.push({ kind: "readSnapshot", value: structuredClone(request) });
    if (request.expectedGeneration !== undefined && request.expectedGeneration !== this.generation) return Promise.reject(new Error("generation conflict"));
    return Promise.resolve({ generation: this.generation, results: request.reads.map((read) => {
      const records = this.records.get(read.collection)!;
      if (read.kind === "record-get") return { kind: "record-get", record: records.find((record) => record.id === read.id) ?? null };
      return { kind: "record-list", records: [...records].sort((a, b) => a.id.localeCompare(b.id)), nextAfter: null };
    }) });
  }

  beginBatch(request: { expectedGeneration: number; mutationId: string; operations: MutationOperation[]; documents: [] }): Promise<unknown> {
    this.requests.push({ kind: "beginBatch", value: structuredClone(request) });
    validateMutationId(request.mutationId);
    if (request.expectedGeneration !== this.generation) return Promise.reject(new Error("generation conflict"));
    if (this.batches.size > 0) return Promise.reject(new Error("managed-data already has an active batch; commit or abort it first"));
    const batchId = randomUUID();
    this.batches.set(batchId, { expectedGeneration: request.expectedGeneration, operations: structuredClone(request.operations) });
    return Promise.resolve({ batchId, generation: this.generation, documents: [] });
  }

  appendBatchOperations(request: { batchId: string; mutationId: string; operations: MutationOperation[] }): Promise<unknown> {
    this.requests.push({ kind: "appendBatchOperations", value: structuredClone(request) });
    validateMutationId(request.mutationId);
    const batch = this.batches.get(request.batchId);
    if (!batch) return Promise.reject(new Error("unknown batch"));
    if (request.operations.length > 64 || batch.operations.length + request.operations.length > 2048) return Promise.reject(new Error("batch operation limit"));
    batch.operations.push(...structuredClone(request.operations));
    return Promise.resolve({ batchId: request.batchId, operationCount: batch.operations.length });
  }

  commitBatch(request: { batchId: string; mutationId: string }): Promise<unknown> {
    this.requests.push({ kind: "commitBatch", value: structuredClone(request) });
    validateMutationId(request.mutationId);
    const batch = this.batches.get(request.batchId);
    if (!batch) return Promise.reject(new Error("unknown batch"));
    if (batch.expectedGeneration !== this.generation) return Promise.reject(new Error("generation conflict"));
    if (this.failCommit) return Promise.reject(new Error("simulated final commit failure"));
    const next = new Map([...this.records.entries()].map(([collection, records]) => [collection, structuredClone(records)]));
    for (const operation of batch.operations) {
      const records = next.get(operation.collection)!;
      if (operation.kind === "create") records.push({ id: randomUUID(), revision: 1, createdAt: "2026-07-28T10:00:00.000Z", updatedAt: "2026-07-28T10:00:00.000Z", value: structuredClone(operation.value) });
      else {
        const index = records.findIndex((record) => record.id === operation.id);
        if (index < 0 || records[index].revision !== operation.expectedRevision) return Promise.reject(new Error("revision conflict"));
        if (operation.kind === "delete") records.splice(index, 1);
        else records[index] = { ...records[index], revision: records[index].revision + 1, updatedAt: "2026-07-28T10:00:00.000Z", value: structuredClone(operation.value) };
      }
    }
    this.records.clear();
    for (const [collection, records] of next) this.records.set(collection, records);
    this.batches.delete(request.batchId);
    this.generation += 1;
    return Promise.resolve({ generation: this.generation });
  }

  abortBatch(request: { batchId: string; mutationId: string }): Promise<unknown> {
    this.requests.push({ kind: "abortBatch", value: structuredClone(request) });
    validateMutationId(request.mutationId);
    if (this.failAbort) return Promise.reject(new Error("simulated abort failure"));
    this.batches.delete(request.batchId);
    return Promise.resolve({ aborted: true });
  }
}
