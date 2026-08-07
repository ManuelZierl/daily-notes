import {
  MAX_ENTRIES,
  MAX_ID_LENGTH,
  MAX_NOTES,
  MAX_NOTE_LENGTH,
  MAX_TASKS,
  MAX_TASK_DEPTH,
  MAX_TASK_TEXT_LENGTH,
} from "./limits.mjs";
import type { Task, Workspace } from "./types";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class WorkspaceValidationError extends Error {
  constructor(message: string) {
    super(`invalid Daily Notes state: ${message}`);
    this.name = "WorkspaceValidationError";
  }
}

function fail(message: string): never {
  throw new WorkspaceValidationError(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[], location: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${location} has unknown or missing fields`);
  }
}

function string(value: unknown, location: string, options: { allowEmpty?: boolean; maxLength?: number } = {}): asserts value is string {
  const { allowEmpty = false, maxLength } = options;
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(`${location} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  if (maxLength !== undefined && Array.from(value).length > maxLength) {
    fail(`${location} exceeds ${maxLength} characters`);
  }
}

function id(value: unknown, location: string): asserts value is string {
  string(value, location, { maxLength: MAX_ID_LENGTH });
}

function nullableString(value: unknown, location: string): asserts value is string | null {
  if (value !== null) string(value, location, { maxLength: 64 });
}

function assertContiguousOrders(ordersByOwner: Map<string | null, number[]>, entity: string): void {
  for (const [owner, orders] of ordersByOwner) {
    orders.sort((a, b) => a - b);
    if (orders.some((order, index) => order !== index)) {
      fail(`${entity} order is not contiguous under '${owner ?? "root"}'`);
    }
  }
}

export function isLocalDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day, 12);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

export function validateWorkspace(value: unknown): asserts value is Workspace {
  if (!isObject(value)) fail("root must be an object");
  exactKeys(value, ["version", "entries", "tasks", "notes"], "root");
  if (value.version !== 1) fail(`unsupported version '${String(value.version)}'`);
  if (!Array.isArray(value.entries) || !Array.isArray(value.tasks) || !Array.isArray(value.notes)) {
    fail("entity collections must be arrays");
  }
  if (value.entries.length > MAX_ENTRIES || value.tasks.length > MAX_TASKS || value.notes.length > MAX_NOTES) {
    fail("an entity collection exceeds its supported size");
  }

  const entryIds = new Set<string>();
  const dates = new Set<string>();
  for (const [index, raw] of value.entries.entries()) {
    if (!isObject(raw)) fail(`entries[${index}] must be an object`);
    exactKeys(raw, ["id", "local_date", "title", "created_at"], `entries[${index}]`);
    id(raw.id, `entries[${index}].id`);
    string(raw.local_date, `entries[${index}].local_date`, { maxLength: 10 });
    string(raw.title, `entries[${index}].title`, { maxLength: 10 });
    string(raw.created_at, `entries[${index}].created_at`, { maxLength: 64 });
    if (!isLocalDate(raw.local_date) || raw.title !== raw.local_date || raw.id !== `day-${raw.local_date}`) {
      fail(`entries[${index}] has an invalid local date identity`);
    }
    if (entryIds.has(raw.id) || dates.has(raw.local_date)) fail(`duplicate entry identity or date '${raw.local_date}'`);
    entryIds.add(raw.id);
    dates.add(raw.local_date);
  }

  const taskById = new Map<string, Task>();
  for (const [index, raw] of value.tasks.entries()) {
    if (!isObject(raw)) fail(`tasks[${index}] must be an object`);
    exactKeys(raw, ["id", "parent_id", "text", "checked", "order", "created_at", "updated_at", "completed_at", "archived_at"], `tasks[${index}]`);
    id(raw.id, `tasks[${index}].id`);
    if (raw.parent_id !== null) id(raw.parent_id, `tasks[${index}].parent_id`);
    string(raw.text, `tasks[${index}].text`, { allowEmpty: true, maxLength: MAX_TASK_TEXT_LENGTH });
    if (/[\r\n]/.test(raw.text)) fail(`tasks[${index}].text must fit on one line`);
    if (typeof raw.checked !== "boolean") fail(`tasks[${index}].checked must be boolean`);
    if (!Number.isInteger(raw.order) || (raw.order as number) < 0) fail(`tasks[${index}].order must be a non-negative integer`);
    string(raw.created_at, `tasks[${index}].created_at`, { maxLength: 64 });
    string(raw.updated_at, `tasks[${index}].updated_at`, { maxLength: 64 });
    nullableString(raw.completed_at, `tasks[${index}].completed_at`);
    nullableString(raw.archived_at, `tasks[${index}].archived_at`);
    if (raw.checked !== (raw.completed_at !== null)) fail(`tasks[${index}] completion metadata is inconsistent`);
    if (taskById.has(raw.id)) fail(`duplicate task id '${raw.id}'`);
    taskById.set(raw.id, raw as unknown as Task);
  }

  const activeOrders = new Map<string | null, number[]>();
  for (const task of taskById.values()) {
    const seen = new Set([task.id]);
    let parent = task.parent_id;
    let depth = 0;
    while (parent !== null) {
      const parentTask = taskById.get(parent);
      if (!parentTask) fail(`task '${task.id}' has unknown parent '${parent}'`);
      if (seen.has(parent)) fail(`task hierarchy contains a cycle at '${parent}'`);
      seen.add(parent);
      depth += 1;
      if (depth > MAX_TASK_DEPTH) fail(`task '${task.id}' exceeds the eight-level hierarchy limit`);
      parent = parentTask.parent_id;
    }
    if (task.parent_id !== null && taskById.get(task.parent_id)!.archived_at !== task.archived_at) {
      fail(`task '${task.id}' archive state differs from its parent`);
    }
    if (task.parent_id === null && task.checked && task.archived_at === null) {
      fail(`completed root task '${task.id}' must be archived`);
    }
    if (task.archived_at === null) {
      const orders = activeOrders.get(task.parent_id) ?? [];
      orders.push(task.order);
      activeOrders.set(task.parent_id, orders);
    }
  }
  assertContiguousOrders(activeOrders, "active task");

  const noteIds = new Set<string>();
  const noteOrders = new Map<string | null, number[]>();
  for (const [index, raw] of value.notes.entries()) {
    if (!isObject(raw)) fail(`notes[${index}] must be an object`);
    exactKeys(raw, ["id", "daily_entry_id", "content", "order", "collapsed", "created_at", "updated_at"], `notes[${index}]`);
    id(raw.id, `notes[${index}].id`);
    id(raw.daily_entry_id, `notes[${index}].daily_entry_id`);
    string(raw.content, `notes[${index}].content`, { allowEmpty: true, maxLength: MAX_NOTE_LENGTH });
    if (!Number.isInteger(raw.order) || (raw.order as number) < 0) fail(`notes[${index}].order must be a non-negative integer`);
    if (typeof raw.collapsed !== "boolean") fail(`notes[${index}].collapsed must be boolean`);
    string(raw.created_at, `notes[${index}].created_at`, { maxLength: 64 });
    string(raw.updated_at, `notes[${index}].updated_at`, { maxLength: 64 });
    if (!entryIds.has(raw.daily_entry_id)) fail(`note '${raw.id}' has unknown daily entry`);
    if (noteIds.has(raw.id)) fail(`duplicate note id '${raw.id}'`);
    noteIds.add(raw.id);
    const orders = noteOrders.get(raw.daily_entry_id) ?? [];
    orders.push(raw.order as number);
    noteOrders.set(raw.daily_entry_id, orders);
  }
  assertContiguousOrders(noteOrders, "note");
}
