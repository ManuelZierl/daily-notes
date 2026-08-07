import { describe, expect, it } from "vitest";
import { DailyNotesPresentationState } from "../src/surface/presentationState";

describe("DailyNotesPresentationState", () => {
  it("restores and persists a selected day", async () => {
    const host = new FakeStateHost({ revision: 1, value: { version: 1, selected_date: "2026-07-27" } });
    const state = new DailyNotesPresentationState(host);

    expect(await state.restoreSelectedDate()).toBe("2026-07-27");
    await state.persistSelectedDate("2026-07-28");
    expect(host.entry.value).toEqual({ version: 1, selected_date: "2026-07-28" });
  });

  it("ignores malformed dates and repairs the value", async () => {
    const host = new FakeStateHost({ revision: 1, value: { version: 1, selected_date: "2026-02-31" } });
    const state = new DailyNotesPresentationState(host);

    expect(await state.restoreSelectedDate()).toBeNull();
    await state.persistSelectedDate("2026-02-28");
    expect(host.entry.value).toEqual({ version: 1, selected_date: "2026-02-28" });
  });

  it("rereads and retries once after a revision conflict", async () => {
    const host = new FakeStateHost({ revision: 1, value: { version: 1, selected_date: "2026-07-27" } });
    const state = new DailyNotesPresentationState(host);
    await state.restoreSelectedDate();
    host.entry = { revision: 2, value: { version: 1, selected_date: "2026-07-28" } };

    await state.persistSelectedDate("2026-07-29");
    expect(host.entry).toEqual({ revision: 3, value: { version: 1, selected_date: "2026-07-29" } });
  });
});

class FakeStateHost {
  constructor(public entry: { revision: number; value: Record<string, unknown> | null }) {}

  async getState() {
    return structuredClone(this.entry);
  }

  async putState(_key: string, expectedRevision: number, value: Record<string, unknown> | null) {
    if (expectedRevision !== this.entry.revision) throw new Error("surface state revision conflict");
    this.entry = { revision: this.entry.revision + 1, value: structuredClone(value) };
    return structuredClone(this.entry);
  }
}
