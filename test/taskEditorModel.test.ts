import { describe, expect, it } from "vitest";
import { replaceTaskEditorSelection, selectionForLine, selectionInLine, taskEditorLineAt, taskEditorValue, trailingTaskPlacement, type TaskEditorLine } from "../src/surface/taskEditorModel";

const lines: TaskEditorLine[] = [
  { key: "root", text: "Root", depth: 0 },
  { key: "child", text: "Child", depth: 1 },
  { key: "capture", text: "", depth: 0 },
];

describe("task editor projection", () => {
  it("renders one physical line per task with hierarchy prefixes", () => {
    expect(taskEditorValue(lines)).toBe("Root\n  Child\n");
  });

  it("maps carets at line boundaries to the correct task", () => {
    expect(taskEditorLineAt(lines, 4)?.key).toBe("root");
    expect(taskEditorLineAt(lines, 5)?.key).toBe("child");
    expect(taskEditorLineAt(lines, "Root\n  Child\n".length)?.key).toBe("capture");
  });

  it("preserves a text-relative selection when indentation changes", () => {
    const selected = selectionInLine(lines, "child", { start: 8, end: 11, direction: "forward" });
    expect(selected).toEqual({ start: 1, end: 4, direction: "forward" });
    expect(selectionForLine([{ ...lines[1], depth: 2 }], "child", selected!)).toEqual({ start: 5, end: 8, direction: "forward" });
  });

  it("maps a cross-line deletion to one replacement and the removed logical lines", () => {
    const edit = replaceTaskEditorSelection(lines, { start: 2, end: 10, direction: "forward" });

    expect(edit).toEqual({
      keepKey: "root",
      text: "Rold",
      removeKeys: ["child"],
      focusKey: "root",
      selection: { start: 2, end: 2, direction: "none" },
    });
  });

  it("removes every task when the selection includes the trailing blank line", () => {
    const value = taskEditorValue(lines);

    expect(replaceTaskEditorSelection(lines, { start: 0, end: value.length, direction: "forward" })).toEqual({
      keepKey: null,
      text: "",
      removeKeys: ["root", "child", "capture"],
      focusKey: "capture",
      selection: { start: 0, end: 0, direction: "none" },
    });
  });

  it("places a trailing draft at a valid requested depth", () => {
    expect(trailingTaskPlacement(lines.slice(0, -1), 0)).toEqual({ depth: 0, parentKey: null, afterSiblingKey: "root" });
    expect(trailingTaskPlacement(lines.slice(0, -1), 1)).toEqual({ depth: 1, parentKey: "root", afterSiblingKey: "child" });
    expect(trailingTaskPlacement(lines.slice(0, -1), 2)).toEqual({ depth: 2, parentKey: "child", afterSiblingKey: null });
    expect(trailingTaskPlacement([{ key: "blank", text: "", depth: 0 }], 1)).toBeNull();
  });
});
