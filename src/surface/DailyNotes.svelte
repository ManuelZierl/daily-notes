<script lang="ts">
  import { tick } from "svelte";
  import type { CreateTaskResult, DailyEntry, NoteBlock, Task, Workspace } from "../shared/types";
  import { localDate, normalizeTaskText, orderedTaskTree } from "../shared/tasks";
  import { MAX_LLM_CONTEXT_LENGTH, MAX_NOTE_LENGTH, MAX_TASK_TEXT_LENGTH } from "../shared/limits.mjs";
  import {
    parseInvocationResult,
    parseLlmContent,
    readSurfaceBridge,
  } from "./surfaceBridge";
  import { DataAdapter } from "./dataAdapter";
  import { reviewTaskProposalArtifacts, type ProposalReview } from "./proposals";
  import { DailyNotesPresentationState } from "./presentationState";
  import { FrontendWorkspaceStore } from "./workspaceStore";
  import {
    MAX_TASK_DEPTH,
    replaceTaskEditorSelection,
    selectionForLine,
    selectionInLine,
    taskEditorLineAt,
    taskEditorRanges,
    taskEditorValue,
    textFromEditorLine,
    trailingTaskPlacement,
    type TaskEditorEdit,
    type TaskEditorLine,
    type TextSelection,
  } from "./taskEditorModel";

  const APP = "kestral.daily-notes";
  const LLM = "llm-provider";
  const initialDate = localDate();
  const host = readSurfaceBridge((globalThis as { appHost?: unknown }).appHost);
  let data: DataAdapter | null = null;
  let startupPromise: Promise<void> | null = null;
  let presentationState: DailyNotesPresentationState | null = null;

  type AiDraft =
    | { kind: "summary"; sourceEntryId: string; sourceDate: string; content: string }
    | { kind: "tasks"; sourceEntryId: string; sourceDate: string; proposals: Array<{ text: string; selected: boolean }> }
    | { kind: "rewrite"; sourceEntryId: string; sourceDate: string; noteId: string; original: string; proposed: string };

  type SearchResult = {
    kind: "day" | "note" | "task";
    id: string;
    label: string;
    date: string | null;
    archived: boolean;
  };

  type EditorLine = TaskEditorLine & {
    taskId: string | null;
    pendingId: string | null;
    checked: boolean;
    kind: "task" | "pending" | "capture";
  };

  type PendingTask = {
    id: string;
    visualAfterKey: string | null;
    afterSiblingKey: string | null;
    parentKey: string | null;
    text: string;
    depth: number;
    checked: boolean;
    hidden: boolean;
    state: "creating" | "failed";
    create: Promise<string | null> | null;
  };

  let workspace = $state<Workspace>({ version: 1, entries: [], tasks: [], notes: [] });
  let store = $state<FrontendWorkspaceStore | null>(null);
  let proposalReviews = $state<ProposalReview[]>([]);
  let proposalBusyId = $state<string | null>(null);
  let today = $state(initialDate);
  let selectedDate = $state(initialDate);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let status = $state("");
  let search = $state("");
  let archiveOpen = $state(false);
  let capture = $state("");
  let captureDepth = $state(0);
  let activeEditorLineKey = $state<string | null>(null);
  let pendingTaskRevision = $state(0);
  let includeTasks = $state(true);
  let aiDraft = $state<AiDraft | null>(null);
  let aiBusy = $state(false);
  let aiConfirming = $state(false);
  let rewriteOperation = $state("clean up wording");
  let rewriteLanguage = $state("");
  let undoRootId = $state<string | null>(null);
  let deleteNoteConfirmation = $state<string | null>(null);
  let searchTarget = $state<{ kind: "note" | "task"; id: string } | null>(null);
  let disposed = false;
  let rolloverInProgress = false;
  let rolloverTimer: ReturnType<typeof setTimeout> | null = null;
  let captureConversionTimer: ReturnType<typeof setTimeout> | null = null;
  const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const locallyHandledProposalIds = new Set<string>();
  const dirtyTasks = new Map<string, { text: string; revision: number }>();
  const dirtyNotes = new Map<string, { content: string; revision: number }>();
  const taskSaves = new Map<string, Promise<boolean>>();
  const noteSaves = new Map<string, Promise<boolean>>();
  const pendingCollapsed = new Map<string, boolean>();
  let deletingTasks = $state(new Set<string>());
  let deletingNotes = $state(new Set<string>());
  const pendingTasks = new Map<string, PendingTask>();
  const resolvedPendingTaskIds = new Map<string, string>();
  const noteHeights = new Map<string, number>();
  let editRevision = 0;
  let nextPendingTask = 0;
  let nextInvokeSequence = 0;
  let appliedInvokeSequence = 0;
  let settledInvokeSequence = 0;
  let busyOperations = 0;
  let editorMutation: Promise<void> = Promise.resolve();
  let allowEditorTabExit = false;

  const selectedEntry = $derived(workspace.entries.find((entry) => entry.local_date === selectedDate) ?? null);
  const dayNotes = $derived(selectedEntry ? workspace.notes.filter((note) => note.daily_entry_id === selectedEntry.id).sort((a, b) => a.order - b.order) : []);
  const allNotesCollapsed = $derived(dayNotes.length > 0 && dayNotes.every((note) => note.collapsed));
  const activeTasks = $derived(orderedTaskTree(workspace.tasks, false));
  const editorLines = $derived.by(() => {
    pendingTaskRevision;
    const lines: EditorLine[] = activeTasks.map((task) => ({
      key: task.id,
      taskId: task.id,
      pendingId: null,
      text: task.text,
      depth: task.depth,
      checked: task.checked,
      kind: "task",
    }));
    for (const pending of pendingTasks.values()) {
      if (pending.hidden) continue;
      const line: EditorLine = {
        key: pending.id,
        taskId: null,
        pendingId: pending.id,
        text: pending.text,
        depth: pending.depth,
        checked: pending.checked,
        kind: "pending",
      };
      const after = pending.visualAfterKey === null ? -1 : lines.findIndex((candidate) => candidate.key === pending.visualAfterKey);
      lines.splice(after < 0 ? lines.length : after + 1, 0, line);
    }
    const placement = validTrailingPlacement(lines, captureDepth);
    lines.push({ key: "capture", taskId: null, pendingId: null, text: capture, depth: placement.depth, checked: false, kind: "capture" });
    return lines;
  });
  const editorText = $derived(taskEditorValue(editorLines));
  const hasFailedTaskCreation = $derived(editorLines.some((line) => line.pendingId !== null && pendingTasks.get(line.pendingId)?.state === "failed"));
  const archivedTasks = $derived(orderedTaskTree(workspace.tasks, true));
  const archivedRoots = $derived(archivedTasks.filter((task) => task.parent_id === null).sort((a, b) => (b.archived_at ?? "").localeCompare(a.archived_at ?? "")));
  const searchResults = $derived.by(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [] as SearchResult[];
    const days: SearchResult[] = workspace.entries.filter((entry) => entry.local_date.includes(query)).map((entry) => ({ kind: "day", id: entry.id, label: entry.local_date, date: entry.local_date, archived: false }));
    const notes: SearchResult[] = workspace.notes.filter((note) => note.content.toLowerCase().includes(query)).map((note) => ({ kind: "note", id: note.id, label: preview(note.content), date: workspace.entries.find((entry) => entry.id === note.daily_entry_id)?.local_date ?? null, archived: false }));
    const tasks: SearchResult[] = workspace.tasks.filter((task) => task.text.toLowerCase().includes(query)).map((task) => ({ kind: "task", id: task.id, label: task.text || "Empty task", date: null, archived: task.archived_at !== null }));
    return [...days, ...notes, ...tasks].slice(0, 20);
  });

  function isCurrentResponse(sequence: number): boolean {
    if (sequence < settledInvokeSequence) return false;
    settledInvokeSequence = sequence;
    return true;
  }

  function failureMessage(result: ReturnType<typeof parseInvocationResult>, label = "Permission"): string | null {
    if (result.kind === "completed") return null;
    return result.kind === "refused"
      ? `${label} refused: ${result.reason}. You can review permissions in Kestral Settings.`
      : result.error;
  }

  function startBusyOperation(): void {
    busyOperations += 1;
    busy = true;
  }

  function finishBusyOperation(): void {
    busyOperations = Math.max(0, busyOperations - 1);
    busy = busyOperations > 0;
  }

  function mergeLocalEdits(next: Workspace): Workspace {
    return {
      ...next,
      tasks: next.tasks.map((task) => {
        const dirty = dirtyTasks.get(task.id);
        return dirty ? { ...task, text: dirty.text } : task;
      }),
      notes: next.notes.map((note) => {
        const dirty = dirtyNotes.get(note.id);
        const collapsed = pendingCollapsed.get(note.id);
        return dirty || collapsed !== undefined
          ? { ...note, ...(dirty ? { content: dirty.content } : {}), ...(collapsed !== undefined ? { collapsed } : {}) }
          : note;
      }),
    };
  }

  function hasPendingEdits(): boolean {
    return dirtyTasks.size > 0 || dirtyNotes.size > 0 || [...pendingTasks.values()].some((task) => !task.hidden);
  }

  function applyWorkspace(next: Workspace, sequence: number): void {
    if (sequence < appliedInvokeSequence) return;
    appliedInvokeSequence = sequence;
    workspace = mergeLocalEdits(next);
  }

  async function invoke(
    capability: string,
    input: Record<string, unknown>,
    options: { showBusy?: boolean; failureStatus?: string } = {},
  ): Promise<Workspace | null> {
    const sequence = ++nextInvokeSequence;
    const { showBusy = true, failureStatus = "Save failed" } = options;
    if (showBusy) startBusyOperation();
    try {
      if (!store) throw new Error("Daily Notes storage is not ready.");
      let next: Workspace;
      switch (capability) {
        case "get_workspace": next = await store.refresh(); break;
        case "get_or_create_day": next = await store.getOrCreateDay(input.local_date as string); break;
        case "create_tasks": next = await store.createTasks(input.texts as string[]); break;
        case "update_task": next = await store.updateTask(input.id as string, input.text as string); break;
        case "replace_task_lines": next = await store.replaceTaskLines(input.keep_id as string | null, input.text as string, input.remove_ids as string[]); break;
        case "move_task": next = await store.moveTask(input.id as string, input.direction as "indent" | "outdent"); break;
        case "toggle_task": next = await store.toggleTask(input.id as string, input.checked as boolean); break;
        case "delete_task": next = await store.deleteTask(input.id as string); break;
        case "restore_task_tree": next = await store.restoreTaskTree(input.root_id as string); break;
        case "import_tasks": next = await store.importTasks(input.markdown as string, input.after_id as string | null); break;
        case "create_note": next = await store.createNote(input.daily_entry_id as string, input.content as string); break;
        case "update_note": next = await store.updateNote(input.id as string, input.content as string); break;
        case "set_note_collapsed": next = await store.setNoteCollapsed(input.id as string, input.collapsed as boolean); break;
        case "set_all_notes_collapsed": next = await store.setAllNotesCollapsed(input.daily_entry_id as string, input.collapsed as boolean); break;
        case "delete_note": next = await store.deleteNote(input.id as string); break;
        case "create_task": throw new Error("create_task uses the task-creation path");
        default: throw new Error(`Unknown Daily Notes operation '${capability}'`);
      }
      if (isCurrentResponse(sequence)) {
        error = data?.refreshWarning() ?? null;
        applyWorkspace(next, sequence);
        status = error ? "Saved; reload required" : hasPendingEdits() ? "Unsaved changes" : "Saved locally";
      }
      return next;
    } catch (failure) {
      if (isCurrentResponse(sequence)) {
        error = failure instanceof Error ? failure.message : String(failure);
        status = failureStatus;
      }
      return null;
    } finally {
      if (showBusy) finishBusyOperation();
    }
  }

  async function invokeTaskCreation(input: Record<string, unknown>): Promise<CreateTaskResult | null> {
    const sequence = ++nextInvokeSequence;
    try {
      if (!host) throw new Error("Kestral's surface bridge is unavailable.");
      if (!store) throw new Error("Daily Notes storage is not ready.");
      const created: CreateTaskResult = await store.createTask({
        text: input.text as string,
        parent_id: input.parent_id as string | null,
        after_id: input.after_id as string | null,
        checked: input.checked as boolean | undefined,
      });
      if (isCurrentResponse(sequence)) {
        error = data?.refreshWarning() ?? null;
        applyWorkspace(created.workspace, sequence);
        status = error ? "Saved; reload required" : hasPendingEdits() ? "Unsaved changes" : "Saved locally";
      }
      return created;
    } catch (failure) {
      if (isCurrentResponse(sequence)) {
        error = failure instanceof Error ? failure.message : String(failure);
        status = "Save failed";
      }
      return null;
    }
  }

  function preview(content: string): string {
    const first = content.split("\n").find((line) => line.trim())?.trim() ?? "Empty note";
    return first.length > 72 ? `${first.slice(0, 69)}...` : first;
  }

  async function copyText(text: string, label: string): Promise<void> {
    try {
      let copied = false;
      if (typeof document.execCommand === "function") {
        const copySource = document.createElement("textarea");
        copySource.value = text;
        copySource.setAttribute("readonly", "");
        copySource.className = "clipboard-source";
        document.body.append(copySource);
        try {
          copySource.select();
          copied = document.execCommand("copy");
        } finally {
          copySource.remove();
        }
      }
      if (!copied && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
      if (!copied) throw new Error("the browser denied clipboard access");
      error = null;
      status = `${label} copied`;
    } catch (failure) {
      error = `Copy failed: ${String(failure)}`;
    }
  }

  async function reloadWorkspace(): Promise<void> {
    // A deliberate reload after a conflict keeps drafts, but does not auto-retry them.
    for (const timer of saveTimers.values()) clearTimeout(timer);
    saveTimers.clear();
    const next = await invoke("get_workspace", {}, { failureStatus: "Refresh failed" });
    if (!next) return;
    if (hasPendingEdits()) status = "Workspace reloaded. Unsaved drafts retained; review before saving.";
    await refreshProposals();
  }

  async function refreshProposals(): Promise<void> {
    if (!host || !store) return;
    try {
      const artifacts = await host.listArtifacts();
      if (!Array.isArray(artifacts)) throw new Error("Kestral returned malformed artifact results.");
      const handledIds = new Set([...store.handledProposalIds(), ...locallyHandledProposalIds]);
      proposalReviews = reviewTaskProposalArtifacts(artifacts, handledIds, data?.currentGeneration() ?? -1);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      status = "Proposal refresh failed";
    }
  }

  function markProposalHandled(artifactId: string): void {
    locallyHandledProposalIds.add(artifactId);
    proposalReviews = proposalReviews.map((candidate) => candidate.artifact.artifact_id === artifactId
      ? { ...candidate, state: "replayed", reason: "Already handled." }
      : candidate);
  }

  async function applyProposal(review: ProposalReview): Promise<void> {
    if (proposalBusyId !== null || review.state !== "ready" || !review.parsed || !store) return;
    const artifactId = review.artifact.artifact_id;
    proposalBusyId = artifactId;
    try {
      if (!(await flushPendingEdits())) return;
      const next = await store.applyTaskProposal(artifactId, review.parsed.targetGeneration, review.parsed.payload);
      workspace = mergeLocalEdits(next);
      error = data?.refreshWarning() ?? null;
      status = error ? "Saved; reload required" : "Task proposal applied";
      markProposalHandled(artifactId);
      await refreshProposals();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      status = "Proposal not applied";
      await refreshProposals();
    } finally {
      proposalBusyId = null;
    }
  }

  async function rejectProposal(review: ProposalReview): Promise<void> {
    if (proposalBusyId !== null || !review.parsed || !store || review.state === "replayed") return;
    const artifactId = review.artifact.artifact_id;
    proposalBusyId = artifactId;
    try {
      await store.rejectTaskProposal(artifactId, review.parsed.targetGeneration);
      error = data?.refreshWarning() ?? null;
      status = error ? "Saved; reload required" : "Task proposal rejected";
      markProposalHandled(artifactId);
      await refreshProposals();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      status = "Proposal rejection failed";
    } finally {
      proposalBusyId = null;
    }
  }

  function activeTasksText(): string {
    return activeTasks.map((task) => {
      const prefix = `${"  ".repeat(task.depth)}- [${task.checked ? "x" : " "}] `;
      return `${prefix}${task.text.replaceAll("\n", `\n${"  ".repeat(task.depth + 1)}`)}`;
    }).join("\n");
  }

  function displayDate(date: string, compact = false): string {
    return new Intl.DateTimeFormat(undefined, compact
      ? { month: "short", day: "numeric" }
      : { weekday: "long", month: "long", day: "numeric", year: "numeric" }
    ).format(new Date(`${date}T12:00:00`));
  }

  function dateGroup(entry: DailyEntry): string {
    const now = new Date(`${today}T12:00:00`);
    const then = new Date(`${entry.local_date}T12:00:00`);
    const days = Math.round((now.getTime() - then.getTime()) / 86_400_000);
    if (days < 7) return "Last 7 days";
    if (days < 30) return "Last 30 days";
    return "Older";
  }

  function entriesIn(group: string): DailyEntry[] {
    return workspace.entries.filter((entry) => dateGroup(entry) === group);
  }

  function taskEditorElement(): HTMLTextAreaElement | null {
    return document.querySelector<HTMLTextAreaElement>("[data-task-editor]");
  }

  function validTrailingPlacement(lines: TaskEditorLine[], requestedDepth: number) {
    for (let depth = Math.min(requestedDepth, MAX_TASK_DEPTH); depth >= 0; depth -= 1) {
      const placement = trailingTaskPlacement(lines, depth);
      if (placement) return placement;
    }
    return { depth: 0, parentKey: null, afterSiblingKey: null };
  }

  function editorLineForKey(key: string): EditorLine | null {
    const resolved = resolvedPendingTaskIds.get(key) ?? key;
    return editorLines.find((line) => line.key === resolved || line.key === key) ?? null;
  }

  function queueEditorMutation(operation: () => Promise<void> | void): void {
    const next = editorMutation.then(operation);
    editorMutation = next.catch((failure) => {
      error = `Task edit failed: ${String(failure)}`;
      status = "Save failed";
    });
  }

  async function focusEditorLine(key: string, selection: TextSelection = { start: 0, end: 0, direction: "none" }): Promise<void> {
    await tick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => {
      const input = taskEditorElement();
      const resolvedKey = resolvedPendingTaskIds.get(key) ?? key;
      const absolute = selectionForLine(editorLines, resolvedKey, selection);
      input?.focus();
      if (input && absolute) {
        input.setSelectionRange(absolute.start, absolute.end, absolute.direction);
        activeEditorLineKey = resolvedKey;
      }
      resolve();
    }));
  }

  function updateActiveEditorLine(input: HTMLTextAreaElement): void {
    const position = input.selectionDirection === "backward" ? input.selectionStart : input.selectionEnd;
    activeEditorLineKey = taskEditorLineAt(editorLines, position)?.key ?? null;
  }

  function autoResizeTask(node: HTMLTextAreaElement, _value: string) {
    const resize = () => {
      node.style.height = "auto";
      node.style.height = `${node.scrollHeight}px`;
    };
    resize();
    node.addEventListener("input", resize);
    return {
      update: resize,
      destroy: () => node.removeEventListener("input", resize),
    };
  }

  function rememberNoteHeight(node: HTMLTextAreaElement, noteId: string) {
    const savedHeight = noteHeights.get(noteId);
    if (savedHeight !== undefined) node.style.height = `${savedHeight}px`;
    const observer = new ResizeObserver(() => {
      const height = node.getBoundingClientRect().height;
      if (height > 0) noteHeights.set(noteId, height);
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }

  function expandNoteToContent(noteId: string): void {
    const input = document.querySelector<HTMLTextAreaElement>(`[data-note-id="${CSS.escape(noteId)}"]`);
    if (!input) return;
    input.style.height = "auto";
    const height = Math.ceil(input.scrollHeight);
    input.style.height = `${height}px`;
    noteHeights.set(noteId, height);
  }

  function updateLocalTask(id: string, text: string): void {
    dirtyTasks.set(id, { text, revision: ++editRevision });
    workspace = { ...workspace, tasks: workspace.tasks.map((task) => task.id === id ? { ...task, text } : task) };
    status = "Unsaved changes";
    const prior = saveTimers.get(id);
    if (prior) clearTimeout(prior);
    saveTimers.set(id, setTimeout(() => void saveTask(id), 350));
  }

  function discardTaskEdit(id: string): void {
    const timer = saveTimers.get(id);
    if (timer) clearTimeout(timer);
    saveTimers.delete(id);
    dirtyTasks.delete(id);
  }

  async function deleteEmptyTask(task: Task, previous?: EditorLine): Promise<void> {
    if (deletingTasks.has(task.id)) return;
    deletingTasks = new Set(deletingTasks).add(task.id);
    try {
      if (!(await saveTask(task.id))) return;
      if (!workspace.tasks.some((candidate) => candidate.id === task.id)) return;
      const next = await invoke("delete_task", { id: task.id });
      if (next) {
        discardTaskEdit(task.id);
        if (previous) void focusEditorLine(previous.key, { start: previous.text.length, end: previous.text.length, direction: "none" });
      }
    } finally {
      const remaining = new Set(deletingTasks);
      remaining.delete(task.id);
      deletingTasks = remaining;
    }
  }

  async function saveTask(id: string): Promise<boolean> {
    const timer = saveTimers.get(id);
    if (timer) clearTimeout(timer);
    saveTimers.delete(id);
    const pending = taskSaves.get(id);
    if (pending) {
      const saved = await pending;
      return saved && await saveTask(id);
    }
    const dirty = dirtyTasks.get(id);
    if (!dirty) return true;
    const save = (async () => {
      const next = await invoke("update_task", { id, text: dirty.text }, { showBusy: false });
      if (!next) return false;
      if (dirtyTasks.get(id)?.revision === dirty.revision) dirtyTasks.delete(id);
      if (error === null) status = hasPendingEdits() ? "Unsaved changes" : "Saved locally";
      return true;
    })();
    taskSaves.set(id, save);
    let saved: boolean;
    try {
      saved = await save;
    } finally {
      if (taskSaves.get(id) === save) taskSaves.delete(id);
    }
    // A newer revision may have consumed its debounce timer during this save.
    return saved && await saveTask(id);
  }

  async function normalizeAndSaveTask(task: Task, value: string): Promise<void> {
    const normalized = normalizeTaskText(value);
    if (normalized.text !== value) updateLocalTask(task.id, normalized.text);
    if (!(await saveTask(task.id))) return;
    if (normalized.checked !== null && normalized.checked !== task.checked) await toggleTask(task.id, normalized.checked);
  }

  function pendingTasksChanged(): void {
    pendingTaskRevision += 1;
  }

  function updateCapture(text: string): void {
    capture = text;
    if (captureConversionTimer) clearTimeout(captureConversionTimer);
    const normalized = normalizeTaskText(capture);
    captureConversionTimer = normalized.checked === null
      ? null
      : setTimeout(() => void convertCapture(), 250);
  }

  function updatePendingTask(id: string, updates: Partial<Pick<PendingTask, "text" | "checked" | "state">>): void {
    const pending = pendingTasks.get(id);
    if (!pending) return;
    Object.assign(pending, updates);
    pendingTasksChanged();
    status = "Unsaved changes";
  }

  async function resolvedTaskKey(key: string | null): Promise<string | null> {
    if (key === null) return null;
    if (workspace.tasks.some((task) => task.id === key)) return key;
    const resolved = resolvedPendingTaskIds.get(key);
    if (resolved) return resolved;
    return startPendingTaskCreation(key);
  }

  function startPendingTaskCreation(id: string): Promise<string | null> {
    const pending = pendingTasks.get(id);
    if (!pending) return Promise.resolve(resolvedPendingTaskIds.get(id) ?? null);
    if (pending.create) return pending.create;
    pending.state = "creating";
    pendingTasksChanged();
    const creation = (async () => {
      const parentId = await resolvedTaskKey(pending.parentKey);
      const afterId = await resolvedTaskKey(pending.afterSiblingKey);
      if ((pending.parentKey !== null && parentId === null) || (pending.afterSiblingKey !== null && afterId === null)) {
        pending.state = "failed";
        pending.create = null;
        pendingTasksChanged();
        return null;
      }
      const sentText = pending.text;
      const sentChecked = pending.checked;
      const created = await invokeTaskCreation({ text: sentText, parent_id: parentId, after_id: afterId, checked: sentChecked });
      if (!created) {
        pending.state = "failed";
        pending.create = null;
        pendingTasksChanged();
        return null;
      }
      const latest = pendingTasks.get(id) ?? pending;
      resolvedPendingTaskIds.set(id, created.created_id);
      pendingTasks.delete(id);
      pendingTasksChanged();
      const serverTask = created.workspace.tasks.find((task) => task.id === created.created_id);
      if (latest.hidden) {
        const deleted = await invoke("delete_task", { id: created.created_id }, { showBusy: false });
        if (deleted) {
          resolvedPendingTaskIds.delete(id);
          return null;
        }
      } else {
        if (serverTask && latest.text !== serverTask.text) {
          updateLocalTask(created.created_id, latest.text);
          void saveTask(created.created_id);
        }
        if (serverTask && latest.checked !== serverTask.checked) void toggleTask(created.created_id, latest.checked);
      }
      return created.created_id;
    })();
    pending.create = creation;
    return creation;
  }

  function createPendingTask(input: Omit<PendingTask, "id" | "hidden" | "state" | "create">): string {
    const id = `pending-task-${++nextPendingTask}`;
    pendingTasks.set(id, { id, ...input, hidden: false, state: "creating", create: null });
    pendingTasksChanged();
    void startPendingTaskCreation(id);
    return id;
  }

  function promoteCapture(checked?: boolean): string | null {
    const normalized = normalizeTaskText(capture);
    if (!normalized.text.trim()) return null;
    if (captureConversionTimer) clearTimeout(captureConversionTimer);
    captureConversionTimer = null;
    const taskLines = editorLines.filter((line) => line.kind !== "capture");
    const placement = validTrailingPlacement(taskLines, captureDepth);
    const visualAfter = taskLines.at(-1)?.key ?? null;
    capture = "";
    captureDepth = placement.depth;
    return createPendingTask({
      visualAfterKey: visualAfter,
      afterSiblingKey: placement.afterSiblingKey,
      parentKey: placement.parentKey,
      text: normalized.text,
      depth: placement.depth,
      checked: checked ?? normalized.checked === true,
    });
  }

  async function convertCapture(): Promise<void> {
    captureConversionTimer = null;
    const input = taskEditorElement();
    const selection = input ? selectionInLine(editorLines, "capture", { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection }) : null;
    const id = promoteCapture();
    if (id) await focusEditorLine(id, selection ?? { start: pendingTasks.get(id)?.text.length ?? 0, end: pendingTasks.get(id)?.text.length ?? 0, direction: "none" });
  }

  function updateEditorLine(line: EditorLine, text: string): void {
    if (line.kind === "capture") updateCapture(text);
    else if (line.pendingId) updatePendingTask(line.pendingId, { text });
    else if (line.taskId && line.text !== text) updateLocalTask(line.taskId, text);
  }

  function taskEditorInput(event: Event): void {
    const input = event.currentTarget as HTMLTextAreaElement;
    updateActiveEditorLine(input);
    const values = input.value.split("\n");
    if (values.length !== editorLines.length) {
      input.value = editorText;
      error = "That task edit could not be applied. Your existing tasks were restored.";
      return;
    }
    for (const [index, line] of editorLines.entries()) {
      const text = textFromEditorLine(values[index], line.depth);
      if (Array.from(text).length > MAX_TASK_TEXT_LENGTH) {
        input.value = editorText;
        error = `Task descriptions are limited to ${MAX_TASK_TEXT_LENGTH} characters.`;
        return;
      }
      if (text !== line.text) updateEditorLine(line, text);
    }
  }

  function normalizeEditorLine(line: EditorLine): void {
    const normalized = normalizeTaskText(line.text);
    if (normalized.text !== line.text) updateEditorLine(line, normalized.text);
    if (line.pendingId && normalized.checked !== null) updatePendingTask(line.pendingId, { checked: normalized.checked });
    if (line.taskId) {
      const task = workspace.tasks.find((candidate) => candidate.id === line.taskId);
      if (task && normalized.checked !== null && normalized.checked !== task.checked) void normalizeAndSaveTask(task, line.text);
      else void saveTask(line.taskId);
    }
  }

  function createSiblingAfter(line: EditorLine): string {
    const index = editorLines.findIndex((candidate) => candidate.key === line.key);
    let subtreeEnd = index;
    while (subtreeEnd + 1 < editorLines.length && editorLines[subtreeEnd + 1].kind !== "capture" && editorLines[subtreeEnd + 1].depth > line.depth) subtreeEnd += 1;
    const reusable = editorLines[subtreeEnd + 1];
    const afterReusable = editorLines[subtreeEnd + 2];
    const reusableIsLeaf = !afterReusable || afterReusable.kind === "capture" || afterReusable.depth <= reusable.depth;
    if (reusable?.kind === "capture") {
      captureDepth = line.depth;
      return reusable.key;
    }
    if (reusable && reusable.depth === line.depth && !reusable.text.trim() && reusableIsLeaf) return reusable.key;
    const task = line.taskId ? workspace.tasks.find((candidate) => candidate.id === line.taskId) : null;
    const pending = line.pendingId ? pendingTasks.get(line.pendingId) : null;
    return createPendingTask({
      visualAfterKey: editorLines[subtreeEnd]?.key ?? line.key,
      afterSiblingKey: line.key,
      parentKey: task?.parent_id ?? pending?.parentKey ?? null,
      text: "",
      depth: line.depth,
      checked: false,
    });
  }

  async function insertTaskLine(key: string): Promise<void> {
    const line = editorLineForKey(key);
    if (!line) return;
    if (line.kind === "capture") {
      const created = promoteCapture();
      if (created) await focusEditorLine("capture");
      return;
    }
    if (!line.text.trim()) {
      await removeEditorLine(line);
      return;
    }
    normalizeEditorLine(line);
    const created = createSiblingAfter(line);
    await focusEditorLine(created);
  }

  async function editorLineTaskId(line: EditorLine): Promise<string | null> {
    if (line.taskId) return line.taskId;
    if (line.pendingId) return startPendingTaskCreation(line.pendingId);
    const promoted = promoteCapture();
    return promoted ? startPendingTaskCreation(promoted) : null;
  }

  async function indentEditorLine(key: string, relative: TextSelection, direction: "indent" | "outdent"): Promise<void> {
    const line = editorLineForKey(key);
    if (!line) return;
    if (direction === "outdent" && line.depth === 0) return;
    if (direction === "indent") {
      const index = editorLines.findIndex((candidate) => candidate.key === line.key);
      let precedingSibling: EditorLine | null = null;
      for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
        if (editorLines[candidate].depth < line.depth) break;
        if (editorLines[candidate].depth === line.depth) {
          precedingSibling = editorLines[candidate];
          break;
        }
      }
      if (!precedingSibling?.text.trim()) {
        status = "Add a non-empty task above before nesting this one";
        return;
      }
    }
    const id = await editorLineTaskId(line);
    if (!id || !(await saveTask(id))) return;
    const next = await invoke("move_task", { id, direction });
    if (next) await focusEditorLine(id, relative);
  }

  async function changeCaptureDepth(input: HTMLTextAreaElement, direction: "indent" | "outdent"): Promise<void> {
    const taskLines = editorLines.filter((line) => line.kind !== "capture");
    const current = validTrailingPlacement(taskLines, captureDepth);
    const relative = selectionInLine(editorLines, "capture", {
      start: input.selectionStart,
      end: input.selectionEnd,
      direction: input.selectionDirection,
    }) ?? { start: 0, end: 0, direction: "none" };
    if (direction === "outdent") {
      captureDepth = Math.max(0, current.depth - 1);
    } else {
      const next = trailingTaskPlacement(taskLines, current.depth + 1);
      if (!next) {
        status = current.depth >= MAX_TASK_DEPTH ? "Tasks can be nested up to 8 levels" : "Add a task above before nesting this one";
        return;
      }
      captureDepth = next.depth;
    }
    await focusEditorLine("capture", relative);
  }

  async function removeEditorLine(line: EditorLine): Promise<void> {
    const index = editorLines.findIndex((candidate) => candidate.key === line.key);
    const previous = index > 0 ? editorLines[index - 1] : undefined;
    if (line.kind === "capture") {
      updateCapture("");
      if (previous) await focusEditorLine(previous.key, { start: previous.text.length, end: previous.text.length, direction: "none" });
      return;
    }
    if (line.pendingId) {
      const pending = pendingTasks.get(line.pendingId);
      if (!pending) return;
      const hasDependentCreation = [...pendingTasks.values()].some((candidate) => candidate.id !== pending.id && (candidate.afterSiblingKey === pending.id || candidate.parentKey === pending.id));
      if (hasDependentCreation) {
        const createdId = await startPendingTaskCreation(pending.id);
        const createdTask = createdId ? workspace.tasks.find((candidate) => candidate.id === createdId) : null;
        if (createdTask) await deleteEmptyTask(createdTask, previous);
        return;
      }
      pending.hidden = true;
      if (pending.state === "failed" && !pending.create) pendingTasks.delete(line.pendingId);
      pendingTasksChanged();
      if (previous) await focusEditorLine(previous.key, { start: previous.text.length, end: previous.text.length, direction: "none" });
      return;
    }
    const task = line.taskId ? workspace.tasks.find((candidate) => candidate.id === line.taskId) : null;
    if (task) {
      if (workspace.tasks.some((candidate) => candidate.parent_id === task.id)) {
        status = "Remove or move nested tasks before deleting their parent";
        return;
      }
      await deleteEmptyTask(task, previous);
    }
  }

  async function applyTaskEditorEdit(edit: TaskEditorEdit): Promise<void> {
    const keepLine = edit.keepKey === null ? null : editorLineForKey(edit.keepKey);
    const removeLines = edit.removeKeys.map(editorLineForKey).filter((line): line is EditorLine => line !== null);
    if (edit.keepKey !== null && !keepLine) return;

    const keepId = keepLine ? await editorLineTaskId(keepLine) : null;
    if (keepLine && !keepId) return;
    const removeIds: string[] = [];
    for (const line of removeLines) {
      if (line.kind === "capture") continue;
      const id = await editorLineTaskId(line);
      if (!id) return;
      removeIds.push(id);
    }

    for (const id of new Set([...(keepId ? [keepId] : []), ...removeIds])) {
      if (!(await saveTask(id))) return;
    }

    if (removeIds.length > 0) {
      const next = await invoke("replace_task_lines", { keep_id: keepId, text: edit.text, remove_ids: removeIds });
      if (!next) return;
      for (const id of removeIds) discardTaskEdit(id);
      if (keepId) discardTaskEdit(keepId);
    } else if (keepLine) {
      updateEditorLine(keepLine, edit.text);
      if (keepId && !(await saveTask(keepId))) return;
    }

    if (removeLines.some((line) => line.kind === "capture")) {
      updateCapture("");
      captureDepth = keepLine?.depth ?? 0;
    }
    await focusEditorLine(edit.focusKey, edit.selection);
  }

  function deleteFromTaskEditor(input: HTMLTextAreaElement, direction: "backward" | "forward"): boolean {
    const selection = { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } satisfies TextSelection;
    const selectedEdit = replaceTaskEditorSelection(editorLines, selection);
    if (selectedEdit) {
      queueEditorMutation(() => applyTaskEditorEdit(selectedEdit));
      return true;
    }
    if (selection.start !== selection.end) return false;

    const line = taskEditorLineAt(editorLines, selection.start) as EditorLine | null;
    if (!line) return false;
    const index = editorLines.findIndex((candidate) => candidate.key === line.key);
    const ranges = taskEditorRanges(editorLines);
    const range = ranges[index];
    if (direction === "backward" && selection.start <= range.contentStart) {
      if (line.kind === "capture" && !line.text && line.depth > 0) {
        void changeCaptureDepth(input, "outdent");
      } else if (!line.text) {
        queueEditorMutation(() => removeEditorLine(line));
      } else if (index > 0) {
        const edit = replaceTaskEditorSelection(editorLines, {
          start: ranges[index - 1].end,
          end: range.contentStart,
          direction: "backward",
        });
        if (edit) queueEditorMutation(() => applyTaskEditorEdit(edit));
      }
      return true;
    }
    if (direction === "forward" && selection.start >= range.end && index < editorLines.length - 1) {
      const next = editorLines[index + 1];
      if (next.kind !== "capture" || next.text) {
        const edit = replaceTaskEditorSelection(editorLines, {
          start: range.end,
          end: ranges[index + 1].contentStart,
          direction: "forward",
        });
        if (edit) queueEditorMutation(() => applyTaskEditorEdit(edit));
      }
      return true;
    }
    return false;
  }

  function taskEditorKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const input = event.currentTarget as HTMLTextAreaElement;
    const line = taskEditorLineAt(editorLines, input.selectionStart) as EditorLine | null;
    if (!line) return;
    if (event.key === "Escape") {
      allowEditorTabExit = true;
      return;
    }
    if (event.key === "Tab" && allowEditorTabExit) {
      allowEditorTabExit = false;
      return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key !== "Shift") allowEditorTabExit = false;
    if (event.key === "Enter") {
      event.preventDefault();
      queueEditorMutation(() => insertTaskLine(line.key));
    } else if (event.key === "Tab") {
      event.preventDefault();
      const relative = selectionInLine(editorLines, line.key, {
        start: input.selectionStart,
        end: input.selectionEnd,
        direction: input.selectionDirection,
      });
      if (!relative) status = "Select within one task to change its hierarchy";
      else if (line.kind === "capture") void changeCaptureDepth(input, event.shiftKey ? "outdent" : "indent");
      else queueEditorMutation(() => indentEditorLine(line.key, relative, event.shiftKey ? "outdent" : "indent"));
    } else if (event.key === "Backspace" && deleteFromTaskEditor(input, "backward")) {
      event.preventDefault();
    } else if (event.key === "Delete" && deleteFromTaskEditor(input, "forward")) {
      event.preventDefault();
    }
  }

  function taskEditorBeforeInput(event: InputEvent): void {
    if (event.isComposing) return;
    const input = event.currentTarget as HTMLTextAreaElement;
    if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
      event.preventDefault();
      const line = taskEditorLineAt(editorLines, input.selectionStart);
      if (line) queueEditorMutation(() => insertTaskLine(line.key));
    } else if (event.inputType.startsWith("delete") && deleteFromTaskEditor(input, event.inputType.includes("Forward") ? "forward" : "backward")) {
      event.preventDefault();
    }
  }

  async function taskEditorPaste(event: ClipboardEvent): Promise<void> {
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!text.includes("\n")) return;
    const input = event.currentTarget as HTMLTextAreaElement;
    const line = taskEditorLineAt(editorLines, input.selectionStart) as EditorLine | null;
    if (line?.kind !== "capture") return;
    event.preventDefault();
    if (captureConversionTimer) clearTimeout(captureConversionTimer);
    captureConversionTimer = null;
    const next = await invoke("import_tasks", { markdown: text, after_id: null });
    if (next) {
      capture = "";
      await focusEditorLine("capture");
    }
  }

  async function retryTaskCreations(): Promise<void> {
    for (const pending of pendingTasks.values()) {
      if (!pending.hidden && pending.state === "failed") await startPendingTaskCreation(pending.id);
    }
  }

  async function taskEditorBlur(): Promise<void> {
    activeEditorLineKey = null;
    await editorMutation;
    for (const line of editorLines) if (line.kind !== "capture") normalizeEditorLine(line);
    await retryTaskCreations();
  }

  function toggleEditorLine(line: EditorLine, checked: boolean): void {
    if (line.kind === "capture") {
      const promoted = promoteCapture(checked);
      if (promoted) void focusEditorLine("capture");
    } else if (line.pendingId) {
      updatePendingTask(line.pendingId, { checked });
      void startPendingTaskCreation(line.pendingId);
    } else if (line.taskId) {
      void toggleTask(line.taskId, checked);
    }
  }

  async function toggleTask(id: string, checked: boolean): Promise<void> {
    if (!(await saveTask(id))) return;
    const task = workspace.tasks.find((candidate) => candidate.id === id);
    const next = await invoke("toggle_task", { id, checked });
    if (next && task?.parent_id === null && checked) {
      undoRootId = id;
      archiveOpen = true;
      status = "Archived";
    }
  }

  async function restore(rootId: string): Promise<void> {
    const next = await invoke("restore_task_tree", { root_id: rootId });
    if (next) {
      undoRootId = null;
       void focusEditorLine(rootId);
    }
  }

  function updateLocalNote(id: string, content: string): void {
    dirtyNotes.set(id, { content, revision: ++editRevision });
    workspace = { ...workspace, notes: workspace.notes.map((note) => note.id === id ? { ...note, content } : note) };
    status = "Unsaved changes";
    const prior = saveTimers.get(id);
    if (prior) clearTimeout(prior);
    saveTimers.set(id, setTimeout(() => void saveNote(id), 500));
  }

  async function saveNote(id: string): Promise<boolean> {
    const timer = saveTimers.get(id);
    if (timer) clearTimeout(timer);
    saveTimers.delete(id);
    const pending = noteSaves.get(id);
    if (pending) {
      const saved = await pending;
      return saved && await saveNote(id);
    }
    const dirty = dirtyNotes.get(id);
    if (!dirty) return true;
    const save = (async () => {
      const next = await invoke("update_note", { id, content: dirty.content }, { showBusy: false });
      if (!next) return false;
      if (dirtyNotes.get(id)?.revision === dirty.revision) dirtyNotes.delete(id);
      if (error === null) status = hasPendingEdits() ? "Unsaved changes" : "Saved locally";
      return true;
    })();
    noteSaves.set(id, save);
    let saved: boolean;
    try {
      saved = await save;
    } finally {
      if (noteSaves.get(id) === save) noteSaves.delete(id);
    }
    // A newer revision may have consumed its debounce timer during this save.
    return saved && await saveNote(id);
  }

  async function deleteNote(note: NoteBlock): Promise<void> {
    if (deletingNotes.has(note.id)) return;
    deletingNotes = new Set(deletingNotes).add(note.id);
    try {
      if (!(await saveNote(note.id))) return;
      const next = await invoke("delete_note", { id: note.id });
      if (next) {
        const timer = saveTimers.get(note.id);
        if (timer) clearTimeout(timer);
        saveTimers.delete(note.id);
        dirtyNotes.delete(note.id);
        pendingCollapsed.delete(note.id);
        noteHeights.delete(note.id);
        deleteNoteConfirmation = null;
      }
    } finally {
      const remaining = new Set(deletingNotes);
      remaining.delete(note.id);
      deletingNotes = remaining;
    }
  }

  async function toggleNote(note: NoteBlock): Promise<void> {
    const collapsed = !note.collapsed;
    pendingCollapsed.set(note.id, collapsed);
    workspace = { ...workspace, notes: workspace.notes.map((candidate) => candidate.id === note.id ? { ...candidate, collapsed } : candidate) };
    if (!(await saveNote(note.id))) {
      pendingCollapsed.delete(note.id);
      workspace = { ...workspace, notes: workspace.notes.map((candidate) => candidate.id === note.id ? { ...candidate, collapsed: note.collapsed } : candidate) };
      return;
    }
    const next = await invoke("set_note_collapsed", { id: note.id, collapsed });
    pendingCollapsed.delete(note.id);
    if (!next) workspace = { ...workspace, notes: workspace.notes.map((candidate) => candidate.id === note.id ? { ...candidate, collapsed: note.collapsed } : candidate) };
  }

  async function flushNoteEdits(): Promise<boolean> {
    for (const id of new Set([...dirtyNotes.keys(), ...noteSaves.keys()])) if (!(await saveNote(id))) return false;
    return true;
  }

  async function flushPendingEdits(): Promise<boolean> {
    await retryTaskCreations();
    for (const pending of pendingTasks.values()) {
      if (!pending.hidden && await startPendingTaskCreation(pending.id) === null) return false;
    }
    for (const id of new Set([...dirtyTasks.keys(), ...taskSaves.keys()])) if (!(await saveTask(id))) return false;
    return flushNoteEdits();
  }

  async function toggleAllNotes(): Promise<void> {
    if (!(await flushNoteEdits()) || !selectedEntry) return;
    await invoke("set_all_notes_collapsed", { daily_entry_id: selectedEntry.id, collapsed: !allNotesCollapsed });
  }

  async function selectDay(date: string): Promise<boolean> {
    if (!(await flushPendingEdits())) return false;
    selectedDate = date;
    void persistSelectedDate(date);
    return true;
  }

  async function persistSelectedDate(date: string): Promise<void> {
    try {
      await presentationState?.persistSelectedDate(date);
    } catch (failure) {
      const message = `Daily Notes could not save the selected day: ${failure instanceof Error ? failure.message : String(failure)}`;
      host?.reportError(message);
      status = "The selected day was not saved. Choose it again to retry.";
    }
  }

  async function openSearchResult(result: SearchResult): Promise<void> {
    const query = search.trim();
    if (result.date && !(await selectDay(result.date))) return;
    if (result.kind === "day") {
      search = "";
      searchTarget = null;
      return;
    }
    if (result.kind === "note") {
      const note = workspace.notes.find((candidate) => candidate.id === result.id);
      if (note?.collapsed) await toggleNote(note);
    } else if (result.archived) {
      archiveOpen = true;
    }
    search = "";
    searchTarget = { kind: result.kind, id: result.id };
    await tick();
    if (result.kind === "task" && !result.archived) {
      const editor = taskEditorElement();
      editor?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      const task = workspace.tasks.find((candidate) => candidate.id === result.id);
      const start = task?.text.toLowerCase().indexOf(query.toLowerCase()) ?? -1;
      if (start >= 0) await focusEditorLine(result.id, { start, end: start + query.length, direction: "none" });
      return;
    }
    const selector = result.kind === "note"
      ? `[data-note-id="${CSS.escape(result.id)}"]`
      : `[data-archived-task-id="${CSS.escape(result.id)}"]`;
    const target = document.querySelector<HTMLElement>(selector);
    target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    if (target instanceof HTMLTextAreaElement) {
      target.focus({ preventScroll: true });
      const start = target.value.toLowerCase().indexOf(query.toLowerCase());
      if (start >= 0) target.setSelectionRange(start, start + query.length);
    } else {
      target?.focus({ preventScroll: true });
    }
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  async function callLlm(system: string, content: string, responseFormat?: object): Promise<string | null> {
    if (aiBusy) return null;
    if (Array.from(content).length > MAX_LLM_CONTEXT_LENGTH) {
      error = `The selected notes and tasks exceed the ${MAX_LLM_CONTEXT_LENGTH}-character AI context limit. Nothing was sent.`;
      return null;
    }
    const sequence = ++nextInvokeSequence;
    aiBusy = true;
    error = null;
    try {
      if (!host) throw new Error("Kestral's surface bridge is unavailable.");
      const result = parseInvocationResult(await host.invoke({ provider: LLM, capability: "llm.generate" }, {
        messages: [{ role: "system", content: system }, { role: "user", content }],
        ...(responseFormat ? { response_format: responseFormat } : {}),
        max_output_tokens: 1200,
      }));
      if (result.kind !== "completed") {
        const failure = failureMessage(result, "LLM permission")!;
        if (isCurrentResponse(sequence)) error = `${failure} Your notes were not changed.`;
        return null;
      }
      const proposed = parseLlmContent(result.value);
      if (isCurrentResponse(sequence)) error = null;
      return proposed;
    } catch (failure) {
      if (isCurrentResponse(sequence)) {
        error = `LLM action failed: ${failure instanceof Error ? failure.message : String(failure)}. Your notes were not changed.`;
      }
      return null;
    } finally {
      aiBusy = false;
    }
  }

  function dayContext(notes: NoteBlock[], date: string): string {
    const noteText = notes.map((note, index) => `Note ${index + 1}:\n${note.content}`).join("\n\n");
    const taskText = includeTasks ? `\n\nActive tasks:\n${activeTasks.map((task) => `${"  ".repeat(task.depth)}- [${task.checked ? "x" : " "}] ${task.text}`).join("\n")}` : "";
    return `Date: ${date}\n\n${noteText || "No notes."}${taskText}`;
  }

  async function summarize(): Promise<void> {
    const source = selectedEntry;
    if (!source) return;
    const content = await callLlm("Create a concise factual daily summary from the supplied notes. Do not invent events or instructions. Return only the proposed summary text.", dayContext([...dayNotes], source.local_date));
    if (content !== null) aiDraft = { kind: "summary", sourceEntryId: source.id, sourceDate: source.local_date, content };
  }

  async function extractTasks(note?: NoteBlock): Promise<void> {
    const source = note
      ? workspace.entries.find((entry) => entry.id === note.daily_entry_id) ?? null
      : selectedEntry;
    if (!source) return;
    const schema = { type: "object", properties: { tasks: { type: "array", maxItems: 30, items: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: MAX_TASK_TEXT_LENGTH, pattern: "^[^\\r\\n]*$" } }, required: ["text"], additionalProperties: false } } }, required: ["tasks"], additionalProperties: false };
    const content = await callLlm("Identify only concrete actionable tasks. Return JSON matching the supplied schema. Do not add commentary.", dayContext(note ? [note] : [...dayNotes], source.local_date), schema);
    if (content === null) return;
    try {
      const parsed: unknown = JSON.parse(content);
      if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.tasks) || parsed.tasks.length > 30) {
        throw new Error("invalid task proposal shape");
      }
      const texts = parsed.tasks.map((task) => {
        if (!isRecord(task) || Object.keys(task).length !== 1 || typeof task.text !== "string" || !task.text.trim() || /[\r\n]/.test(task.text) || Array.from(task.text).length > MAX_TASK_TEXT_LENGTH) {
          throw new Error("invalid task proposal shape");
        }
        return task.text.trim();
      });
      aiDraft = { kind: "tasks", sourceEntryId: source.id, sourceDate: source.local_date, proposals: texts.map((text) => ({ text, selected: true })) };
    } catch (failure) {
      error = `The LLM returned invalid structured task proposals (${String(failure)}). No tasks were created.`;
    }
  }

  async function rewrite(note: NoteBlock): Promise<void> {
    if (!(await saveNote(note.id))) return;
    const original = workspace.notes.find((candidate) => candidate.id === note.id)?.content ?? note.content;
    if (rewriteOperation === "translate" && !rewriteLanguage.trim()) {
      error = "Enter a target language before translating. Your note was not changed.";
      return;
    }
    const operation = rewriteOperation === "translate" ? `translate it into ${rewriteLanguage.trim()}` : rewriteOperation;
    const proposed = await callLlm(`Rewrite the supplied note to ${operation}. Preserve factual meaning and Markdown syntax where practical. Return only the proposed replacement.`, original);
    const source = workspace.entries.find((entry) => entry.id === note.daily_entry_id);
    if (proposed !== null && source) aiDraft = { kind: "rewrite", sourceEntryId: source.id, sourceDate: source.local_date, noteId: note.id, original, proposed };
  }

  async function confirmAi(mode: "replace" | "insert" | "tasks"): Promise<void> {
    if (!aiDraft || aiConfirming) return;
    const draft = aiDraft;
    const sourceEntry = workspace.entries.find((entry) => entry.id === draft.sourceEntryId);
    if (!sourceEntry) {
      error = "The day used for this suggestion no longer exists. Nothing was changed.";
      return;
    }
    if (mode === "replace" && draft.kind === "rewrite") {
      const current = workspace.notes.find((note) => note.id === draft.noteId);
      if (!current || current.content !== draft.original) {
        error = "The original note changed after this rewrite was generated. Review it again before replacing the note.";
        return;
      }
    }
    aiConfirming = true;
    try {
      if (mode === "tasks" && draft.kind === "tasks") {
        const texts = draft.proposals.filter((candidate) => candidate.selected).map((proposal) => proposal.text);
        if (!(await invoke("create_tasks", { texts }))) return;
      } else if (mode === "replace" && draft.kind === "rewrite") {
        if (!(await invoke("update_note", { id: draft.noteId, content: draft.proposed }))) return;
      } else {
        const content = draft.kind === "summary" ? draft.content : draft.kind === "rewrite" ? draft.proposed : "";
        if (!(await invoke("create_note", { daily_entry_id: sourceEntry.id, content }))) return;
      }
      if (aiDraft === draft) aiDraft = null;
    } finally {
      aiConfirming = false;
    }
  }

  function scheduleRollover(retry = false): void {
    if (rolloverTimer) clearTimeout(rolloverTimer);
    if (disposed) return;
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    rolloverTimer = setTimeout(() => void checkRollover(), retry ? 30_000 : next.getTime() - now.getTime());
  }

  async function checkRollover(): Promise<void> {
    if (disposed || rolloverInProgress || !store) return;
    rolloverInProgress = true;
    let retry = false;
    try {
      const nextToday = localDate();
      if (nextToday === today) return;
      const previousToday = today;
      const viewedCurrent = selectedDate === previousToday;
      // Save text before day creation cleans up transient empty task records.
      if (!(await flushPendingEdits()) || disposed) { retry = true; return; }
      const next = await invoke("get_or_create_day", { local_date: nextToday }, { showBusy: false, failureStatus: "Refresh failed" });
      if (!next || disposed) { retry = true; return; }
      today = nextToday;
      if (viewedCurrent && selectedDate === previousToday) {
        selectedDate = nextToday;
        void persistSelectedDate(nextToday);
      } else status = `A new daily entry is ready for ${nextToday}.`;
    } finally {
      rolloverInProgress = false;
      scheduleRollover(retry);
    }
  }

  function loadInitialDay(date: string): Promise<void> {
    if (startupPromise) return startupPromise;
    startupPromise = (async () => {
      loading = true;
      error = null;
      if (!host) {
        error = "Kestral's data.v2 bridge is unavailable.";
        return;
      }
      try {
        presentationState = new DailyNotesPresentationState(host);
        let restoredDate: string | null = null;
        try {
          restoredDate = await presentationState.restoreSelectedDate();
        } catch (failure) {
          host.reportError(`Daily Notes could not restore the selected day: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
        const adapter = DataAdapter.fromHost(host);
        const nextStore = await FrontendWorkspaceStore.open(adapter);
        data = adapter;
        store = nextStore;
        const next = await invoke("get_or_create_day", { local_date: date }, { showBusy: false, failureStatus: "Load failed" });
        if (next) {
          selectedDate = restoredDate && next.entries.some((entry) => entry.local_date === restoredDate) ? restoredDate : date;
          void persistSelectedDate(selectedDate);
        }
        await refreshProposals();
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        status = "Load failed";
      } finally {
        loading = false;
      }
    })().finally(() => {
      startupPromise = null;
    });
    return startupPromise;
  }

  $effect(() => {
    if (!host) {
      loading = false;
      error = "Kestral's data.v2 bridge is unavailable.";
      return;
    }
    disposed = false;
    host.ready();
    host.onEvent?.(() => {
      if (disposed || !store) return;
      // Do not silently rebase unsaved edits onto another window's changes.
      if (hasPendingEdits()) { void refreshProposals(); return; }
      void invoke("get_workspace", {}, { showBusy: false, failureStatus: "Refresh failed" })
        .then((next) => { if (next && !disposed) return refreshProposals(); });
    });
    const visibility = () => {
      if (document.hidden) void flushPendingEdits();
      else void checkRollover();
    };
    document.addEventListener("visibilitychange", visibility);
    void loadInitialDay(initialDate);
    scheduleRollover();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", visibility);
      if (rolloverTimer) clearTimeout(rolloverTimer);
      if (captureConversionTimer) clearTimeout(captureConversionTimer);
      for (const timer of saveTimers.values()) clearTimeout(timer);
    };
  });
</script>

<div class="app-shell">
  <aside aria-label="Daily entry navigation">
    <div class="brand">
      <strong>Daily Notes</strong>
    </div>
    <button class="today-button" type="button" aria-current={selectedDate === today ? "page" : undefined} onclick={() => void selectDay(today)}>Today <span>{displayDate(today, true)}</span></button>
    <label class="search-label" for="search">Search</label>
    <input id="search" class="search" type="search" bind:value={search} placeholder="Notes, tasks, dates" />
    {#if search.trim()}
      <div class="search-results" aria-label="Search results">
        {#each searchResults as result}
          <button type="button" onclick={() => void openSearchResult(result)}>
            <span>{result.label}</span><small>{result.kind === "note" ? `Note · ${result.date}` : result.date ?? (result.archived ? "Archived task" : "Active task")}</small>
          </button>
        {:else}<p>No matches</p>{/each}
      </div>
    {:else}
      <nav aria-label="Previous daily entries">
        {#each ["Last 7 days", "Last 30 days", "Older"] as group}
          {#if entriesIn(group).length}
            <h2>{group}</h2>
            {#each entriesIn(group) as entry (entry.id)}
              <button type="button" class:current={entry.local_date === selectedDate} aria-current={entry.local_date === selectedDate ? "page" : undefined} onclick={() => void selectDay(entry.local_date)}>{entry.local_date}</button>
            {/each}
          {/if}
        {/each}
      </nav>
    {/if}
  </aside>

  <main>
    {#if loading}
      <p class="empty-state">Loading today's workspace...</p>
    {:else if selectedEntry}
      <header class="day-header">
        <h1>{displayDate(selectedEntry.local_date)}</h1>
        {#if selectedDate !== today}<button type="button" class="secondary" onclick={() => void selectDay(today)}>Today</button>{/if}
      </header>

       <p class:failure={status.endsWith("failed")} class="status" aria-live="polite">{status}</p>
       {#if error}<div class="error" role="alert"><span>{error}</span><div class="button-group">{#if hasFailedTaskCreation}<button type="button" class="secondary" onclick={() => void retryTaskCreations()}>Retry task creation</button>{/if}<button type="button" class="secondary" disabled={busy} onclick={() => void reloadWorkspace()}>Reload saved data</button><button type="button" aria-label="Dismiss error" onclick={() => error = null}>Dismiss</button></div></div>{/if}

       {#if proposalReviews.length}
         <section class="proposal-inbox" aria-labelledby="proposal-heading">
           <div class="section-heading"><div><h2 id="proposal-heading">Task proposals</h2><p class="draft-source">Reviewable changes from Chat. Nothing is applied automatically.</p></div></div>
           <div class="proposal-list">
             {#each proposalReviews as review (review.artifact.artifact_id)}
               <article class:proposal-ready={review.state === "ready"} class:proposal-refused={review.state !== "ready"} class="proposal-card">
                 <h3>{review.parsed?.title ?? review.artifact.title ?? "Task proposal"}</h3>
                 {#if review.parsed}
                   <ul class="proposal-effects">{#each review.parsed.effects as effect}<li>{effect}</li>{/each}</ul>
                 {/if}
                 <p class="proposal-reason" role={review.state === "ready" ? undefined : "status"}>{review.reason}</p>
                 {#if review.state === "ready" && review.parsed}
                   <div class="button-group"><button type="button" disabled={proposalBusyId !== null} onclick={() => void applyProposal(review)}>Apply</button><button type="button" class="secondary" disabled={proposalBusyId !== null} onclick={() => void rejectProposal(review)}>Reject</button></div>
                 {:else if review.parsed && review.state !== "replayed"}
                   <button type="button" class="secondary" disabled={proposalBusyId !== null} onclick={() => void rejectProposal(review)}>Record rejection</button>
                 {/if}
               </article>
             {/each}
           </div>
         </section>
       {/if}

       <section aria-labelledby="tasks-heading" class="workspace-section tasks-section">
        <div class="section-heading"><h2 id="tasks-heading">Tasks</h2><div class="section-meta"><span>{activeTasks.filter((task) => task.depth === 0).length} open</span><button class="icon-button" type="button" aria-label="Copy all active tasks" title="Copy all active tasks" disabled={activeTasks.length === 0} onclick={() => void copyText(activeTasksText(), "Tasks")}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 8h11v11H8z"></path><path d="M5 16V5h11"></path></svg></button></div></div>
        <div class="task-editor" aria-label="Active shared tasks">
          <div class="task-checkboxes" aria-label="Task completion">
            {#each editorLines as line (line.key)}
              <div class="task-checkbox-line" data-task-depth={line.depth} style={`--task-depth: ${line.depth}`} class:search-match={line.taskId !== null && searchTarget?.kind === "task" && searchTarget.id === line.taskId} class:pending-failure={line.pendingId !== null && pendingTasks.get(line.pendingId)?.state === "failed"}>
                {#if line.text.trim()}
                  <input type="checkbox" checked={line.checked} aria-label={`Mark ${line.text} ${line.checked ? "not completed" : "completed"}`} onchange={(event) => toggleEditorLine(line, event.currentTarget.checked)} disabled={busy || deletingTasks.size > 0} />
                {:else if line.key === activeEditorLineKey}
                  <span class="task-checkbox-ghost" aria-hidden="true"></span>
                {/if}
              </div>
            {/each}
          </div>
          <label class="sr-only" for="task-editor-text">Active tasks. One task per line.</label>
          <textarea id="task-editor-text" class="task-editor-text" data-task-editor rows={Math.max(2, editorLines.length)} value={editorText} wrap="off" spellcheck="true" aria-describedby="task-editor-help" aria-busy={deletingTasks.size > 0} readonly={deletingTasks.size > 0} use:autoResizeTask={editorText} oninput={taskEditorInput} onkeydown={taskEditorKeydown} onbeforeinput={taskEditorBeforeInput} onpaste={(event) => void taskEditorPaste(event)} onfocus={(event) => updateActiveEditorLine(event.currentTarget)} onselect={(event) => updateActiveEditorLine(event.currentTarget)} onclick={(event) => updateActiveEditorLine(event.currentTarget)} onkeyup={(event) => updateActiveEditorLine(event.currentTarget)} onblur={() => void taskEditorBlur()} placeholder="Type a task, then press Enter"></textarea>
        </div>
        <p id="task-editor-help" class="task-editor-help">Enter adds a task · Tab nests · Shift+Tab unnests · Escape then Tab moves on</p>

        <div class="archive">
          <button class="disclosure" type="button" aria-expanded={archiveOpen} onclick={() => archiveOpen = !archiveOpen}><span aria-hidden="true">{archiveOpen ? "▾" : "▸"}</span> Archived <span>{archivedRoots.length}</span></button>
          {#if undoRootId}<button type="button" class="undo" onclick={() => void restore(undoRootId!)}>Undo</button>{/if}
          {#if archiveOpen}
            <div class="archive-list">
              {#each archivedRoots as root (root.id)}
                <article>
                  {#each archivedTasks.filter((task) => task.id === root.id || isDescendantOf(task, root.id, workspace.tasks)) as task}
                    <div class="archived-task" class:search-match={searchTarget?.kind === "task" && searchTarget.id === task.id} tabindex="-1" data-archived-task-id={task.id} style={`--task-depth: ${task.depth}`}>{task.text || "Empty task"}</div>
                  {/each}
                  <footer><time datetime={root.archived_at ?? undefined}>{new Date(root.archived_at!).toLocaleDateString()}</time><button type="button" class="secondary" onclick={() => void restore(root.id)}>Restore</button></footer>
                </article>
              {:else}<p class="empty-state">Nothing archived</p>{/each}
            </div>
          {/if}
        </div>
      </section>

      <section aria-labelledby="notes-heading" class="workspace-section">
        <div class="section-heading notes-heading">
          <h2 id="notes-heading">Notes</h2>
          <div class="button-group">{#if dayNotes.length > 1}<button type="button" class="secondary" onclick={() => void toggleAllNotes()}>{allNotesCollapsed ? "Expand all" : "Collapse all"}</button>{/if}<button class="icon-button add" type="button" aria-label="Add note" title="Add note" onclick={() => void invoke("create_note", { daily_entry_id: selectedEntry.id, content: "" })}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg></button></div>
        </div>
        <div class="notes-list">
          {#each dayNotes as note, index (note.id)}
            <article class="note-block" class:search-match={searchTarget?.kind === "note" && searchTarget.id === note.id}>
               <header>
                <button class="note-disclosure" type="button" aria-expanded={!note.collapsed} aria-controls={`note-${note.id}`} disabled={deletingNotes.has(note.id)} onclick={() => void toggleNote(note)}><span class="disclosure-icon" aria-hidden="true">{note.collapsed ? "▸" : "▾"}</span><span>{note.collapsed ? `Note ${index + 1}: ${preview(note.content)}` : `Note ${index + 1}`}</span></button>
                 <div class="note-header-actions"><button class="icon-button" type="button" aria-label={`Copy note ${index + 1}`} title="Copy all note text" disabled={!note.content || deletingNotes.has(note.id)} onclick={() => void copyText(note.content, `Note ${index + 1}`)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 8h11v11H8z"></path><path d="M5 16V5h11"></path></svg></button>{#if !note.collapsed}<button class="icon-button" type="button" aria-label={`Expand note ${index + 1} to fit content`} title="Expand to fit content" disabled={deletingNotes.has(note.id)} onclick={() => expandNoteToContent(note.id)}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 8l4-4 4 4M12 4v6M8 16l4 4 4-4M12 14v6"></path></svg></button>{/if}{#if deleteNoteConfirmation === note.id}<span class="delete-question">Delete this note?</span><button type="button" class="danger" aria-label={`Confirm delete note ${index + 1}`} disabled={deletingNotes.has(note.id)} onclick={() => void deleteNote(note)}>{deletingNotes.has(note.id) ? "Deleting..." : "Delete"}</button><button type="button" class="secondary" aria-label={`Cancel delete note ${index + 1}`} disabled={deletingNotes.has(note.id)} onclick={() => deleteNoteConfirmation = null}>Cancel</button>{:else}<button type="button" class="icon-button danger" aria-label={`Delete note ${index + 1}`} title="Delete note" onclick={() => deleteNoteConfirmation = note.id}><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path></svg></button>{/if}</div>
              </header>
              {#if !note.collapsed}
                <div id={`note-${note.id}`}>
                   <textarea value={note.content} data-note-id={note.id} aria-label={`Note ${index + 1} content`} aria-busy={deletingNotes.has(note.id)} maxlength={MAX_NOTE_LENGTH} disabled={deletingNotes.has(note.id)} placeholder="Write a note..." use:rememberNoteHeight={note.id} oninput={(event) => updateLocalNote(note.id, event.currentTarget.value)} onblur={() => void saveNote(note.id)}></textarea>
                  <div class="note-actions">
                    <button type="button" class="secondary" disabled={aiBusy || !note.content.trim()} onclick={() => void extractTasks(note)}>Extract tasks</button>
                    <select bind:value={rewriteOperation} aria-label="Rewrite operation"><option>clean up wording</option><option>shorten</option><option>translate</option><option>format as status update</option></select>
                    {#if rewriteOperation === "translate"}<input class="language" bind:value={rewriteLanguage} aria-label="Translation target language" placeholder="Target language" />{/if}
                    <button type="button" class="secondary" disabled={aiBusy || !note.content.trim()} onclick={() => void rewrite(note)}>Rewrite</button>
                  </div>
                </div>
              {/if}
            </article>
          {:else}<p class="empty-state">No notes yet</p>{/each}
        </div>

        <details class="ai-tools">
          <summary>AI tools</summary>
          <div class="ai-bar">
            <label><input type="checkbox" bind:checked={includeTasks} /> Include tasks</label>
            <div class="button-group"><button type="button" class="secondary" disabled={aiBusy || dayNotes.length === 0} onclick={() => void summarize()}>{aiBusy ? "Working..." : "Summarize day"}</button><button type="button" class="secondary" disabled={aiBusy || dayNotes.length === 0} onclick={() => void extractTasks()}>Extract from notes</button></div>
          </div>
        </details>
      </section>

      {#if aiDraft}
        <section class="draft" aria-labelledby="draft-heading">
          <div class="section-heading"><div><h2 id="draft-heading">Review suggestion</h2><p class="draft-source">From {displayDate(aiDraft.sourceDate)}</p></div><button class="text-button" type="button" disabled={aiConfirming} onclick={() => aiDraft = null}>Cancel</button></div>
          {#if aiDraft.kind === "summary"}<pre>{aiDraft.content}</pre><button type="button" disabled={aiConfirming} onclick={() => void confirmAi("insert")}>Insert as new note</button>
          {:else if aiDraft.kind === "tasks"}<fieldset><legend>Select root tasks to add</legend>{#each aiDraft.proposals as proposal}<label><input type="checkbox" disabled={aiConfirming} bind:checked={proposal.selected} /><span>{proposal.text}</span></label>{/each}</fieldset><button type="button" disabled={aiConfirming || !aiDraft.proposals.some((proposal) => proposal.selected)} onclick={() => void confirmAi("tasks")}>Add selected tasks</button>
          {:else}<div class="comparison"><div><h3>Original</h3><pre>{aiDraft.original}</pre></div><div><h3>Proposed</h3><pre>{aiDraft.proposed}</pre></div></div><div class="button-group"><button type="button" disabled={aiConfirming} onclick={() => void confirmAi("replace")}>Replace original</button><button type="button" class="secondary" disabled={aiConfirming} onclick={() => void confirmAi("insert")}>Insert as new note</button></div>{/if}
        </section>
      {/if}
    {:else}
      <section class="startup-state" aria-labelledby="startup-heading">
        <h1 id="startup-heading">Daily Notes could not open</h1>
        {#if error}<div class="error" role="alert"><span>{error}</span></div>{:else}<p>No daily entry was returned.</p>{/if}
        {#if host}<button type="button" disabled={loading} onclick={() => void loadInitialDay(initialDate)}>{loading ? "Retrying..." : "Retry"}</button>{/if}
      </section>
    {/if}
  </main>
</div>

<script lang="ts" module>
  import type { Task as ModuleTask } from "../shared/types";

  function isDescendantOf(task: ModuleTask, rootId: string, tasks: ModuleTask[]): boolean {
    let parent = task.parent_id;
    while (parent !== null) {
      if (parent === rootId) return true;
      parent = tasks.find((candidate) => candidate.id === parent)?.parent_id ?? null;
    }
    return false;
  }
</script>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; min-width: 0; background: var(--color-surface); }
  :global(button), :global(input), :global(textarea), :global(select) { font: inherit; }
  :global(button), :global(input[type="checkbox"]), :global(select) { min-height: 2rem; }
  :global(button:focus-visible), :global(input:focus-visible), :global(textarea:focus-visible), :global(select:focus-visible) { outline: 0.18rem solid var(--color-focus-ring); outline-offset: 0.12rem; }
  .app-shell { min-height: 100vh; min-height: 100dvh; display: grid; grid-template-columns: minmax(10rem, 14rem) minmax(0, 1fr); color: var(--color-text); background: var(--color-surface); font: 0.94rem/1.45 system-ui, sans-serif; }
  aside { padding: 1.25rem 0.8rem; border-right: 1px solid var(--color-border); background: var(--color-surface-muted); min-width: 0; }
  .brand { display: grid; margin: 0 0.4rem 1.2rem; }
  .brand strong { font: 700 1.15rem/1.2 ui-monospace, monospace; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .today-button, nav button, .search-results button { width: 100%; text-align: left; color: inherit; background: transparent; border: 0; border-radius: 0.45rem; padding: 0.5rem; cursor: pointer; }
  .today-button { display: flex; justify-content: space-between; gap: 0.5rem; margin: 1rem 0; background: var(--color-accent-soft); color: var(--color-accent-strong); font-weight: 700; }
  .today-button span { font: 0.72rem ui-monospace, monospace; align-self: center; }
  .search-label { display: block; color: var(--color-text-muted); font-size: 0.75rem; margin-bottom: 0.25rem; }
  .search, textarea, select { width: 100%; min-width: 0; border: 1px solid var(--color-border); border-radius: 0.4rem; background: var(--color-surface-raised); color: var(--color-text); }
  .search, select { padding: 0.48rem 0.6rem; }
  nav h2 { color: var(--color-text-muted); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; margin: 1rem 0.5rem 0.25rem; }
  nav button.current, nav button:hover, .search-results button:hover { background: var(--color-surface-raised); }
  .search-results { margin-top: 0.6rem; }
  .search-results button { display: grid; }
  .search-results span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .search-results small { color: var(--color-text-muted); }
  main { width: min(100%, 74rem); min-width: 0; padding: clamp(1rem, 0.65rem + 1.5vw, 2rem); }
  .day-header, .section-heading, .note-block > header, .archive article footer, .ai-bar { display: flex; align-items: center; justify-content: space-between; gap: 0.8rem; flex-wrap: wrap; }
  h1, h2, h3, p { margin-top: 0; }
  h1 { margin-bottom: 0; font: 700 clamp(1.7rem, 1.45rem + 1vw, 2.3rem)/1.15 ui-monospace, monospace; }
  h2 { margin-bottom: 0; font-size: 1.2rem; }
  h3 { margin-bottom: 0.2rem; font-size: 1rem; }
  button { border: 1px solid var(--color-accent); border-radius: 0.42rem; padding: 0.42rem 0.7rem; background: var(--color-accent); color: var(--color-accent-contrast); cursor: pointer; }
  button.secondary { color: var(--color-accent-strong); background: transparent; }
  button.text-button { color: var(--color-text-muted); background: transparent; border-color: transparent; }
  button.danger { color: var(--color-danger-text); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .status { min-height: 1.4rem; color: var(--color-text-muted); font-size: 0.78rem; margin: 0.45rem 0; }
  .status.failure { color: var(--color-danger-text); }
  .error { display: flex; justify-content: space-between; align-items: center; gap: 1rem; border: 1px solid var(--color-danger-border); background: var(--color-danger-soft); color: var(--color-danger-text); border-radius: 0.5rem; padding: 0.65rem; margin-bottom: 0.75rem; }
  .workspace-section { margin-top: 1.35rem; }
  .workspace-section + .workspace-section { border-top: 1px solid var(--color-border); padding-top: 1.35rem; }
  .draft { background: var(--color-surface-raised); border: 1px solid var(--color-accent); border-radius: 0.7rem; padding: clamp(0.8rem, 0.6rem + 0.8vw, 1.25rem); margin-top: 1rem; }
  .proposal-inbox { margin-top: 1rem; border: 1px solid var(--color-border); border-radius: 0.7rem; padding: clamp(0.8rem, 0.6rem + 0.8vw, 1.25rem); background: var(--color-surface-raised); }
  .proposal-list { display: grid; gap: 0.65rem; margin-top: 0.8rem; }
  .proposal-card { border: 1px solid var(--color-border); border-radius: 0.5rem; padding: 0.75rem; }
  .proposal-ready { border-color: var(--color-accent); }
  .proposal-refused { background: var(--color-surface-muted); }
  .proposal-card h3 { overflow-wrap: anywhere; }
  .proposal-effects { margin: 0.55rem 0; padding-left: 1.2rem; max-height: 8rem; overflow: auto; }
  .proposal-reason { color: var(--color-text-muted); font-size: 0.8rem; margin: 0.5rem 0; }
  .draft-source { margin: 0.2rem 0 0; color: var(--color-text-muted); font-size: 0.78rem; }
  .startup-state { max-width: 42rem; margin-inline: auto; padding-block: clamp(2rem, 1.5rem + 4vw, 5rem); }
  .section-meta > span { color: var(--color-text-muted); font-size: 0.8rem; }
  .section-meta, .note-header-actions { display: flex; align-items: center; gap: 0.2rem; }
  .note-header-actions { flex-wrap: wrap; justify-content: flex-end; }
  .delete-question { color: var(--color-danger-text); font-size: 0.78rem; font-weight: 700; }
  .icon-button { display: inline-grid; place-items: center; width: 2rem; min-width: 2rem; min-height: 2rem; padding: 0.3rem; color: var(--color-text-muted); background: transparent; border-color: transparent; }
  .icon-button:hover { color: var(--color-accent-strong); background: var(--color-accent-soft); }
  .icon-button.add { color: var(--color-accent-contrast); background: var(--color-accent); border-color: var(--color-accent); }
  .icon-button.danger:hover { color: var(--color-danger-text); background: var(--color-danger-soft); }
  .icon-button svg { width: 1.15rem; height: 1.15rem; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; pointer-events: none; }
  .task-editor { display: grid; grid-template-columns: 1.8rem minmax(0, 1fr); margin-top: 0.65rem; border-block: 1px solid var(--color-border); padding: 0.35rem 0; background: transparent; overflow: hidden; }
  .task-editor:focus-within { border-color: var(--color-border-strong); background: var(--color-surface-raised); box-shadow: inset 0 -0.14rem 0 var(--color-focus-ring); }
  .task-checkboxes { min-width: 0; padding: 0.48rem 0; overflow: visible; z-index: 1; }
  .task-checkbox-line { display: grid; place-items: center; height: 1.6rem; border-radius: 0.3rem; transform: translateX(calc(var(--task-depth) * 2ch)); }
  .search-match { outline: 0.18rem solid var(--color-warning-border); outline-offset: 0.12rem; background: var(--color-warning-soft); }
  .pending-failure { outline: 1px solid var(--color-danger-border); background: var(--color-danger-soft); }
  .task-checkbox-line input[type="checkbox"] { width: 1.5rem; height: 1.5rem; min-height: 1.5rem; margin: 0; }
  .task-checkbox-ghost { width: 1.05rem; height: 1.05rem; border: 1px solid var(--color-border-strong); border-radius: 0.2rem; background: var(--color-surface-raised); opacity: 0.5; pointer-events: none; }
  .archived-task { font-family: ui-monospace, monospace; }
  .task-editor-text { min-height: 2.56rem; overflow-x: auto; overflow-y: hidden; resize: none; border: 0; border-radius: 0; padding: 0.48rem 0.6rem; background: transparent; font: 0.94rem/1.6rem ui-monospace, monospace; white-space: pre; }
  .task-editor-text:focus-visible { outline: none; }
  .task-editor-help { margin: 0.35rem 0 0; color: var(--color-text-muted); font-size: 0.75rem; }
  .archive { border-top: 1px solid var(--color-border); margin-top: 0.8rem; padding-top: 0.6rem; }
  .disclosure { color: var(--color-text); background: transparent; border-color: transparent; font-weight: 700; }
  .disclosure span:last-child { color: var(--color-text-muted); margin-left: 0.3rem; }
  .undo { margin-left: 0.4rem; background: var(--color-warning-soft); color: var(--color-text); border-color: var(--color-border-strong); }
  .archive-list { display: grid; gap: 0.6rem; margin-top: 0.6rem; }
  .archive article { border: 1px solid var(--color-border); border-radius: 0.45rem; padding: 0.65rem; }
  .archived-task { padding-left: min(calc(var(--task-depth) * 1.25rem), 10rem); color: var(--color-text-muted); }
  .archive article footer { margin-top: 0.5rem; }
  time { color: var(--color-text-muted); font-size: 0.78rem; }
  .button-group, .note-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; }
  .notes-list { display: grid; gap: 0.65rem; margin-top: 1rem; }
  .note-block { border: 1px solid var(--color-border); border-radius: 0.5rem; overflow: hidden; }
  .note-block > header { padding: 0.2rem 0.35rem; background: var(--color-surface-muted); flex-wrap: nowrap; }
  .note-header-actions { flex: 0 0 auto; }
  .note-disclosure { display: flex; flex: 1 1 auto; align-items: center; gap: 0.55rem; min-width: 0; min-height: 2.75rem; padding: 0.6rem 0.7rem; color: var(--color-text); background: transparent; border-color: transparent; text-align: left; }
  .note-disclosure .disclosure-icon { flex: 0 0 1rem; font-size: 1.15rem; text-align: center; }
  .note-disclosure span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  textarea { min-height: 11rem; resize: vertical; border: 0; border-radius: 0; padding: 0.8rem; font: 0.9rem/1.55 ui-monospace, monospace; white-space: pre-wrap; }
  textarea:disabled { color: var(--color-text-muted); background: var(--color-surface-muted); }
  .note-actions { justify-content: flex-end; padding: 0.5rem; border-top: 1px solid var(--color-border); }
  .note-actions select { width: auto; max-width: 100%; }
  .note-actions .language { width: min(100%, 12rem); padding: 0.48rem 0.6rem; border: 1px solid var(--color-border); border-radius: 0.4rem; background: var(--color-surface-raised); color: var(--color-text); }
  .ai-tools { margin-top: 1rem; border-top: 1px solid var(--color-border); padding-top: 0.7rem; }
  .ai-tools summary { width: fit-content; color: var(--color-text-muted); cursor: pointer; font-weight: 700; }
  .ai-bar { display: flex; align-items: center; justify-content: space-between; gap: 0.8rem; flex-wrap: wrap; padding-top: 0.7rem; }
  .ai-bar label, fieldset label { display: flex; align-items: center; gap: 0.45rem; }
  pre { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--color-surface-muted); border-radius: 0.45rem; padding: 0.8rem; font: 0.86rem/1.5 ui-monospace, monospace; }
  fieldset { border: 0; padding: 0; margin: 0 0 0.8rem; }
  fieldset label { padding: 0.35rem 0; }
  .comparison { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); gap: 0.8rem; }
  .empty-state { color: var(--color-text-muted); text-align: center; padding: 1rem; margin: 0; }
  :global(.clipboard-source) { position: fixed; inset: 0 auto auto -10000rem; width: 1px; height: 1px; opacity: 0; }

  @media (max-width: 44em) {
    .app-shell { grid-template-columns: 1fr; }
    aside { border-right: 0; border-bottom: 1px solid var(--color-border); padding: 0.75rem; }
    .brand { display: none; }
    .today-button { margin: 0 0 0.6rem; }
    nav { display: flex; overflow-x: auto; gap: 0.25rem; padding-bottom: 0.25rem; }
    nav h2 { display: none; }
    nav button { width: auto; flex: 0 0 auto; }
    main { padding: 0.75rem; }
    .notes-heading { align-items: flex-start; }
    .note-block > header { flex-wrap: wrap; }
    .note-disclosure { flex-basis: 100%; }
    .note-header-actions { width: 100%; justify-content: flex-end; padding: 0 0.35rem 0.35rem; }
    .task-editor { grid-template-columns: 1.65rem minmax(0, 1fr); }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(*) { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
  }
</style>
