import { MAX_TASK_DEPTH } from "../shared/limits.mjs";

export const TASK_INDENT = "  ";
export { MAX_TASK_DEPTH };

export interface TaskEditorLine {
  key: string;
  text: string;
  depth: number;
}

export interface TaskEditorRange {
  key: string;
  start: number;
  contentStart: number;
  end: number;
}

export interface TextSelection {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}

export interface TaskEditorEdit {
  keepKey: string | null;
  text: string;
  removeKeys: string[];
  focusKey: string;
  selection: TextSelection;
}

export interface TrailingTaskPlacement {
  depth: number;
  parentKey: string | null;
  afterSiblingKey: string | null;
}

export function taskEditorValue(lines: TaskEditorLine[]): string {
  return lines.map((line) => `${TASK_INDENT.repeat(line.depth)}${line.text}`).join("\n");
}

export function taskEditorRanges(lines: TaskEditorLine[]): TaskEditorRange[] {
  let start = 0;
  return lines.map((line) => {
    const contentStart = start + TASK_INDENT.length * line.depth;
    const range = { key: line.key, start, contentStart, end: contentStart + line.text.length };
    start = range.end + 1;
    return range;
  });
}

export function taskEditorLineAt(lines: TaskEditorLine[], offset: number): TaskEditorLine | null {
  const ranges = taskEditorRanges(lines);
  const clamped = Math.max(0, offset);
  const index = ranges.findIndex((range, candidate) => clamped <= range.end || candidate === ranges.length - 1);
  return index < 0 ? null : lines[index];
}

export function selectionInLine(lines: TaskEditorLine[], key: string, selection: TextSelection): TextSelection | null {
  const range = taskEditorRanges(lines).find((candidate) => candidate.key === key);
  if (!range || selection.start < range.contentStart || selection.end > range.end) return null;
  return {
    start: selection.start - range.contentStart,
    end: selection.end - range.contentStart,
    direction: selection.direction,
  };
}

export function selectionForLine(lines: TaskEditorLine[], key: string, selection: TextSelection): TextSelection | null {
  const range = taskEditorRanges(lines).find((candidate) => candidate.key === key);
  if (!range) return null;
  return {
    start: range.contentStart + Math.min(selection.start, range.end - range.contentStart),
    end: range.contentStart + Math.min(selection.end, range.end - range.contentStart),
    direction: selection.direction,
  };
}

export function replaceTaskEditorSelection(lines: TaskEditorLine[], selection: TextSelection, replacement = ""): TaskEditorEdit | null {
  if (lines.length === 0 || replacement.includes("\n") || selection.start === selection.end) return null;
  const ranges = taskEditorRanges(lines);
  const start = Math.max(0, Math.min(selection.start, selection.end));
  const end = Math.max(start, Math.max(selection.start, selection.end));
  const lineIndexAt = (offset: number) => ranges.findIndex((range, index) => offset <= range.end || index === ranges.length - 1);
  const firstIndex = lineIndexAt(start);
  const lastIndex = lineIndexAt(end);
  if (firstIndex < 0 || lastIndex <= firstIndex) return null;

  const first = lines[firstIndex];
  const last = lines[lastIndex];
  const firstOffset = Math.max(0, Math.min(first.text.length, start - ranges[firstIndex].contentStart));
  const lastOffset = Math.max(0, Math.min(last.text.length, end - ranges[lastIndex].contentStart));
  const text = `${first.text.slice(0, firstOffset)}${replacement}${last.text.slice(lastOffset)}`;
  const caret = firstOffset + replacement.length;
  const selectedThroughTrailingBlank = firstIndex === 0
    && start <= ranges[firstIndex].contentStart
    && lastIndex === lines.length - 1
    && last.text === ""
    && end >= ranges[lastIndex].end;

  if (!replacement && selectedThroughTrailingBlank) {
    return {
      keepKey: null,
      text: "",
      removeKeys: lines.map((line) => line.key),
      focusKey: last.key,
      selection: { start: 0, end: 0, direction: "none" },
    };
  }

  return {
    keepKey: first.key,
    text,
    removeKeys: lines.slice(firstIndex + 1, lastIndex + 1).map((line) => line.key),
    focusKey: first.key,
    selection: { start: caret, end: caret, direction: "none" },
  };
}

export function trailingTaskPlacement(lines: TaskEditorLine[], depth: number): TrailingTaskPlacement | null {
  if (!Number.isInteger(depth) || depth < 0 || depth > MAX_TASK_DEPTH) return null;
  if (depth === 0) {
    return {
      depth,
      parentKey: null,
      afterSiblingKey: [...lines].reverse().find((line) => line.depth === 0)?.key ?? null,
    };
  }

  let parentIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].depth < depth - 1) return null;
    if (lines[index].depth === depth - 1) {
      parentIndex = index;
      break;
    }
  }
  if (parentIndex < 0 || !lines[parentIndex].text.trim()) return null;
  return {
    depth,
    parentKey: lines[parentIndex].key,
    afterSiblingKey: [...lines.slice(parentIndex + 1)].reverse().find((line) => line.depth === depth)?.key ?? null,
  };
}

export function textFromEditorLine(value: string, depth: number): string {
  const indent = TASK_INDENT.repeat(depth);
  return value.startsWith(indent) ? value.slice(indent.length) : value.trimStart();
}
