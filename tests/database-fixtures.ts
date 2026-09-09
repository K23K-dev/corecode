import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { assertTestConnection } from './e2e/database-runtime.mjs';

const { stableJson } = (await import(
  new URL('../server/validation.mjs', import.meta.url).href
)) as {
  stableJson(value: unknown): string;
};

export const fixtureDecks = [
  { id: 'python', name: 'Python' },
  { id: 'algorithms', name: 'Algorithms' },
];

// Two synthetic records exercise persistence; they are not a copy of the website catalog.
export const fixtureExercises = [
  {
    id: 'python-core-normalize-text-01',
    title: 'Fixture identity',
    deckId: 'python',
    deck: 'Python',
    language: 'Python',
    extension: 'py',
    difficulty: 'Easy',
    prompt: 'Return the supplied value.',
    starterCode: 'class Solution:\n    def answer(self, value): pass',
    referenceCode: 'class Solution:\n    def answer(self, value): return value',
    runtime: 'browser-python',
    entryPoint: 'answer',
    cases: [{ name: 'Identity', args: '(1,)', expected: '1' }],
  },
  {
    id: 'algo-search-001-binary-search',
    title: 'Fixture native identity',
    deckId: 'algorithms',
    deck: 'Algorithms',
    language: 'Python',
    extension: 'py',
    difficulty: 'Easy',
    prompt: 'Return the supplied value.',
    starterCode: 'class Solution:\n    def answer(self, value): pass',
    referenceCode: 'class Solution:\n    def answer(self, value): return value',
    runtime: 'python',
    entryPoint: 'answer',
    cases: [{ name: 'Identity', args: '(1,)', expected: '1' }],
  },
];

function digest(value: unknown) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

/** Deliberate test-only catalog edits; the production initializer never authors content. */
export async function applyFixtureCatalog(
  client: Client,
  connectionString: string,
  source = { decks: fixtureDecks, exercises: fixtureExercises },
) {
  const schema = await assertTestConnection(client, connectionString);
  await client.query('BEGIN');
  try {
    await assertTestConnection(client, connectionString);
    await client.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 739175)');
    await client.query(`UPDATE ${schema}.cp_decks SET active = false`);
    for (const [position, deck] of source.decks.entries()) {
      await client.query(
        `INSERT INTO ${schema}.cp_decks(id, content, position, active) VALUES($1, $2::jsonb, $3, true)
        ON CONFLICT(id) DO UPDATE SET content = EXCLUDED.content, position = EXCLUDED.position, active = true`,
        [deck.id, JSON.stringify(deck), position],
      );
    }
    await client.query(`UPDATE ${schema}.cp_problems SET active = false`);
    for (const [position, content] of source.exercises.entries()) {
      const version = digest(content);
      const spec = { runtime: 'python', entryPoint: content.entryPoint, cases: content.cases };
      await client.query(
        `INSERT INTO ${schema}.cp_problem_versions(exercise_id, version, content) VALUES($1, $2, $3::jsonb)
        ON CONFLICT(exercise_id, version) DO NOTHING`,
        [content.id, version, JSON.stringify({ ...content, version })],
      );
      await client.query(
        `INSERT INTO ${schema}.cp_grading_specs(exercise_id, problem_version, spec_version, content) VALUES($1, $2, $3, $4::jsonb)
        ON CONFLICT(exercise_id, problem_version) DO NOTHING`,
        [content.id, version, digest(spec), JSON.stringify(spec)],
      );
      await client.query(
        `INSERT INTO ${schema}.cp_problems(id, current_version, position, active) VALUES($1, $2, $3, true)
        ON CONFLICT(id) DO UPDATE SET current_version = EXCLUDED.current_version, position = EXCLUDED.position, active = true`,
        [content.id, version, position],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
