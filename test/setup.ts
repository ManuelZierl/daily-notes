import "@testing-library/jest-dom/vitest";

Object.defineProperty(globalThis, "CSS", {
  value: { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") },
  configurable: true,
});

globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const bridge = {
  ready() {},
  reportError: () => {},
  onEvent() {},
  invoke(...args: unknown[]) {
    return (globalThis as any).__dailyNotesInvoke(...args);
  },
  data: {
    v2: {
      readSnapshot(request: unknown) { return (globalThis as any).__dailyNotesDataV2.readSnapshot(request); },
      beginBatch(request: unknown) { return (globalThis as any).__dailyNotesDataV2.beginBatch(request); },
      appendBatchOperations(request: unknown) { return (globalThis as any).__dailyNotesDataV2.appendBatchOperations(request); },
      commitBatch(request: unknown) { return (globalThis as any).__dailyNotesDataV2.commitBatch(request); },
      abortBatch(request: unknown) { return (globalThis as any).__dailyNotesDataV2.abortBatch(request); },
    },
  },
  listArtifacts() { return Promise.resolve((globalThis as any).__dailyNotesArtifacts ?? []); },
  getState() {
    return Promise.resolve(structuredClone((globalThis as any).__dailyNotesSurfaceState ?? { revision: 0, value: null }));
  },
  putState(_key: string, expectedRevision: number, value: Record<string, unknown> | null) {
    const current = (globalThis as any).__dailyNotesSurfaceState ?? { revision: 0, value: null };
    if (current.revision !== expectedRevision) return Promise.reject(new Error("surface state revision conflict"));
    const updated = { revision: current.revision + 1, value: structuredClone(value) };
    (globalThis as any).__dailyNotesSurfaceState = updated;
    ((globalThis as any).__dailyNotesSurfaceWrites ??= []).push(structuredClone(updated));
    return Promise.resolve(structuredClone(updated));
  },
};
(globalThis as any).appHost = bridge;
(globalThis as any).confirm = () => true;
