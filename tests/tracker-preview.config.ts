// Disposable UI preview: no database, credentials, catalog copy, or code execution.
import { createHash } from 'node:crypto';
import { defineConfig, type UserConfig } from 'vite';
import baseConfig from '../vite.config.ts';
import { fixtureDecks, fixtureExercises } from './database-fixtures.ts';
import { practiceClock, summarizeActivity } from '../shared/practice-activity.mjs';
import type { StateSnapshot } from '../src/lib/database-client.ts';
// Validation only; the disposable preview never constructs a database connection.
const { validateStateUpdate } = await import(
  new URL('../server/validation.mjs', import.meta.url).href
);

const base = baseConfig as UserConfig;
const started = Date.now();
const baseline = Date.parse('2026-09-11T22:00:00Z');
const days = [
  ...[15, 16, 17, 18, 19, 22, 23, 24, 25, 26].map((day) => `2026-08-${day}`),
  ...[1, 2, 3, 4, 5, 7, 8, 10].map((day) => `2026-09-${String(day).padStart(2, '0')}`),
].map((date) => ({ date, count: 1 }));
const repairs = ['2026-09-09'];
let state: StateSnapshot = {
  revision: 0,
  progress: { version: 1, exercises: {} },
  stars: [],
  migrations: [],
  writes: [],
};
const catalog = {
  version: 'a'.repeat(64),
  decks: fixtureDecks,
  exercises: fixtureExercises.map((exercise) => ({
    ...exercise,
    version: createHash('sha256').update(JSON.stringify(exercise)).digest('hex'),
  })),
};

function snapshot() {
  const now = new Date(baseline + Date.now() - started);
  const clock = practiceClock(now);
  return {
    timeZone: 'America/New_York',
    resetHour: 20,
    ...clock,
    serverNow: now.toISOString(),
    days,
    repairs: [...repairs].sort(),
    streak: summarizeActivity(days, repairs, clock.today),
  };
}

export default defineConfig({
  ...base,
  envDir: false,
  server: { ...base.server, port: 5176, proxy: undefined },
  plugins: [
    ...(base.plugins ?? []),
    {
      name: 'disposable-tracker-preview',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = new URL(request.url ?? '/', 'http://127.0.0.1:5176').pathname;
          if (!path.startsWith('/api/')) return next();
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          const send = (value: unknown, status = 200) => {
            response.statusCode = status;
            response.end(JSON.stringify(value));
          };
          if (request.method === 'GET' && path === '/api/catalog') return send(catalog);
          if (request.method === 'GET' && path === '/api/state') {
            return send(state);
          }
          if (request.method === 'PUT' && path === '/api/state') {
            let body = '';
            request.on('data', (chunk) => {
              body += chunk;
            });
            request.on('end', () => {
              try {
                const update = validateStateUpdate(JSON.parse(body));
                if (
                  update.expectedRevision !== state.revision ||
                  update.writeIds.some((id: string) => state.writes.includes(id))
                ) {
                  return send({ ...state, code: 'revision_conflict' }, 409);
                }
                state = {
                  ...state,
                  revision: state.revision + 1,
                  progress: update.progress,
                  stars: update.stars,
                  writes: [...state.writes, ...update.writeIds],
                };
                send(state);
              } catch {
                send({ error: 'Invalid preview progress.' }, 400);
              }
            });
            return;
          }
          if (request.method === 'GET' && path === '/api/activity') return send(snapshot());
          if (request.method === 'POST' && path === '/api/activity/repairs') {
            let body = '';
            request.on('data', (chunk) => {
              body += chunk;
            });
            request.on('end', () => {
              let date;
              try {
                date = JSON.parse(body).date;
              } catch {
                return send({ error: 'Invalid date' }, 400);
              }
              const current = snapshot();
              if (repairs.includes(date)) return send(current);
              if (!current.streak.hearts) return send({ code: 'insufficient_hearts' }, 409);
              if (
                typeof date !== 'string' ||
                date >= current.today ||
                date < current.streak.startedOn! ||
                days.some((day) => day.date === date)
              ) {
                return send({ error: 'Not a missed day' }, 400);
              }
              repairs.push(date);
              send(snapshot());
            });
            return;
          }
          send({ error: 'Disabled in disposable tracker preview.' }, 405);
        });
      },
    },
  ],
});
