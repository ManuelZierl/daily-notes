import type { CreateTaskResult, DailyEntry, NoteBlock, Task, Workspace } from "../shared/types";
import { orderedTaskTree, parseMarkdownTasks } from "../shared/tasks";
import { isLocalDate, validateWorkspace } from "../shared/workspaceValidation";
import { MAX_IMPORTED_TASKS, MAX_IMPORT_LENGTH, MAX_NOTE_LENGTH, MAX_TASK_DEPTH, MAX_TASK_TEXT_LENGTH } from "../shared/limits.mjs";
import { DataAdapter, DataAdapterError, type CollectionName, type ManagedRecord, type MutationOperation } from "./dataAdapter";
import { applyProposalOperations, type TaskProposalPayload } from "./proposals";

export class WorkspaceOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceOperationError";
  }
}

function reject(message: string): never {
  throw new WorkspaceOperationError(message);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function textLength(value: string): number {
  return Array.from(value).length;
}

function requireTaskText(value: string): void {
  if (value.includes("\r") || value.includes("\n")) reject("task text must fit on one line");
  if (textLength(value) > MAX_TASK_TEXT_LENGTH) reject(`task text is limited to ${MAX_TASK_TEXT_LENGTH} characters`);
}

function requireNoteContent(value: string): void {
  if (textLength(value) > MAX_NOTE_LENGTH) reject(`note content is limited to ${MAX_NOTE_LENGTH} characters`);
}

function normalizeOrders(tasks: Task[], parentId: string | null, archived: boolean): void {
  tasks.filter((task) => task.parent_id === parentId && (task.archived_at !== null) === archived).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).forEach((task, index) => { task.order = index; });
}

function descendants(tasks: Task[], rootId: string): Task[] {
  const result: Task[] = [];
  const visit = (id: string) => {
    for (const child of tasks.filter((task) => task.parent_id === id)) {
      result.push(child);
      visit(child.id);
    }
  };
  visit(rootId);
  return result;
}

function subtreeHeight(tasks: Task[], rootId: string): number {
  const children = tasks.filter((task) => task.parent_id === rootId);
  return 1 + (children.length ? Math.max(...children.map((child) => subtreeHeight(tasks, child.id))) : 0);
}

const RANK_STEP = 1_000_000_000n;
const RANK_WIDTH = 24;

function rankValue(value: bigint): string {
  return value.toString().padStart(RANK_WIDTH, "0");
}

function rankBetween(lower: string | null, upper: string | null): string {
  const low = lower === null ? 0n : BigInt(lower);
  const high = upper === null ? RANK_STEP * 2n ** 32n : BigInt(upper);
  if (high - low > 1n) return rankValue((low + high) / 2n);
  return rankValue(low + 1n);
}

function rankGroups(tasks: Task[], notes: NoteBlock[], current: Map<CollectionName, ManagedRecord[]>): Map<string, string> {
  const result = new Map<string, string>();
  const taskRecords = current.get("tasks") ?? [];
  const noteRecords = current.get("notes") ?? [];
  const currentRank = (records: ManagedRecord[], id: string): string | null => {
    const value = records.find((record) => record.value.id === id)?.value.rank;
    return typeof value === "string" ? value : null;
  };
  const fill = (items: Array<{ id: string; order: number }>, records: ManagedRecord[]) => {
    const desired = [...items].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    let lower: string | null = null;
    for (const [index, item] of desired.entries()) {
      const existing = currentRank(records, item.id);
      const laterRanks = desired.slice(index + 1).map((candidate) => currentRank(records, candidate.id)).filter((value): value is string => value !== null);
      const boundary = lower;
      const following = (boundary === null ? laterRanks.sort()[0] : laterRanks.find((value) => value > boundary)) ?? null;
      const usable: boolean = existing !== null && (lower === null || existing > lower) && (following === null || existing < following);
      const rank: string = usable ? existing! : rankBetween(lower, following);
      result.set(item.id, rank);
      lower = rank;
    }
  };
  const taskOwners = new Map<string, Task[]>();
  for (const task of tasks) {
    const owner = `${task.parent_id ?? "root"}:${task.archived_at === null ? "active" : "archived"}`;
    taskOwners.set(owner, [...(taskOwners.get(owner) ?? []), task]);
  }
  for (const items of taskOwners.values()) fill(items, taskRecords);
  const noteOwners = new Map<string, NoteBlock[]>();
  for (const note of notes) noteOwners.set(note.daily_entry_id, [...(noteOwners.get(note.daily_entry_id) ?? []), note]);
  for (const items of noteOwners.values()) fill(items, noteRecords);
  return result;
}

function taskValue(task: Task, rank: string): Record<string, unknown> {
  return { id: task.id, parent_id: task.parent_id, text: task.text, checked: task.checked, rank, completed_at: task.completed_at, archived_at: task.archived_at };
}

function noteValue(note: NoteBlock, rank: string): Record<string, unknown> {
  return { id: note.id, daily_entry_id: note.daily_entry_id, content: note.content, rank, collapsed: note.collapsed };
}

function dayValue(entry: DailyEntry): Record<string, unknown> {
  return { id: entry.id, local_date: entry.local_date, title: entry.title };
}

function sameValue(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class FrontendWorkspaceStore {
  private workspace: Workspace = { version: 1, entries: [], tasks: [], notes: [] };

  private constructor(private readonly data: DataAdapter, private readonly now: () => Date = () => new Date(), private readonly id: () => string = () => crypto.randomUUID()) {}

  static async open(data: DataAdapter, now?: () => Date, id?: () => string): Promise<FrontendWorkspaceStore> {
    const store = new FrontendWorkspaceStore(data, now, id);
    store.workspace = data.workspace();
    await store.refresh();
    return store;
  }

  async refresh(): Promise<Workspace> {
    this.workspace = await this.data.readWorkspace();
    validateWorkspace(this.workspace);
    return this.snapshot();
  }

  snapshot(): Workspace {
    return clone(this.workspace);
  }

  private sort(workspace: Workspace): void {
    workspace.entries.sort((a, b) => b.local_date.localeCompare(a.local_date));
    workspace.tasks.sort((a, b) => (a.parent_id === null ? (b.parent_id === null ? 0 : -1) : (b.parent_id === null ? 1 : a.parent_id.localeCompare(b.parent_id))) || a.order - b.order || a.id.localeCompare(b.id));
    workspace.notes.sort((a, b) => a.daily_entry_id.localeCompare(b.daily_entry_id) || a.order - b.order || a.id.localeCompare(b.id));
  }

  private valuesFor(workspace: Workspace, current: Map<CollectionName, ManagedRecord[]>): Map<CollectionName, Map<string, Record<string, unknown>>> {
    const ranks = rankGroups(workspace.tasks, workspace.notes, current);
    return new Map([
      ["days", new Map(workspace.entries.map((entry) => [entry.id, dayValue(entry)]))],
      ["tasks", new Map(workspace.tasks.map((task) => [task.id, taskValue(task, ranks.get(task.id) ?? rankValue(BigInt(task.order + 1) * RANK_STEP))]))],
      ["notes", new Map(workspace.notes.map((note) => [note.id, noteValue(note, ranks.get(note.id) ?? rankValue(BigInt(note.order + 1) * RANK_STEP))]))],
    ]);
  }

  private operationsFor(workspace: Workspace): MutationOperation[] {
    const current = this.data.currentRecords();
    const wanted = this.valuesFor(workspace, current);
    const operations: MutationOperation[] = [];
    for (const collection of ["days", "tasks", "notes"] as const) {
      const records = current.get(collection) ?? [];
      const byValueId = new Map(records.map((record) => [record.value.id as string, record]));
      const desired = wanted.get(collection)!;
      for (const record of records) {
        if (!desired.has(record.value.id as string)) operations.push({ kind: "delete", collection, id: record.id, expectedRevision: record.revision });
      }
      for (const [valueId, value] of desired) {
        const record = byValueId.get(valueId);
        if (!record) operations.push({ kind: "create", collection, value });
        else if (!sameValue(record.value, value)) operations.push({ kind: "replace", collection, id: record.id, expectedRevision: record.revision, value });
      }
    }
    return operations;
  }

  private async transact(mutate: (draft: Workspace, timestamp: string) => void, extraOperations: MutationOperation[] = []): Promise<Workspace> {
    const draft = clone(this.workspace);
    mutate(draft, this.now().toISOString());
    this.sort(draft);
    validateWorkspace(draft);
    try {
      await this.data.commit(this.data.currentGeneration(), this.id(), [...this.operationsFor(draft), ...extraOperations]);
    } catch (error) {
      if (error instanceof DataAdapterError) throw error;
      throw new DataAdapterError("Daily Notes data could not be saved.", { cause: error });
    }
    this.workspace = await this.data.readWorkspace();
    return this.snapshot();
  }

  async getOrCreateDay(localDate: string): Promise<Workspace> {
    if (!isLocalDate(localDate)) reject("local_date must be a real calendar date using YYYY-MM-DD");
    const existing = this.workspace.entries.some((entry) => entry.local_date === localDate);
    const stale = this.workspace.tasks.some((task) => task.archived_at === null && !task.text.trim() && !this.workspace.tasks.some((candidate) => candidate.parent_id === task.id));
    if (existing && !stale) return this.snapshot();
    return this.transact((draft, timestamp) => {
      for (;;) {
        const blank = draft.tasks.filter((task) => task.archived_at === null && !task.text.trim() && !draft.tasks.some((candidate) => candidate.parent_id === task.id));
        if (blank.length === 0) break;
        const ids = new Set(blank.map((task) => task.id));
        draft.tasks = draft.tasks.filter((task) => !ids.has(task.id));
      }
      if (!draft.entries.some((entry) => entry.local_date === localDate)) draft.entries.push({ id: `day-${localDate}`, local_date: localDate, title: localDate, created_at: timestamp });
    });
  }

  async createTask(input: { text: string; parent_id: string | null; after_id: string | null; checked?: boolean }): Promise<CreateTaskResult> {
    requireTaskText(input.text);
    let createdId = "";
    const workspace = await this.transact((draft, timestamp) => {
      if (input.parent_id !== null && !draft.tasks.some((task) => task.id === input.parent_id && task.archived_at === null)) reject("parent task is not active");
      let parent = input.parent_id;
      let depth = 0;
      while (parent !== null) {
        depth += 1;
        if (depth > MAX_TASK_DEPTH) reject("task hierarchy is limited to 8 levels");
        parent = draft.tasks.find((task) => task.id === parent)!.parent_id;
      }
      const siblings = draft.tasks.filter((task) => task.parent_id === input.parent_id && task.archived_at === null).sort((a, b) => a.order - b.order);
      let order = siblings.length;
      if (input.after_id !== null) {
        const index = siblings.findIndex((task) => task.id === input.after_id);
        if (index < 0) reject("after_id must identify an active sibling");
        order = index + 1;
      }
      for (const sibling of siblings.slice(order)) sibling.order += 1;
      createdId = `task-${this.id()}`;
      draft.tasks.push({ id: createdId, parent_id: input.parent_id, text: input.text, checked: input.checked ?? false, order, created_at: timestamp, updated_at: timestamp, completed_at: input.checked ? timestamp : null, archived_at: input.parent_id === null && input.checked ? timestamp : null });
      if (input.checked && input.parent_id === null) normalizeOrders(draft.tasks, null, false);
    });
    return { workspace, created_id: createdId };
  }

  async createTasks(texts: string[]): Promise<Workspace> {
    if (texts.length === 0 || texts.length > 30 || texts.some((text) => !text.trim() || textLength(text) > MAX_TASK_TEXT_LENGTH || text.includes("\r") || text.includes("\n"))) reject(`texts must contain 1 to 30 non-empty task descriptions of at most ${MAX_TASK_TEXT_LENGTH} characters`);
    return this.transact((draft, timestamp) => {
      let order = draft.tasks.filter((task) => task.parent_id === null && task.archived_at === null).length;
      for (const text of texts) draft.tasks.push({ id: `task-${this.id()}`, parent_id: null, text, checked: false, order: order++, created_at: timestamp, updated_at: timestamp, completed_at: null, archived_at: null });
    });
  }

  async updateTask(id: string, text: string): Promise<Workspace> {
    requireTaskText(text);
    return this.transact((draft, timestamp) => {
      const task = draft.tasks.find((candidate) => candidate.id === id);
      if (!task) reject(`unknown task '${id}'`);
      task.text = text;
      task.updated_at = timestamp;
    });
  }

  async replaceTaskLines(keepId: string | null, text: string, removeIds: string[]): Promise<Workspace> {
    requireTaskText(text);
    if (removeIds.length === 0 || new Set(removeIds).size !== removeIds.length || removeIds.includes(keepId ?? "")) reject("remove_ids must contain distinct task ids other than keep_id");
    if (keepId === null && text !== "") reject("text must be empty when no task line is kept");
    return this.transact((draft, timestamp) => {
      const active = orderedTaskTree(draft.tasks, false);
      const start = keepId === null ? active.findIndex((task) => task.id === removeIds[0]) : active.findIndex((task) => task.id === keepId) + 1;
      const expected = active.slice(start, start + removeIds.length).map((task) => task.id);
      if (start < 0 || expected.length !== removeIds.length || expected.some((id, index) => id !== removeIds[index])) reject("remove_ids must identify contiguous active task lines immediately after keep_id");
      const removed = new Set(removeIds);
      if (keepId !== null) {
        const kept = draft.tasks.find((task) => task.id === keepId && task.archived_at === null);
        if (!kept) reject(`unknown active task '${keepId}'`);
        kept.text = text;
        kept.updated_at = timestamp;
      }
      draft.tasks = draft.tasks.filter((task) => !removed.has(task.id));
      const survivors = active.filter((task) => !removed.has(task.id));
      const byId = new Map(draft.tasks.map((task) => [task.id, task]));
      const ancestors: Task[] = [];
      const nextOrder = new Map<string | null, number>();
      for (const projected of survivors) {
        const task = byId.get(projected.id)!;
        const depth = Math.min(projected.depth, ancestors.length);
        ancestors.length = depth;
        task.parent_id = depth === 0 ? null : ancestors[depth - 1].id;
        task.order = nextOrder.get(task.parent_id) ?? 0;
        nextOrder.set(task.parent_id, task.order + 1);
        ancestors[depth] = task;
      }
    });
  }

  async toggleTask(id: string, checked: boolean): Promise<Workspace> {
    return this.transact((draft, timestamp) => {
      const task = draft.tasks.find((candidate) => candidate.id === id);
      if (!task || task.archived_at !== null) reject(`unknown active task '${id}'`);
      task.checked = checked;
      task.completed_at = checked ? timestamp : null;
      task.updated_at = timestamp;
      if (task.parent_id === null && checked) {
        const subtreeIds = new Set([task.id, ...descendants(draft.tasks, task.id).map((member) => member.id)]);
        for (;;) {
          const blanks = draft.tasks.filter((candidate) => subtreeIds.has(candidate.id) && !candidate.text.trim() && !draft.tasks.some((possibleChild) => possibleChild.parent_id === candidate.id));
          if (blanks.length === 0) break;
          for (const blank of blanks) subtreeIds.delete(blank.id);
          draft.tasks = draft.tasks.filter((candidate) => !blanks.some((blank) => blank.id === candidate.id));
        }
        for (const member of [task, ...descendants(draft.tasks, task.id)]) { member.archived_at = timestamp; member.updated_at = timestamp; }
        normalizeOrders(draft.tasks, null, false);
      }
    });
  }

  async restoreTaskTree(rootId: string): Promise<Workspace> {
    return this.transact((draft, timestamp) => {
      const root = draft.tasks.find((task) => task.id === rootId);
      if (!root || root.parent_id !== null || root.archived_at === null) reject("restore requires an archived root task");
      root.checked = false;
      root.completed_at = null;
      for (const member of [root, ...descendants(draft.tasks, root.id)]) { member.archived_at = null; member.updated_at = timestamp; }
      const activeRoots = draft.tasks.filter((task) => task.parent_id === null && task.archived_at === null && task.id !== root.id).sort((a, b) => a.order - b.order);
      const target = Math.min(root.order, activeRoots.length);
      for (const activeRoot of activeRoots.filter((task) => task.order >= target)) activeRoot.order += 1;
      root.order = target;
      normalizeOrders(draft.tasks, null, false);
    });
  }

  async moveTask(id: string, direction: "indent" | "outdent"): Promise<Workspace> {
    return this.transact((draft, timestamp) => {
      const task = draft.tasks.find((candidate) => candidate.id === id);
      if (!task || task.archived_at !== null) reject(`unknown active task '${id}'`);
      const oldParent = task.parent_id;
      if (direction === "indent") {
        const siblings = draft.tasks.filter((candidate) => candidate.parent_id === oldParent && candidate.archived_at === null).sort((a, b) => a.order - b.order);
        const index = siblings.findIndex((candidate) => candidate.id === id);
        if (index <= 0) reject("task has no preceding sibling to become its parent");
        const parent = siblings[index - 1];
        if (!parent.text.trim()) reject("an empty task cannot become a parent");
        let parentDepth = 1;
        let ancestor = parent.parent_id;
        while (ancestor !== null) { parentDepth += 1; ancestor = draft.tasks.find((candidate) => candidate.id === ancestor)!.parent_id; }
        if (parentDepth + subtreeHeight(draft.tasks, task.id) > MAX_TASK_DEPTH + 1) reject("task hierarchy is limited to 8 levels");
        task.parent_id = parent.id;
        task.order = draft.tasks.filter((candidate) => candidate.parent_id === parent.id && candidate.archived_at === null).length;
      } else {
        if (oldParent === null) reject("root tasks cannot be outdented");
        const parent = draft.tasks.find((candidate) => candidate.id === oldParent)!;
        const newParent = parent.parent_id;
        const siblings = draft.tasks.filter((candidate) => candidate.parent_id === newParent && candidate.archived_at === null).sort((a, b) => a.order - b.order);
        for (const sibling of siblings.filter((candidate) => siblingAfter(candidate, parent))) sibling.order += 1;
        task.parent_id = newParent;
        task.order = parent.order + 1;
      }
      task.updated_at = timestamp;
      normalizeOrders(draft.tasks, oldParent, false);
      normalizeOrders(draft.tasks, task.parent_id, false);
    });
  }

  async deleteTask(id: string): Promise<Workspace> {
    return this.transact((draft) => {
      const task = draft.tasks.find((candidate) => candidate.id === id);
      if (!task) reject(`unknown task '${id}'`);
      if (task.text.trim() !== "" || draft.tasks.some((candidate) => candidate.parent_id === id)) reject("only an empty task without descendants can be deleted");
      draft.tasks = draft.tasks.filter((candidate) => candidate.id !== id);
      normalizeOrders(draft.tasks, task.parent_id, task.archived_at !== null);
    });
  }

  async importTasks(markdown: string, afterId: string | null): Promise<Workspace> {
    if (textLength(markdown) > MAX_IMPORT_LENGTH) reject(`task import is limited to ${MAX_IMPORT_LENGTH} characters`);
    const parsed = parseMarkdownTasks(markdown);
    if (parsed.length === 0) reject("paste contains no task text");
    if (parsed.length > MAX_IMPORTED_TASKS) reject(`task import is limited to ${MAX_IMPORTED_TASKS} tasks`);
    if (parsed.some((line) => textLength(line.text) > MAX_TASK_TEXT_LENGTH)) reject(`imported task text is limited to ${MAX_TASK_TEXT_LENGTH} characters`);
    return this.transact((draft, timestamp) => {
      let availableDepths = 0;
      const depths = parsed.map((line) => { const depth = Math.min(line.depth, availableDepths); availableDepths = depth + 1; return depth; });
      const rootCount = depths.filter((depth) => depth === 0).length;
      let rootOrder = draft.tasks.filter((task) => task.parent_id === null && task.archived_at === null).length;
      if (afterId !== null) {
        const after = draft.tasks.find((task) => task.id === afterId && task.parent_id === null && task.archived_at === null);
        if (!after) reject("after_id must identify an active root for import");
        rootOrder = after.order + 1;
        for (const root of draft.tasks.filter((task) => task.parent_id === null && task.archived_at === null && task.order >= rootOrder)) root.order += rootCount;
      }
      const parents: string[] = [];
      const siblingCounts = new Map<string | null, number>();
      const imported: Task[] = [];
      for (const [index, line] of parsed.entries()) {
        const depth = depths[index];
        const parentId = depth === 0 ? null : parents[depth - 1];
        const order = parentId === null ? rootOrder++ : (siblingCounts.get(parentId) ?? 0);
        siblingCounts.set(parentId, order + 1);
        const task: Task = { id: `task-${this.id()}`, parent_id: parentId, text: line.text, checked: line.checked, order, created_at: timestamp, updated_at: timestamp, completed_at: line.checked ? timestamp : null, archived_at: null };
        draft.tasks.push(task);
        imported.push(task);
        parents[depth] = task.id;
        parents.length = depth + 1;
      }
      for (const root of imported.filter((task) => task.parent_id === null && task.checked)) for (const member of [root, ...descendants(imported, root.id)]) member.archived_at = timestamp;
      normalizeOrders(draft.tasks, null, false);
    });
  }

  async createNote(dailyEntryId: string, content: string): Promise<Workspace> {
    requireNoteContent(content);
    return this.transact((draft, timestamp) => {
      if (!draft.entries.some((entry) => entry.id === dailyEntryId)) reject(`unknown daily entry '${dailyEntryId}'`);
      draft.notes.push({ id: `note-${this.id()}`, daily_entry_id: dailyEntryId, content, order: draft.notes.filter((note) => note.daily_entry_id === dailyEntryId).length, collapsed: false, created_at: timestamp, updated_at: timestamp });
    });
  }

  async updateNote(id: string, content: string): Promise<Workspace> {
    requireNoteContent(content);
    return this.transact((draft, timestamp) => {
      const note = draft.notes.find((candidate) => candidate.id === id);
      if (!note) reject(`unknown note '${id}'`);
      note.content = content;
      note.updated_at = timestamp;
    });
  }

  async setNoteCollapsed(id: string, collapsed: boolean): Promise<Workspace> {
    return this.transact((draft, timestamp) => {
      const note = draft.notes.find((candidate) => candidate.id === id);
      if (!note) reject(`unknown note '${id}'`);
      note.collapsed = collapsed;
      note.updated_at = timestamp;
    });
  }

  async setAllNotesCollapsed(dailyEntryId: string, collapsed: boolean): Promise<Workspace> {
    return this.transact((draft, timestamp) => {
      if (!draft.entries.some((entry) => entry.id === dailyEntryId)) reject(`unknown daily entry '${dailyEntryId}'`);
      for (const note of draft.notes.filter((candidate) => candidate.daily_entry_id === dailyEntryId)) { note.collapsed = collapsed; note.updated_at = timestamp; }
    });
  }

  async deleteNote(id: string): Promise<Workspace> {
    return this.transact((draft) => {
      const note = draft.notes.find((candidate) => candidate.id === id);
      if (!note) reject(`unknown note '${id}'`);
      draft.notes = draft.notes.filter((candidate) => candidate.id !== id);
      draft.notes.filter((candidate) => candidate.daily_entry_id === note.daily_entry_id).sort((a, b) => a.order - b.order).forEach((candidate, index) => { candidate.order = index; });
    });
  }

  proposalWasHandled(artifactId: string): boolean {
    return (this.data.currentRecords().get("applied-proposals") ?? []).some((record) => record.value.artifactId === artifactId);
  }

  handledProposalIds(): Set<string> {
    return new Set((this.data.currentRecords().get("applied-proposals") ?? []).map((record) => String(record.value.artifactId)));
  }

  async applyTaskProposal(artifactId: string, targetGeneration: number, payload: TaskProposalPayload): Promise<Workspace> {
    if (this.proposalWasHandled(artifactId)) reject("this proposal has already been handled");
    if (this.data.currentGeneration() !== targetGeneration) reject(`this proposal is stale; it targets generation ${targetGeneration}, while the workspace is at generation ${this.data.currentGeneration()}`);
    const receipt = this.proposalReceipt(artifactId, "applied", targetGeneration);
    return this.transact((draft) => {
      const result = applyProposalOperations(draft.tasks, payload.operations);
      if (result.error) reject(result.error);
      draft.tasks = result.tasks;
    }, [{ kind: "create", collection: "applied-proposals", value: receipt }]);
  }

  async rejectTaskProposal(artifactId: string, targetGeneration: number): Promise<Workspace> {
    if (this.proposalWasHandled(artifactId)) reject("this proposal has already been handled");
    return this.transact(() => undefined, [{ kind: "create", collection: "applied-proposals", value: this.proposalReceipt(artifactId, "rejected", targetGeneration) }]);
  }

  private proposalReceipt(artifactId: string, status: "applied" | "rejected", targetGeneration: number): Record<string, unknown> {
    return { id: `proposal-${artifactId}`, artifactId, recordedAt: this.now().toISOString(), status, targetGeneration };
  }
}

function siblingAfter(candidate: Task, parent: Task): boolean {
  return candidate.order > parent.order;
}
