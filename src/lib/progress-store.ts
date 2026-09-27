import {
  applyProgressChanges,
  noChanges,
  ProgressChangesSchema,
  ProgressStateSchema,
  type ProgressChanges,
  type ProgressData,
  type ProgressState,
} from '../schemas/progress';
import { requestJson } from './api';

type ProgressView = {
  progress: ProgressData;
  stars: string[];
  status: 'saved' | 'saving' | 'offline';
  warning: string;
};
type BackupStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Dependencies = {
  fetch?: typeof fetch;
  storage?: BackupStorage | null;
  now?: () => string;
  delay?: number;
};

// A copy of unsaved changes, so closing the tab or a crash before saving loses nothing.
const BACKUP_KEY = 'coding-practice:unsaved-changes';
const RETRY_DELAYS = [1000, 3000, 10000];
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The database request failed.';

/**
 * Autosaves drafts, stars, and completion checkmarks. Changes wait in memory and in
 * a browser backup until the server confirms them; the judge owns submission history.
 */
export class ProgressStore {
  private readonly fetcher: typeof fetch;
  private readonly storage: BackupStorage | null;
  private readonly now: () => string;
  private readonly delay: number;
  /** The latest server state; the view shows pending changes on top of it. */
  private saved!: ProgressState;
  private pending = noChanges();
  /** What this tab last wrote to the backup key. */
  private backup: string | null = null;
  private view!: ProgressView;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private failures = 0;
  private disposed = false;

  private constructor(deps: Dependencies) {
    this.fetcher = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.delay = deps.delay ?? 250;
    let storage = deps.storage;
    if (storage === undefined) {
      try {
        storage = localStorage;
      } catch {
        storage = null;
      }
    }
    this.storage = storage;
  }
  static async open(deps: Dependencies = {}): Promise<ProgressStore> {
    const store = new ProgressStore(deps);
    store.saved = await store.readState();
    store.restoreBackup();
    store.publish();
    if (store.dirty) store.schedule(store.delay);
    return store;
  }
  getSnapshot = (): ProgressView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private get dirty() {
    return Object.values(this.pending).some((changes) => Object.keys(changes).length > 0);
  }
  private publish(warning = '') {
    this.view = {
      ...applyProgressChanges(this.saved, this.pending),
      status: warning ? 'offline' : this.dirty ? 'saving' : 'saved',
      warning,
    };
    this.listeners.forEach((listener) => listener());
  }
  private async readState() {
    const { value } = await requestJson('/api/state', {
      fetch: this.fetcher,
      failure: 'Your progress could not be loaded.',
    });
    return ProgressStateSchema.parse(value);
  }

  /** Resume changes an earlier page left unsaved. An unreadable backup is ignored. */
  private restoreBackup() {
    try {
      const raw = this.storage?.getItem(BACKUP_KEY);
      const backup = raw ? ProgressChangesSchema.safeParse(JSON.parse(raw)) : undefined;
      if (backup?.success) this.pending = backup.data;
      // Rewrite the backup so this tab owns it and can clear it once everything is saved.
      this.writeBackup();
    } catch {
      // Storage can be unavailable; the saved server copy still loads.
    }
  }
  /** Mirror unsaved changes to the backup, and clear it once everything is saved. */
  private writeBackup() {
    try {
      if (this.dirty) {
        const raw = JSON.stringify(this.pending);
        this.storage?.setItem(BACKUP_KEY, raw);
        this.backup = raw;
      } else if (this.backup !== null) {
        // Another tab may have replaced the backup with its own unsaved changes.
        if (this.storage?.getItem(BACKUP_KEY) === this.backup) this.storage.removeItem(BACKUP_KEY);
        this.backup = null;
      }
    } catch {
      // Storage can be full or disabled; changes still save from memory.
    }
  }

  setDraft(id: string, code: string) {
    const previous = this.view.progress.exercises[id];
    if (previous?.draft === code) return;
    // Stay newer than the draft on screen, even when this device's clock is behind.
    const at = new Date(
      Math.max(Date.parse(this.now()), Date.parse(previous?.updatedAt ?? '') + 1 || 0),
    ).toISOString();
    this.pending.drafts[id] = { at, value: code };
    this.changed();
  }
  setStar(id: string, starred: boolean) {
    this.pending.stars[id] = starred;
    this.changed();
  }
  setSolved(id: string, solved: boolean, starterCode: string) {
    // A checkmark needs a saved entry, so start one from the starter code.
    if (!this.view.progress.exercises[id]) this.setDraft(id, starterCode);
    this.pending.solved[id] = solved;
    this.changed();
  }
  /** Back up and show a new change, then save it shortly. */
  private changed() {
    this.failures = 0;
    this.writeBackup();
    this.publish();
    this.schedule(this.delay);
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (!this.disposed) this.timer = setTimeout(() => void this.flush(), delay);
  }

  /** Save pending changes now. One save runs at a time; later edits wait for the next. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.saving) return this.saving;
    if (!this.dirty || this.disposed) return Promise.resolve();
    this.saving = this.save().finally(() => {
      this.saving = null;
    });
    return this.saving;
  }
  private async save() {
    const sent: ProgressChanges = {
      drafts: { ...this.pending.drafts },
      stars: { ...this.pending.stars },
      solved: { ...this.pending.solved },
    };
    try {
      const { value } = await requestJson('/api/state', {
        method: 'PUT',
        body: sent,
        fetch: this.fetcher,
        failure: 'Changes are not saved. They remain pending in this browser.',
      });
      const latest = ProgressStateSchema.parse(value);
      if (latest.revision >= this.saved.revision) this.saved = latest;
      // Keep only the changes made while this save was in flight.
      for (const kind of ['drafts', 'stars', 'solved'] as const)
        for (const [id, change] of Object.entries(sent[kind]))
          if (this.pending[kind][id] === change) delete this.pending[kind][id];
      this.failures = 0;
      this.writeBackup();
      this.publish();
      if (this.dirty) this.schedule(this.delay);
    } catch (error) {
      this.publish(message(error));
      if (this.failures < RETRY_DELAYS.length) this.schedule(RETRY_DELAYS[this.failures++]);
    }
  }

  /** Load the latest server state, then retry anything still unsaved. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    try {
      const latest = await this.readState();
      if (this.disposed) return;
      if (latest.revision >= this.saved.revision) this.saved = latest;
      this.publish();
      if (this.dirty) this.schedule(this.delay);
    } catch (error) {
      if (!this.disposed) this.publish(message(error));
    }
  }
  retry = (): Promise<void> => {
    this.failures = 0;
    return this.dirty ? this.flush() : this.refresh();
  };
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
