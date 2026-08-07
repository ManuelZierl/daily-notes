export interface DailyEntry {
  id: string;
  local_date: string;
  title: string;
  created_at: string;
}

export interface Task {
  id: string;
  parent_id: string | null;
  text: string;
  checked: boolean;
  order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
}

export interface NoteBlock {
  id: string;
  daily_entry_id: string;
  content: string;
  order: number;
  collapsed: boolean;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  version: 1;
  entries: DailyEntry[];
  tasks: Task[];
  notes: NoteBlock[];
}

export interface CreateTaskResult {
  workspace: Workspace;
  created_id: string;
}

export interface ParsedTaskLine {
  text: string;
  checked: boolean;
  depth: number;
}
