import { describe, expect, it } from "vitest";
import { parseTaskProposalArtifact, type TaskProposalOperation } from "../src/surface/proposals";

function artifact(operations: TaskProposalOperation[]) {
  return {
    artifact_id: "proposal-review", artifact_type: "task-change-proposal", title: "Task changes",
    content: { targetAppId: "kestral.daily-notes", targetKind: "collection", collection: "tasks",
      resourceId: "app-data:kestral.daily-notes:tasks", targetGeneration: 0, targetRevision: null,
      payload: { operations } },
  };
}

describe("task proposal validation and review", () => {
  it.each(["create", "update"] as const)("accepts %s text at the Unicode character limit", (kind) => {
    const text = "📝".repeat(500);
    const operation = kind === "create" ? { kind, text } : { kind, taskId: "task", text };
    expect(parseTaskProposalArtifact(artifact([operation])).payload.operations[0].text).toBe(text);
    expect(() => parseTaskProposalArtifact(artifact([{ ...operation, text: text + "x" }]))).toThrow(/text/);
  });

  it.each([
    { kind: "create" as const, text: "Child", parentId: "x".repeat(257) },
    { kind: "update" as const, text: "Change", taskId: "x".repeat(257) },
  ])("rejects identifiers beyond the declared schema limit", (operation) => {
    expect(() => parseTaskProposalArtifact(artifact([operation]))).toThrow(/characters/);
  });

  it("rejects a mismatched resource identity", () => {
    const value = artifact([{ kind: "create", text: "Task" }]);
    value.content.resourceId = "app-data:another-app:tasks";
    expect(() => parseTaskProposalArtifact(value)).toThrow(/resource/);
  });

  it("shows proposed text, checked state and parent before applying", () => {
    const parsed = parseTaskProposalArtifact(artifact([
      { kind: "update", taskId: "root", text: "Renamed", checked: true },
      { kind: "create", text: "Child", parentId: "parent", checked: true },
    ]));
    expect(parsed.effects[0]).toContain("Renamed");
    expect(parsed.effects[0]).toMatch(/complete/i);
    expect(parsed.effects[0]).toMatch(/archive/i);
    expect(parsed.effects[1]).toContain("parent");
    expect(parsed.effects[1]).toMatch(/complete/i);
  });
});
