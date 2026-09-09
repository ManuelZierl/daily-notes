import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import DailyNotes from "../src/surface/DailyNotes.svelte";
import type { Task, Workspace } from "../src/shared/types";
import { localDate } from "../src/shared/tasks";
import { MemoryDataV2 } from "./dataV2";

const today = localDate();

function task(id: string, text: string, order: number, parent_id: string | null = null): Task {
  return { id, text, order, parent_id, checked: false, created_at: "2026-07-28T10:00:00.000Z", updated_at: "2026-07-28T10:00:00.000Z", completed_at: null, archived_at: null };
}

function seed(api: MemoryDataV2, state: Workspace): void {
  for (const entry of state.entries) api.seed("days", { id: entry.id, local_date: entry.local_date, title: entry.title });
  for (const item of state.tasks) api.seed("tasks", { id: item.id, parent_id: item.parent_id, text: item.text, checked: item.checked, rank: String((item.order + 1) * 1_000_000_000).padStart(24, "0"), completed_at: item.completed_at, archived_at: item.archived_at });
  for (const note of state.notes) api.seed("notes", { id: note.id, daily_entry_id: note.daily_entry_id, content: note.content, rank: String((note.order + 1) * 1_000_000_000).padStart(24, "0"), collapsed: note.collapsed });
}

async function ready(state: Workspace, llm = "Draft", artifacts: unknown[] = [], selectedDate: string | null = null) {
  const api = new MemoryDataV2();
  seed(api, state);
  (globalThis as any).__dailyNotesDataV2 = api;
  (globalThis as any).__dailyNotesArtifacts = artifacts;
  (globalThis as any).__dailyNotesSurfaceState = selectedDate
    ? { revision: 1, value: { version: 1, selected_date: selectedDate } }
    : { revision: 0, value: null };
  (globalThis as any).__dailyNotesSurfaceWrites = [];
  (globalThis as any).__dailyNotesInvoke = vi.fn(async () => ({ result: { kind: "completed", result: { message: { content: llm } } } }));
  render(DailyNotes);
  await screen.findByRole("heading", { level: 1 });
  return api;
}

const base = (tasks: Task[] = [], notes: Workspace["notes"] = []): Workspace => ({ version: 1, entries: [{ id: `day-${today}`, local_date: today, title: today, created_at: "2026-07-28T10:00:00.000Z" }], tasks, notes });

afterEach(() => cleanup());

describe("backend-free Daily Notes surface", () => {
  it("creates today's entry with one startup batch in an empty workspace", async () => {
    const api = await ready({ version: 1, entries: [], tasks: [], notes: [] });
    await waitFor(() => expect(api.requests.filter((request) => request.kind === "commitBatch")).toHaveLength(1));
    expect(api.requests.filter((request) => request.kind === "beginBatch")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Daily Notes could not open" })).not.toBeInTheDocument();
  });

  it("loads from data.v2 and performs task edits in the sandbox", async () => {
    const api = await ready(base([task("root", "Root", 0)]));
    const editor = screen.getByLabelText("Active tasks. One task per line.") as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: "Edited\n" } });
    await fireEvent.blur(editor);
    await waitFor(() => expect(api.requests.some((request) => request.kind === "beginBatch")).toBe(true));
    expect(editor).toHaveValue("Edited\n");
  });

  it("restores the previously selected daily entry", async () => {
    const previousDate = "2026-07-27";
    const state = base();
    state.entries.push({ id: `day-${previousDate}`, local_date: previousDate, title: previousDate, created_at: "2026-07-27T10:00:00.000Z" });
    await ready(state, "Draft", [], previousDate);

    expect(screen.getByRole("button", { name: previousDate })).toHaveAttribute("aria-current", "page");
    expect((globalThis as any).__dailyNotesSurfaceWrites).toHaveLength(0);
  });

  it("keeps note edits local until the frontend adapter commits them", async () => {
    const api = await ready(base([], [{ id: "note", daily_entry_id: `day-${today}`, content: "Original", order: 0, collapsed: false, created_at: "2026-07-28T10:00:00.000Z", updated_at: "2026-07-28T10:00:00.000Z" }]));
    const note = screen.getByLabelText("Note 1 content");
    await fireEvent.input(note, { target: { value: "Changed" } });
    await fireEvent.blur(note);
    await waitFor(() => expect(api.requests.some((request) => request.kind === "commitBatch")).toBe(true));
    expect(note).toHaveValue("Changed");
  });

  it("continues to use the host invoke bridge only for explicit LLM actions", async () => {
    const invoke = await ready(base([], [{ id: "note", daily_entry_id: `day-${today}`, content: "Source", order: 0, collapsed: false, created_at: "2026-07-28T10:00:00.000Z", updated_at: "2026-07-28T10:00:00.000Z" }]));
    await fireEvent.click(screen.getByText("AI tools"));
    await fireEvent.click(screen.getByRole("button", { name: "Summarize day" }));
    await screen.findByText("Draft");
    expect((globalThis as any).__dailyNotesInvoke).toHaveBeenCalledWith(expect.objectContaining({ provider: "llm-provider", capability: "llm.generate" }), expect.any(Object));
    expect(invoke.requests.filter((request) => request.kind === "beginBatch")).toHaveLength(0);
  });

  it("reviews, applies, and records a task proposal without an immediate surface mutation", async () => {
    const artifact = {
      artifact_id: "123e4567-e89b-42d3-a456-426614174000",
      artifact_type: "task-change-proposal",
      title: "Plan release tasks",
      content: {
        targetAppId: "kestral.daily-notes",
        targetKind: "collection",
        collection: "tasks",
        resourceId: "app-data:kestral.daily-notes:tasks",
        targetGeneration: 0,
        targetRevision: null,
        payload: { operations: [{ kind: "create", text: "Review proposal" }] },
      },
      provenance: {},
    };
    const api = await ready(base(), "Draft", [artifact]);
    expect(screen.getByRole("heading", { name: "Task proposals" })).toBeVisible();
    expect(screen.getByText("Add task: Review proposal")).toBeVisible();
    await fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.getByLabelText("Active tasks. One task per line.")).toHaveValue("Review proposal\n"));
    expect(api.records.get("applied-proposals")).toHaveLength(1);
    await waitFor(() => expect(screen.getByText("Already handled.")).toBeVisible());
  });

  it("refuses stale proposals visibly and permits recording their rejection", async () => {
    const artifact = {
      artifact_id: "123e4567-e89b-42d3-a456-426614174001",
      artifact_type: "task-change-proposal",
      title: "Stale task plan",
      content: {
        targetAppId: "kestral.daily-notes",
        targetKind: "collection",
        collection: "tasks",
        resourceId: "app-data:kestral.daily-notes:tasks",
        targetGeneration: 999,
        targetRevision: null,
        payload: { operations: [{ kind: "create", text: "Must not apply" }] },
      },
      provenance: {},
    };
    const api = await ready(base(), "Draft", [artifact]);
    expect(screen.getByText(/targets generation 999/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Record rejection" }));
    await waitFor(() => expect(api.records.get("applied-proposals")).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("Already handled.")).toBeVisible());
    expect(screen.getByLabelText("Active tasks. One task per line.")).toHaveValue("");
  });
});

function noteState(content = "Original"): Workspace {
  return base([], [{ id: "note", daily_entry_id: `day-${today}`, content, order: 0, collapsed: false, created_at: "2026-07-28T10:00:00.000Z", updated_at: "2026-07-28T10:00:00.000Z" }]);
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("in-flight edits and refresh recovery", () => {
  it("defers host event refreshes instead of rebasing dirty note text", async () => {
    let notify: () => void = () => {};
    vi.spyOn((globalThis as any).appHost, "onEvent").mockImplementation((callback: unknown) => { notify = callback as () => void; });
    const api = await ready(noteState());
    const editor = screen.getByLabelText("Note 1 content");
    await fireEvent.input(editor, { target: { value: "Unsaved draft" } });
    const reads = api.requests.filter((request) => request.kind === "readSnapshot").length;
    notify();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.requests.filter((request) => request.kind === "readSnapshot")).toHaveLength(reads);
    expect(editor).toHaveValue("Unsaved draft");
  });

  it.each(["note", "task"] as const)("drains newer %s edits when their debounce timer expires during a slow save", async (kind) => {
    const api = await ready(kind === "note" ? noteState() : base([task("root", "Original", 0)]));
    const commit = api.commitBatch.bind(api);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let blocked = false;
    api.commitBatch = async (request) => {
      if (!blocked) { blocked = true; await gate; }
      return commit(request);
    };
    vi.useFakeTimers();
    const editor = screen.getByLabelText(kind === "note" ? "Note 1 content" : "Active tasks. One task per line.");
    const value = (text: string) => kind === "note" ? text : `${text}\n`;
    await fireEvent.input(editor, { target: { value: value("First edit") } });
    await vi.advanceTimersByTimeAsync(500);
    expect(blocked).toBe(true);
    await fireEvent.input(editor, { target: { value: value("Latest edit") } });
    await vi.advanceTimersByTimeAsync(500);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.records.get(kind === "note" ? "notes" : "tasks")![0].value[kind === "note" ? "content" : "text"]).toBe("Latest edit");
    expect(editor).toHaveValue(value("Latest edit"));
  });

  it("retries a failed rollover instead of treating a missing day as already created", async () => {
    const api = await ready(base());
    vi.useFakeTimers();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    vi.setSystemTime(tomorrow);
    api.failCommit = true;
    await fireEvent(document, new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.records.get("days")).toHaveLength(1);
    api.failCommit = false;
    await fireEvent(document, new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.records.get("days")).toHaveLength(2);
    expect(api.records.get("days")!.some((record) => record.value.local_date === localDate(tomorrow))).toBe(true);
  });
});

describe("saved-data reload UX", () => {
  it("keeps an acknowledged note creation visible and reloads without duplicating it", async () => {
    const api = await ready(base());
    const read = api.readSnapshot.bind(api);
    api.readSnapshot = async () => { throw new Error("snapshot unavailable"); };
    await fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    await screen.findByLabelText("Note 1 content");
    expect(api.records.get("notes")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(/saved.*reloaded/i);
    api.readSnapshot = read;
    await fireEvent.click(screen.getByRole("button", { name: "Reload saved data" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Note 1 content")).toHaveValue("");
    expect(api.records.get("notes")).toHaveLength(1);
  });

  it("loads external changes on a host event when there are no pending edits", async () => {
    let notify: () => void = () => {};
    vi.spyOn((globalThis as any).appHost, "onEvent").mockImplementation((callback: unknown) => { notify = callback as () => void; });
    const api = await ready(noteState());
    api.records.get("notes")![0].value.content = "External edit";
    api.records.get("notes")![0].revision += 1;
    api.generation += 1;
    notify();
    await waitFor(() => expect(screen.getByLabelText("Note 1 content")).toHaveValue("External edit"));
  });
});
