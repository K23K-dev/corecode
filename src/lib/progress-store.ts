import {
  applyProgressChanges,
  noChanges,
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

const SAVE_DELAY = 250;
const RETRY_DELAYS = [1000, 3000, 10000];
const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The database request failed.';

// Autosaves drafts and stars. Changes wait in memory until the server confirms them.
export class ProgressStore {
  // The latest server state; the view shows pending changes on top of it.
  private saved!: ProgressState;
  private pending = noChanges();
  private view!: ProgressView;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private failures = 0;
  private disposed = false;

  private constructor() {}
  static async open(): Promise<ProgressStore> {
    const store = new ProgressStore();
    store.saved = await store.readState();
    store.publish();
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
      failure: 'Your progress could not be loaded.',
    });
    return ProgressStateSchema.parse(value);
  }

  setDraft(id: string, code: string) {
    const previous = this.view.progress.exercises[id];
    if (previous?.draft === code) return;
    // Stay newer than the draft on screen, even when this device's clock is behind.
    const at = new Date(
      Math.max(Date.now(), Date.parse(previous?.updatedAt ?? '') + 1 || 0),
    ).toISOString();
    this.pending.drafts[id] = { at, value: code };
    this.changed();
  }
  setStar(id: string, starred: boolean) {
    this.pending.stars[id] = starred;
    this.changed();
  }
  // Show a new change right away, then save it shortly.
  private changed() {
    this.failures = 0;
    this.publish();
    this.schedule(SAVE_DELAY);
  }
  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (!this.disposed) this.timer = setTimeout(() => void this.flush(), delay);
  }

  // Save pending changes now. One save runs at a time; later edits wait for the next.
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
    };
    try {
      const { value } = await requestJson('/api/state', {
        method: 'PUT',
        body: sent,
        failure: 'Changes are not saved yet. Keep this tab open while it retries.',
      });
      const latest = ProgressStateSchema.parse(value);
      if (latest.revision >= this.saved.revision) this.saved = latest;
      // Keep only the changes made while this save was in flight.
      for (const kind of ['drafts', 'stars'] as const)
        for (const [id, change] of Object.entries(sent[kind]))
          if (this.pending[kind][id] === change) delete this.pending[kind][id];
      this.failures = 0;
      this.publish();
      if (this.dirty) this.schedule(SAVE_DELAY);
    } catch (error) {
      this.publish(message(error));
      if (this.failures < RETRY_DELAYS.length) this.schedule(RETRY_DELAYS[this.failures++]);
    }
  }

  // Load the latest server state, then retry anything still unsaved.
  async refresh(): Promise<void> {
    if (this.disposed) return;
    try {
      const latest = await this.readState();
      if (this.disposed) return;
      if (latest.revision >= this.saved.revision) this.saved = latest;
      this.publish();
      if (this.dirty) this.schedule(SAVE_DELAY);
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
