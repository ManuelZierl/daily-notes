import { describe, expect, it } from "vitest";
import { DataAdapter, DataConflictError } from "../src/surface/dataAdapter";
import { MemoryDataV2 } from "./dataV2";

function seedTasks(api: MemoryDataV2, count: number): void {
  for (let index = 0; index < count; index += 1) {
    api.seed("tasks", { id: `task-${index}`, parent_id: null, text: `Task ${index}`, checked: false,
      rank: String(index + 1).padStart(24, "0"), completed_at: null, archived_at: null });
  }
}

describe("data.v2 coherent snapshot reads", () => {
  it("refreshes to a newer generation instead of pinning the first read to the old one", async () => {
    const api = new MemoryDataV2();
    const data = new DataAdapter(api);
    api.generation = 1;
    await data.readWorkspace();
    seedTasks(api, 1);
    api.generation = 2;
    expect((await data.readWorkspace()).tasks).toHaveLength(1);
    expect(data.currentGeneration()).toBe(2);
    expect(api.requests.at(-1)?.value).not.toHaveProperty("expectedGeneration");
  });

  it("reads more than one page and pins continuation requests to the first page", async () => {
    const api = new MemoryDataV2();
    seedTasks(api, 1001);
    api.generation = 8;
    const data = new DataAdapter(api);
    expect((await data.readWorkspace()).tasks).toHaveLength(1001);
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1].value).toMatchObject({ expectedGeneration: 8 });
  });

  it("does not publish any partial page or generation when a continuation fails", async () => {
    const api = new MemoryDataV2();
    const data = new DataAdapter(api);
    await data.readWorkspace();
    const before = data.currentRecords();
    seedTasks(api, 1001);
    api.generation = 1;
    const read = api.readSnapshot.bind(api);
    api.readSnapshot = async (request) => {
      if (request.reads.some((item) => item.kind === "record-list" && item.query?.after)) throw new Error("read interrupted");
      return read(request);
    };
    await expect(data.readWorkspace()).rejects.toThrow("read interrupted");
    expect(data.currentRecords()).toEqual(before);
    expect(data.currentGeneration()).toBe(0);
  });

  it("rejects cross-page generation changes without replacing its last complete snapshot", async () => {
    const api = new MemoryDataV2();
    const data = new DataAdapter(api);
    await data.readWorkspace();
    seedTasks(api, 1001);
    const read = api.readSnapshot.bind(api);
    api.readSnapshot = async (request) => {
      if (request.expectedGeneration !== undefined) api.generation += 1;
      return read(request);
    };
    await expect(data.readWorkspace()).rejects.toBeInstanceOf(DataConflictError);
    expect(data.workspace().tasks).toEqual([]);
  });

  it("validates the complete workspace before publishing its records", async () => {
    const api = new MemoryDataV2();
    const data = new DataAdapter(api);
    await data.readWorkspace();
    seedTasks(api, 1);
    api.records.get("tasks")![0].value.parent_id = "missing";
    await expect(data.readWorkspace()).rejects.toThrow(/unknown parent/);
    expect(data.workspace().tasks).toEqual([]);
  });

  it("rejects repeated pagination cursors instead of looping indefinitely", async () => {
    const api = new MemoryDataV2();
    const data = new DataAdapter(api);
    let calls = 0;
    api.readSnapshot = async (request) => {
      calls += 1;
      if (calls > 3) throw new Error("test stopped an unbounded read");
      return { generation: 0, results: request.reads.map(() => ({ kind: "record-list", records: [], nextAfter: "repeated" })) };
    };
    await expect(data.readWorkspace()).rejects.toThrow(/cursor/);
    expect(calls).toBeLessThanOrEqual(2);
  });
});
