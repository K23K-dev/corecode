import type { Exercise } from './exercises';
import {
  MAX_ATTEMPTS_PER_EXERCISE,
  MAX_BACKUP_BYTES,
  PROGRESS_STORAGE_KEY,
  parseProgressBackup,
  type Attempt,
  type ProgressData,
  type ProgressStorage,
} from './progress';

export type Catalog = {
  version: string;
  decks: { id: string; name: string }[];
  exercises: Exercise[];
};
export type StateSnapshot = {
  revision: number;
  progress: ProgressData;
  stars: string[];
  migrations: string[];
  writes: string[];
};
export type ClientView = {
  progress: ProgressData;
  stars: string[];
  status: 'saved' | 'saving' | 'offline' | 'conflict';
  warning: string;
};
type Storage = ProgressStorage & { length: number; key(index: number): string | null };
type StarChange = { value: boolean; at: string; id: string };
type Pending = { progress: ProgressData; stars: Record<string, StarChange> };
type Outbox = Pending & { version: 1; generation: string };
type Dependencies = {
  fetch?: typeof fetch;
  storage?: Storage | null;
  now?: () => string;
  id?: () => string;
  delay?: number;
};
export const OUTBOX_PREFIX = 'coding-practice:pending:postgres:v1:';
export const MIGRATION_KEY = 'coding-practice:migration:postgres:v1';
export const STAR_STORAGE_KEY = 'coding-practice:starred:v1';
const empty = (): ProgressData => ({ version: 1, exercises: {} });
const emptyPending = (): Pending => ({ progress: empty(), stars: {} });
const safeId = (id: unknown): id is string =>
  typeof id === 'string' &&
  id.length > 0 &&
  id.length <= 200 &&
  !['__proto__', 'prototype', 'constructor'].includes(id);
const message = (error: unknown) =>
  (error instanceof Error ? error.message : 'The database request failed.').slice(0, 500);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function stars(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1_000 || !value.every(safeId))
    throw new Error('Invalid saved stars.');
  return [...new Set(value)].sort();
}

export function mergeProgress(
  left: ProgressData,
  right: ProgressData,
  retainAttempts = false,
): ProgressData {
  const result: ProgressData = { version: 1, exercises: { ...left.exercises } };
  for (const [id, incoming] of Object.entries(right.exercises)) {
    const previous = result.exercises[id];
    if (!previous) {
      result.exercises[id] = { ...incoming, attempts: [...incoming.attempts] };
      continue;
    }
    const difference = Date.parse(incoming.updatedAt) - Date.parse(previous.updatedAt);
    const newest =
      difference > 0 || (difference === 0 && incoming.draft > previous.draft) ? incoming : previous;
    const attempts = new Map<string, Attempt>(
      previous.attempts.map((attempt) => [attempt.id, attempt]),
    );
    for (const attempt of incoming.attempts) attempts.set(attempt.id, attempt);
    result.exercises[id] = {
      ...newest,
      solved: previous.solved || incoming.solved,
      attempts: [...attempts.values()].sort(
        (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
      ),
    };
  }
  if (!retainAttempts)
    for (const [id, value] of Object.entries(result.exercises)) {
      result.exercises[id] = {
        ...value,
        attempts: value.attempts.slice(-MAX_ATTEMPTS_PER_EXERCISE),
      };
    }
  return result;
}

function applyStars(base: string[], changes: Pending['stars']): string[] {
  const next = new Set(base);
  for (const [id, change] of Object.entries(changes)) {
    if (change.value) next.add(id);
    else next.delete(id);
  }
  return [...next].sort();
}

function parseState(value: unknown): StateSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid database state.');
  const state = value as StateSnapshot;
  if (!Number.isSafeInteger(state.revision) || state.revision < 0)
    throw new Error('Invalid database revision.');
  return {
    revision: state.revision,
    progress: parseProgressBackup(JSON.stringify(state.progress)),
    stars: stars(state.stars),
    migrations: receipts(state.migrations),
    writes: receipts(state.writes),
  };
}

function receipts(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(safeId)) throw new Error('Invalid database receipt.');
  return value;
}

async function jsonRequest(fetcher: typeof fetch, path: string, init?: RequestInit) {
  const response = await fetcher(path, {
    ...init,
    signal: AbortSignal.timeout(8_000),
    cache: 'no-store',
  });
  if (response.status === 401 || response.status === 403)
    throw new Error(
      'Access to the practice API was denied. Sign in with an account that has access, then reload the page.',
    );
  if (response.status === 404)
    throw new Error(
      'The practice API could not be found (HTTP 404). Check that the backend is included in this deployment.',
    );
  const contentType = response.headers.get('Content-Type')?.split(';')[0].trim() ?? '';
  const isJson = /^application\/(?:[\w.-]+\+)?json$/i.test(contentType);
  const unavailable = `The practice API is unavailable (HTTP ${response.status}). Please retry in a moment.`;
  if (!isJson) {
    if (response.redirected)
      throw new Error(
        'The practice API redirected to another page. Reload the website and sign in if prompted.',
      );
    if (!response.ok) throw new Error(unavailable);
    throw new Error(
      'The practice API did not return JSON data. Check the deployment’s API routing, then retry.',
    );
  }
  const text = await response.text();
  if (text.length > MAX_BACKUP_BYTES * 2)
    throw new Error('The practice API response is too large.');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      response.ok
        ? 'The practice API returned malformed JSON. Please retry in a moment.'
        : unavailable,
    );
  }
  return { response, body };
}

export async function loadCatalog(fetcher: typeof fetch = fetch): Promise<Catalog> {
  const { response, body } = await jsonRequest(fetcher, '/api/catalog');
  if (!response.ok)
    throw new Error('The problem catalog is unavailable. Please retry in a moment.');
  const value = body as Catalog;
  if (
    !value ||
    !Array.isArray(value.decks) ||
    !Array.isArray(value.exercises) ||
    value.decks.length > 100 ||
    value.exercises.length > 1_000
  )
    throw new Error('Invalid problem catalog.');
  const ids = new Set<string>();
  for (const deck of value.decks) {
    if (!safeId(deck.id) || typeof deck.name !== 'string' || !deck.name || ids.has(deck.id))
      throw new Error('Invalid catalog deck.');
    ids.add(deck.id);
  }
  const problems = new Set<string>();
  for (const exercise of value.exercises) {
    if (
      !safeId(exercise.id) ||
      problems.has(exercise.id) ||
      !ids.has(exercise.deckId) ||
      ![
        'title',
        'deck',
        'language',
        'extension',
        'difficulty',
        'prompt',
        'starterCode',
        'referenceCode',
      ].every((key) => typeof exercise[key as keyof Exercise] === 'string') ||
      typeof exercise.version !== 'string' ||
      !/^[a-f0-9]{64}$/.test(exercise.version) ||
      !Array.isArray(exercise.cases) ||
      exercise.cases.length === 0 ||
      exercise.cases.length > 32
    )
      throw new Error('Invalid catalog problem.');
    problems.add(exercise.id);
  }
  return value;
}

/** Owns hydration, recovery, revision merging and acknowledgements, not React. */
export class ProgressClient {
  private readonly fetcher: typeof fetch;
  private readonly storage: Storage | null;
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly key: string;
  private readonly delay: number;
  private base!: StateSnapshot;
  private pending = emptyPending();
  private view!: ClientView;
  private generation = '';
  private recovered = new Map<string, string>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private busy: Promise<void> | null = null;
  private retries = 0;
  private recoveryWarning = '';
  private draftConflict = '';
  private disposed = false;

  private constructor(deps: Dependencies) {
    this.fetcher = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.id = deps.id ?? (() => crypto.randomUUID());
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
    this.key = OUTBOX_PREFIX + this.id();
  }

  static async open(deps: Dependencies = {}): Promise<ProgressClient> {
    const client = new ProgressClient(deps);
    client.base = await client.readState();
    await client.migrate();
    client.recover();
    client.publish(client.dirty ? 'saving' : 'saved');
    if (client.dirty) {
      client.persist();
      client.schedule();
    }
    return client;
  }

  getSnapshot = (): ClientView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private get dirty() {
    return Boolean(
      Object.keys(this.pending.progress.exercises).length || Object.keys(this.pending.stars).length,
    );
  }
  private publish(status: ClientView['status'], warning = '') {
    this.view = {
      progress: mergeProgress(this.base.progress, this.pending.progress),
      stars: applyStars(this.base.stars, this.pending.stars),
      status: status === 'saved' && this.draftConflict ? 'conflict' : status,
      warning: [warning, this.recoveryWarning, this.draftConflict].filter(Boolean).join(' '),
    };
    this.listeners.forEach((listener) => listener());
  }
  private async readState() {
    const { response, body } = await jsonRequest(this.fetcher, '/api/state');
    if (!response.ok) throw new Error('Your progress could not be loaded from the database.');
    return parseState(body);
  }
  private async put(
    progress: ProgressData,
    selected: string[],
    migrationId?: string,
    writeIds: string[] = [],
  ) {
    return jsonRequest(this.fetcher, '/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Code-Practice-Client': '1' },
      body: JSON.stringify({
        expectedRevision: this.base.revision,
        progress,
        stars: selected,
        writeIds,
        ...(migrationId ? { migrationId } : {}),
      }),
    });
  }

  private async migrate() {
    if (!this.storage) {
      this.recoveryWarning =
        'Browser recovery storage is unavailable. Export pending work before closing this tab.';
      return;
    }
    let rawProgress: string | null, rawStars: string | null, marker: { id: string; done?: boolean };
    try {
      const saved = this.storage.getItem(MIGRATION_KEY);
      rawProgress = this.storage.getItem(PROGRESS_STORAGE_KEY);
      rawStars = this.storage.getItem(STAR_STORAGE_KEY);
      if (rawProgress === null && rawStars === null) return;
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify([rawProgress, rawStars])),
      );
      marker = saved
        ? JSON.parse(saved)
        : {
            id:
              'browser-' +
              [...new Uint8Array(digest)]
                .map((value) => value.toString(16).padStart(2, '0'))
                .join(''),
          };
      if (!safeId(marker.id)) throw new Error('Invalid browser migration record.');
      if (marker.done || this.base.migrations.includes(marker.id)) {
        if (!marker.done)
          this.storage.setItem(MIGRATION_KEY, JSON.stringify({ ...marker, done: true }));
        return;
      }
      this.storage.setItem(MIGRATION_KEY, JSON.stringify(marker));
    } catch {
      this.recoveryWarning =
        'Browser migration data could not be read. The original browser backup was left untouched.';
      return;
    }
    let legacy: ProgressData, legacyStars: string[];
    try {
      legacy = rawProgress ? parseProgressBackup(rawProgress, { retainAttempts: true }) : empty();
      legacyStars = rawStars ? stars(JSON.parse(rawStars)) : [];
    } catch {
      this.recoveryWarning =
        'Saved browser progress could not be migrated. The original backup was left untouched; restore a valid backup from My progress.';
      return;
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const { response, body } = await this.put(
        mergeProgress(this.base.progress, legacy, true),
        [...new Set([...this.base.stars, ...legacyStars])],
        marker.id,
      );
      if (response.ok) {
        this.base = parseState(body);
        if (!this.base.migrations.includes(marker.id))
          throw new Error('The database did not confirm browser migration. Retry safely.');
        try {
          this.storage.setItem(MIGRATION_KEY, JSON.stringify({ ...marker, done: true }));
        } catch {
          this.recoveryWarning =
            'Browser migration was saved to the database, but its local receipt could not be cached.';
        }
        return;
      }
      if (response.status === 409 && (body as { code?: string }).code === 'revision_conflict') {
        this.base = parseState(body);
        continue;
      }
      throw new Error(
        'Browser progress could not be migrated to the database. The original backup is still safe; retry.',
      );
    }
    throw new Error('Progress changed in another tab during migration. Retry to merge it safely.');
  }

  private recover() {
    if (!this.storage) return;
    try {
      for (let index = 0; index < this.storage.length; index++) {
        const key = this.storage.key(index);
        if (!key?.startsWith(OUTBOX_PREFIX)) continue;
        try {
          const raw = this.storage.getItem(key);
          if (!raw) continue;
          const value = JSON.parse(raw) as Outbox & { acknowledged?: boolean };
          if (value.acknowledged) continue;
          if (
            value.version !== 1 ||
            !safeId(value.generation) ||
            !value.stars ||
            typeof value.stars !== 'object' ||
            Array.isArray(value.stars)
          )
            throw new Error('Invalid recovery data.');
          const progress = parseProgressBackup(JSON.stringify(value.progress), {
            retainAttempts: true,
          });
          const entries = Object.entries(value.stars);
          if (
            entries.some(
              ([id, change]) =>
                !safeId(id) ||
                !change ||
                typeof change.value !== 'boolean' ||
                !Number.isFinite(Date.parse(change.at)) ||
                !safeId(change.id),
            )
          )
            throw new Error('Invalid pending star.');
          for (const [id, change] of entries) {
            if (this.base.writes.includes(change.id)) continue;
            const previous = this.pending.stars[id];
            if (!previous || change.at + change.id > previous.at + previous.id)
              this.pending.stars[id] = change;
          }
          this.pending.progress = mergeProgress(this.pending.progress, progress, true);
          this.recovered.set(key, raw);
        } catch {
          this.recoveryWarning =
            'Some pending browser work could not be read. Its recovery data was left untouched.';
        }
      }
    } catch {
      this.recoveryWarning =
        'Some pending browser work could not be read. Its recovery data was left untouched.';
    }
  }

  private persist() {
    this.generation = this.id();
    if (!this.storage) {
      this.recoveryWarning =
        'Browser recovery storage is unavailable. Export pending work before closing this tab.';
      return;
    }
    try {
      const raw = JSON.stringify({
        version: 1,
        generation: this.generation,
        ...this.pending,
      } satisfies Outbox);
      if (new TextEncoder().encode(raw).length > MAX_BACKUP_BYTES)
        throw new Error('Recovery data is too large.');
      this.storage.setItem(this.key, raw);
      this.recovered.set(this.key, raw);
    } catch {
      this.recoveryWarning =
        'Pending work could not be cached in this browser. Export a backup before closing the tab.';
    }
  }

  updateProgress(update: (previous: ProgressData) => ProgressData) {
    const before = this.view.progress;
    const next = update(before);
    let changed = false;
    for (const [id, value] of Object.entries(next.exercises)) {
      if (same(value, before.exercises[id])) continue;
      changed = true;
      const priorTime = Date.parse(before.exercises[id]?.updatedAt ?? '') || 0;
      const record = {
        ...value,
        updatedAt: new Date(Math.max(Date.parse(value.updatedAt), priorTime + 1)).toISOString(),
      };
      const merged = mergeProgress(
        this.pending.progress,
        { version: 1, exercises: { [id]: record } },
        true,
      );
      this.pending.progress.exercises[id] = {
        ...record,
        solved: merged.exercises[id].solved,
        attempts: merged.exercises[id].attempts,
      };
    }
    if (changed) this.changed();
  }
  setStar(id: string, value: boolean) {
    if (!safeId(id)) return;
    this.pending.stars[id] = { value, at: this.now(), id: this.id() };
    this.changed();
  }
  restore(progress: ProgressData) {
    const restored = parseProgressBackup(JSON.stringify(progress));
    const at = this.now();
    this.updateProgress((previous) => ({
      version: 1,
      exercises: {
        ...previous.exercises,
        ...Object.fromEntries(
          Object.entries(restored.exercises).map(([id, record]) => [
            id,
            { ...record, updatedAt: at },
          ]),
        ),
      },
    }));
  }
  private changed() {
    this.retries = 0;
    this.draftConflict = '';
    this.persist();
    this.publish('saving');
    this.schedule();
  }
  private schedule(delay = this.delay) {
    clearTimeout(this.timer);
    if (!this.disposed) this.timer = setTimeout(() => void this.flush(), delay);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.busy) return this.busy;
    if (!this.dirty || this.disposed) return Promise.resolve();
    this.busy = this.save().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }
  private async save() {
    const sent: Pending = JSON.parse(JSON.stringify(this.pending));
    const captures = new Map(this.recovered);
    this.publish('saving');
    try {
      for (let conflict = 0; conflict < 4; conflict++) {
        for (const [id, change] of Object.entries(sent.stars)) {
          if (!this.base.writes.includes(change.id)) continue;
          delete sent.stars[id];
          if (this.pending.stars[id]?.id === change.id) delete this.pending.stars[id];
        }
        const merged = mergeProgress(this.base.progress, sent.progress, true);
        const displaced = Object.entries(sent.progress.exercises).filter(
          ([id, record]) => merged.exercises[id].draft !== record.draft,
        );
        const { response, body } = await this.put(
          merged,
          applyStars(this.base.stars, sent.stars),
          undefined,
          Object.values(sent.stars).map((change) => change.id),
        );
        if (response.status === 409 && (body as { code?: string }).code === 'revision_conflict') {
          this.base = parseState(body);
          continue;
        }
        if (!response.ok)
          throw new Error(
            (body as { code?: string }).code === 'submission_conflict'
              ? 'A saved submission conflicts with the database. Export a backup before retrying.'
              : 'Changes are not saved to the database. They remain pending in this browser.',
          );
        this.base = parseState(body);
        if (displaced.length) {
          this.draftConflict =
            'A newer database draft was kept for ' +
            displaced.map(([id]) => id).join(', ') +
            '. This tab’s older draft was not saved.';
          try {
            this.storage?.setItem(
              'coding-practice:conflict:postgres:v1:' + this.generation,
              JSON.stringify({ version: 1, exercises: Object.fromEntries(displaced) }),
            );
          } catch {
            this.recoveryWarning =
              'The older draft recovery copy could not be written to browser storage.';
          }
        }
        for (const [id, value] of Object.entries(sent.progress.exercises))
          if (same(this.pending.progress.exercises[id], value))
            delete this.pending.progress.exercises[id];
        for (const [id, value] of Object.entries(sent.stars))
          if (same(this.pending.stars[id], value)) delete this.pending.stars[id];
        for (const [key, raw] of captures) {
          try {
            if (this.storage?.getItem(key) === raw)
              this.storage.setItem(
                key,
                JSON.stringify({
                  ...JSON.parse(raw),
                  acknowledged: true,
                  acknowledgedRevision: this.base.revision,
                }),
              );
          } catch {
            this.recoveryWarning =
              'Changes are saved, but the browser recovery receipt could not be updated.';
          }
          if (this.recovered.get(key) === raw) this.recovered.delete(key);
        }
        this.retries = 0;
        if (this.dirty) {
          this.persist();
          this.publish('saving');
          this.schedule();
        } else this.publish('saved');
        return;
      }
      throw new Error(
        'Progress keeps changing in another tab. Your work remains pending; retry shortly.',
      );
    } catch (error) {
      this.publish('offline', message(error));
      if (this.retries < 3) this.schedule([1_000, 3_000, 10_000][this.retries++]);
    }
  }

  async refresh() {
    if (this.disposed || this.busy) return;
    try {
      const latest = await this.readState();
      if (this.disposed || this.busy || latest.revision < this.base.revision) return;
      this.base = latest;
      const receipt = this.storage?.getItem(this.key);
      if (receipt) {
        const value = JSON.parse(receipt) as {
          acknowledged?: boolean;
          generation?: string;
          acknowledgedRevision?: number;
        };
        if (
          value.acknowledged &&
          value.generation === this.generation &&
          typeof value.acknowledgedRevision === 'number' &&
          value.acknowledgedRevision <= this.base.revision
        )
          this.pending = emptyPending();
      }
      this.publish(this.dirty ? 'saving' : 'saved');
      if (this.dirty) this.schedule();
    } catch (error) {
      this.publish('offline', message(error));
    }
  }
  retry = () => {
    this.retries = 0;
    if (this.dirty) void this.flush();
    else void this.refresh();
  };
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}
