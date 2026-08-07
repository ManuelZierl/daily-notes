import type { SurfaceBridge, SurfaceStateEntry } from "./surfaceBridge";

const STATE_KEY = "navigation";
const STATE_VERSION = 1;

export class DailyNotesPresentationState {
  private revision: number | null = null;
  private selectedDate: string | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly host: Pick<SurfaceBridge, "getState" | "putState">) {}

  async restoreSelectedDate(): Promise<string | null> {
    const entry = validateEntry(await this.host.getState(STATE_KEY));
    this.revision = entry.revision;
    this.selectedDate = parseSelectedDate(entry.value);
    return this.selectedDate;
  }

  async persistSelectedDate(selectedDate: string): Promise<void> {
    if (!isLocalDate(selectedDate)) throw new Error("Daily Notes cannot persist an invalid selected date.");
    const operation = this.writes.catch(() => undefined).then(() => this.write(selectedDate));
    this.writes = operation;
    await operation;
  }

  private async write(selectedDate: string): Promise<void> {
    if (this.selectedDate === selectedDate && this.revision !== null) return;
    if (this.revision === null) await this.restoreSelectedDate();
    const value = { version: STATE_VERSION, selected_date: selectedDate };
    try {
      const updated = validateEntry(await this.host.putState(STATE_KEY, this.revision!, value));
      this.revision = updated.revision;
      this.selectedDate = selectedDate;
    } catch (firstError) {
      const current = await this.host.getState(STATE_KEY).then(validateEntry).catch(() => { throw firstError; });
      this.revision = current.revision;
      this.selectedDate = parseSelectedDate(current.value);
      if (this.selectedDate === selectedDate) return;
      const updated = validateEntry(await this.host.putState(STATE_KEY, current.revision, value));
      this.revision = updated.revision;
      this.selectedDate = selectedDate;
    }
  }
}

function parseSelectedDate(value: Record<string, unknown> | null): string | null {
  if (!value || Object.keys(value).sort().join("\0") !== "selected_date\0version") return null;
  return value.version === STATE_VERSION && isLocalDate(value.selected_date) ? value.selected_date : null;
}

function validateEntry(value: unknown): SurfaceStateEntry {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new Error("Kestral returned an invalid Daily Notes state revision.");
  }
  if (value.value !== null && !isRecord(value.value)) {
    throw new Error("Kestral returned an invalid Daily Notes state value.");
  }
  return { revision: value.revision as number, value: value.value as Record<string, unknown> | null };
}

function isLocalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
