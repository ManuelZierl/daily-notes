import type { ParsedTaskLine, Task } from "./types";
import { MAX_TASK_DEPTH } from "./limits.mjs";

const TASK_MARKER = /^\s*-\s*\[([ xX])\]\s?(.*)$/;

export function normalizeTaskText(value: string): { text: string; checked: boolean | null } {
  const match = value.match(TASK_MARKER);
  if (!match) return { text: value, checked: null };
  return { text: match[2], checked: match[1].toLowerCase() === "x" };
}

export function parseMarkdownTasks(markdown: string): ParsedTaskLine[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const widths = lines.flatMap((line) => {
    const marker = line.match(/^(\s*)-\s*\[[ xX]\]/);
    if (!marker) return [];
    const width = marker[1].replace(/\t/g, "    ").length;
    return width > 0 ? [width] : [];
  });
  const indentUnit = widths.length ? Math.max(1, Math.min(...widths)) : 4;
  const parsed: ParsedTaskLine[] = [];
  for (const rawLine of lines) {
    const marker = rawLine.match(/^(\s*)-\s*\[([ xX])\]\s?(.*)$/);
    if (marker) {
      const width = marker[1].replace(/\t/g, "    ").length;
      const depth = Math.min(MAX_TASK_DEPTH, Math.floor(width / indentUnit));
      parsed.push({ text: marker[3], checked: marker[2].toLowerCase() === "x", depth });
    } else if (rawLine.trim()) {
      const whitespace = rawLine.match(/^\s*/)?.[0] ?? "";
      const width = whitespace.replace(/\t/g, "    ").length;
      parsed.push({ text: rawLine.slice(whitespace.length), checked: false, depth: Math.min(MAX_TASK_DEPTH, Math.floor(width / indentUnit)) });
    }
  }
  return parsed;
}

export function orderedTaskTree(tasks: Task[], archived: boolean): Array<Task & { depth: number }> {
  const matching = tasks.filter((task) => (task.archived_at !== null) === archived);
  const children = new Map<string | null, Task[]>();
  for (const task of matching) {
    const siblings = children.get(task.parent_id) ?? [];
    siblings.push(task);
    children.set(task.parent_id, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const result: Array<Task & { depth: number }> = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const task of children.get(parentId) ?? []) {
      result.push({ ...task, depth });
      visit(task.id, depth + 1);
    }
  };
  visit(null, 0);
  return result;
}

export function localDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Shared by direct checkbox changes and reviewed Chat proposals.
export function archiveTaskTree(tasks: Task[], rootId: string, timestamp: string): Task[] {
  const ids = new Set([rootId]);
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parent_id !== null) children.set(task.parent_id, [...(children.get(task.parent_id) ?? []), task]);
  }
  const visit = (id: string) => {
    for (const child of children.get(id) ?? []) { ids.add(child.id); visit(child.id); }
  };
  visit(rootId);
  let remaining = tasks;
  for (;;) {
    const parents = new Set(remaining.map((task) => task.parent_id));
    const blanks = new Set(remaining.filter((task) => ids.has(task.id) && !task.text.trim() && !parents.has(task.id)).map((task) => task.id));
    if (!blanks.size) break;
    remaining = remaining.filter((task) => !blanks.has(task.id));
  }
  for (const task of remaining) {
    if (ids.has(task.id)) { task.archived_at = timestamp; task.updated_at = timestamp; }
  }
  const groups = new Map<string | null, Task[]>();
  for (const task of remaining) {
    // Normalize active roots and archived subtree siblings so restoration is valid.
    if ((task.parent_id === null && task.archived_at === null) || (ids.has(task.id) && task.id !== rootId)) {
      const owner = task.parent_id;
      groups.set(owner, [...(groups.get(owner) ?? []), task]);
    }
  }
  for (const siblings of groups.values()) {
    siblings.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).forEach((task, index) => { task.order = index; });
  }
  return remaining;
}
