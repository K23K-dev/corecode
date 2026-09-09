import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Catalog } from '../src/lib/database-client';
import type { Exercise } from '../src/lib/exercises';
import type { TestCase } from '../src/lib/runner';

type WebsiteProblem = Exercise & {
  graderVersion: string;
  cases: TestCase[];
  topic: string;
  requirements: string[];
  examples: { input: string; output: string }[];
  explanation: string;
};
// Opt in before loading private settings: ordinary unit tests stay entirely offline.
const verifyNeonCatalog = process.env.VERIFY_NEON_CATALOG === '1';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const expectedStudyDecks = [
  'Python',
  'NumPy',
  'Pandas',
  'Data Structures',
  'Algorithms',
  'SQL',
  'Linux',
  'Frontend',
  'Backend',
  'Machine Learning',
  'Deep Learning',
  'LLM',
  'LLM Applications',
  'Low Level Design',
];
const expectedDeckCounts = [46, 39, 42, 24, 25, 29, 32, 30, 17, 20, 14, 16, 8, 17];
const expectedRuntimeCounts = {
  'browser-python': 15,
  python: 236,
  sql: 29,
  shell: 32,
  javascript: 47,
};

const expectedReadyCaseCounts = {
  'python-core-normalize-text-01': 8,
  'python-core-split-words-01': 8,
  'python-core-keep-alphanumeric-01': 8,
  'python-core-resolve-limit-01': 9,
  'python-core-is-allowed-01': 9,
  'python-core-count-occurrences-01': 8,
  'python-core-reversed-copy-01': 8,
  'python-core-append-extend-01': 8,
  'python-core-flatten-grid-01': 8,
  'python-core-make-zero-grid-01': 8,
  'python-core-lookup-or-default-01': 10,
  'python-core-frequency-map-01': 8,
  'python-core-unique-in-order-01': 8,
  'python-core-sort-words-01': 8,
  'python-core-pairwise-sums-01': 9,
};

const expectedSignatures: Record<string, string> = {
  'python-core-normalize-text-01': 'def normalize_text(text):',
  'python-core-split-words-01': 'def split_words(text):',
  'python-core-keep-alphanumeric-01': 'def keep_alphanumeric(text):',
  'python-core-resolve-limit-01': 'def resolve_limit(limit, default):',
  'python-core-is-allowed-01': 'def is_allowed(value, low, high, blocked):',
  'python-core-count-occurrences-01': 'def count_occurrences(values, target):',
  'python-core-reversed-copy-01': 'def reversed_copy(values):',
  'python-core-append-extend-01': 'def append_and_extend(values, item, extras):',
  'python-core-flatten-grid-01': 'def flatten_grid(grid):',
  'python-core-make-zero-grid-01': 'def make_zero_grid(rows, columns):',
  'python-core-lookup-or-default-01': 'def lookup_or_default(mapping, key, default):',
  'python-core-frequency-map-01': 'def frequency_map(values):',
  'python-core-unique-in-order-01': 'def unique_in_order(values):',
  'python-core-sort-words-01': 'def sort_words(words):',
  'python-core-pairwise-sums-01': 'def pairwise_sums(left, right):',
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(entry.name) ? [path] : [];
  });
}

function exampleCall(entryPoint: string, args: string): string {
  return `${entryPoint}(${args.slice(1, -1).replace(/,\s*$/, '')})`;
}

describe('offline catalog architecture', () => {
  it('never loads a local catalog or runs Anki conversion during application startup', () => {
    const paths = [
      ...sourceFiles(join(projectRoot, 'src')),
      ...sourceFiles(join(projectRoot, 'server')),
      join(projectRoot, 'vite.config.ts'),
    ];
    for (const path of paths) {
      const source = readFileSync(path, 'utf8');
      // A deny-list entry is not a dependency: Vite may block historical snapshots.
      expect(source, path).not.toMatch(
        /(?:from\s*|(?:import|require|fetch|readFile|readFileSync)\s*\(\s*|new URL\(\s*)['"][^'"]*(?:data[\\/](?:ready-exercises|exercises|decks)\.json|generated[\\/]catalog\.json)/i,
      );
      expect(source, path).not.toMatch(/build-catalog|prepare-catalog|export_anki|ankiconnect/i);
      expect(source, path).not.toMatch(
        /(?:from\s+|(?:import|require|fetch)\s*\(?\s*)['"][^'"]*anki/i,
      );
    }
    const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const script of ['dev', 'start', 'build', 'predev', 'prestart', 'prebuild']) {
      expect(packageJson.scripts[script] ?? '').not.toMatch(
        /anki|(?:build|prepare)-catalog|export_anki|\brun catalog\b/i,
      );
    }
  });

  it('keeps the exercise module type-only, without a bundled catalog fallback', () => {
    const source = readFileSync(join(projectRoot, 'src/lib/exercises.ts'), 'utf8');
    expect(source).not.toMatch(/\.json['"]|\b(?:readFile|readFileSync|fetch|require)\s*\(/);
    expect(source).not.toMatch(/\bexport\s+(?:const|let|var|function|class)\b/);
  });
});

describe.skipIf(!verifyNeonCatalog)('read-only Neon catalog contracts', () => {
  let readyData: WebsiteProblem[];
  let readyById: Map<string, WebsiteProblem>;
  let decks: Catalog['decks'];
  let curatedData: WebsiteProblem[];

  beforeAll(async () => {
    const { loadTestEnvironment } = await import('./e2e/database-runtime.mjs');
    const { readCatalogSnapshot } = await import('./grading-data.mjs');
    loadTestEnvironment();
    const catalog = await readCatalogSnapshot();
    readyData = catalog.exercises as WebsiteProblem[];
    readyById = new Map(readyData.map((exercise) => [exercise.id, exercise]));
    decks = catalog.decks;
    curatedData = Object.keys(expectedReadyCaseCounts).map((id) => readyById.get(id)!);
  }, 60_000);

  describe('complete reviewed exercise library', () => {
    it('uses all 359 prepared website records in catalog order with stable unique IDs', () => {
      expect(readyData).toHaveLength(359);
      expect(readyById.size).toBe(readyData.length);
      for (const exercise of readyData) {
        expect(exercise.id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
        expect(['__proto__', 'prototype', 'constructor']).not.toContain(exercise.id);
        expect(exercise.version, exercise.id).toMatch(/^[a-f0-9]{64}$/);
      }
    });

    it('keeps source ordinals and abbreviations out of displayed problem titles', () => {
      expect(readyData.filter((item) => /^(?:ds|algo)-/.test(item.id))).toHaveLength(49);
      expect(
        readyData.filter(
          (item) => /\b0\d+\b/.test(item.title) || /^(?:Ds|Algo)\b/.test(item.title),
        ),
      ).toEqual([]);
    });

    it('preserves meaningful numbers in scientific problem titles', () => {
      expect(readyData.filter((item) => /\d/.test(item.title)).map((item) => item.title)).toEqual([
        'Best F1 threshold',
        'Batch Norm1d',
        'Conv2d single channel',
        'Max pool2d',
      ]);
    });

    it('keeps all 14 study decks and their actual problem counts runnable', () => {
      const deckNames = decks.map((deck) => deck.name);
      expect(deckNames).toEqual(expectedStudyDecks);
      expect(new Set(deckNames).size).toBe(14);
      expect(new Set(decks.map((deck) => deck.id)).size).toBe(14);
      expect(decks.every((deck) => /^[a-z]+(?:-[a-z]+)*$/.test(deck.id))).toBe(true);
      expect(
        deckNames.map((deck) => readyData.filter((exercise) => exercise.deck === deck).length),
      ).toEqual(expectedDeckCounts);
      expect(
        readyData.every((exercise) =>
          decks.some((deck) => deck.id === exercise.deckId && deck.name === exercise.deck),
        ),
      ).toBe(true);
      expect(
        Object.fromEntries(
          Object.keys(expectedRuntimeCounts).map((runtime) => [
            runtime,
            readyData.filter((exercise) => exercise.runtime === runtime).length,
          ]),
        ),
      ).toEqual(expectedRuntimeCounts);
    });

    it('provides bounded behavioral metadata without leaking server-side grading code', () => {
      for (const exercise of readyData) {
        expect(Object.keys(expectedRuntimeCounts), exercise.id).toContain(exercise.runtime);
        expect(exercise.graderVersion, exercise.id).toMatch(/^[a-f0-9]{64}$/);
        expect(exercise, exercise.id).not.toHaveProperty('gradingSpec');
        expect(exercise, exercise.id).not.toHaveProperty('specVersion');
        for (const field of ['title', 'prompt', 'referenceCode', 'explanation'] as const) {
          expect(exercise[field].trim().length, `${exercise.id}: ${field}`).toBeGreaterThan(0);
        }
        expect(exercise.starterCode.length, exercise.id).toBeLessThanOrEqual(32_768);
        expect(exercise.referenceCode.length, exercise.id).toBeLessThanOrEqual(32_768);
        expect(exercise.cases.length, exercise.id).toBeGreaterThanOrEqual(2);
        expect(exercise.cases.length, exercise.id).toBeLessThanOrEqual(32);
        expect(new Set(exercise.cases.map((test) => test.name)).size, exercise.id).toBe(
          exercise.cases.length,
        );
        expect(Array.isArray(exercise.requirements), exercise.id).toBe(true);
        expect(exercise.examples.length, exercise.id).toBeGreaterThanOrEqual(1);
        for (const test of exercise.cases) {
          expect(
            Object.keys(test).every((key) => ['name', 'args', 'expected', 'check'].includes(key)),
            exercise.id,
          ).toBe(true);
          for (const field of ['name', 'args', 'expected'] as const)
            expect(typeof test[field], exercise.id).toBe('string');
          expect(test.name.length, exercise.id).toBeLessThanOrEqual(80);
          expect(test.args.length, exercise.id).toBeLessThanOrEqual(8_192);
          expect(test.expected.length, exercise.id).toBeLessThanOrEqual(8_192);
        }
        for (const alternative of exercise.solutionAlternatives ?? []) {
          expect(alternative.title.trim(), exercise.id).not.toBe('');
          expect(alternative.explanation.trim(), exercise.id).not.toBe('');
          expect(alternative.code.trim(), exercise.id).not.toBe('');
        }
      }
    });

    it('routes scientific Python, shell, SQL, and web problems to the correct fixed runtime', () => {
      for (const exercise of readyData) {
        const expected =
          exercise.deckId === 'sql'
            ? 'sql'
            : exercise.deckId === 'linux'
              ? 'shell'
              : ['frontend', 'backend'].includes(exercise.deckId)
                ? 'javascript'
                : Object.hasOwn(expectedReadyCaseCounts, exercise.id)
                  ? 'browser-python'
                  : 'python';
        expect(exercise.runtime, exercise.id).toBe(expected);
        if (expected === 'python' || expected === 'browser-python') {
          expect(exercise.language, exercise.id).toBe('Python');
          expect(exercise.extension, exercise.id).toBe('py');
        }
        if (exercise.supportsCustomInput) {
          expect(['python', 'browser-python'], exercise.id).toContain(exercise.runtime);
          expect(exercise.entryPoint, exercise.id).toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
          expect(typeof exercise.customInput, exercise.id).toBe('string');
        }
      }
    });

    it('wraps the 202 Python function exercises while preserving domain-class exercises', () => {
      const python = readyData.filter((exercise) => exercise.language === 'Python');
      const wrapped = python.filter((exercise) => /^class Solution:/m.test(exercise.starterCode));
      expect(python).toHaveLength(251);
      expect(wrapped).toHaveLength(202);
      for (const exercise of wrapped) {
        expect(exercise.referenceCode, exercise.id).toMatch(/^class Solution:/m);
        expect(exercise.starterCode, exercise.id).toMatch(/^    def \w+\(self(?:,|\))/m);
        for (const alternative of exercise.solutionAlternatives ?? [])
          expect(alternative.code, exercise.id).toMatch(/^class Solution:/m);
      }
      expect(readyById.get('ds-stack-001-complete')!.starterCode).toContain('class Stack:');
      expect(readyById.get('ds-stack-001-complete')!.starterCode).not.toContain('class Solution:');
      expect(readyById.get('algo-tree-001-preorder')!.starterCode).toContain('class TreeNode:');
      expect(readyById.get('algo-tree-001-preorder')!.starterCode).toContain('class Solution:');
      expect(readyById.get('algo-sort-004-merge-sort')!.referenceCode).toContain(
        'self.merge_sort(values[:middle])',
      );
      expect(readyById.get('ml-practice-002')!.referenceCode).toMatch(
        /^def pairwise_euclidean_distances\(/m,
      );
    });
  });

  describe('authored first-version exercise contract', () => {
    it('has the documented 15 exercises, difficulty split, and 125 grading cases', () => {
      expect(curatedData.every(Boolean)).toBe(true);
      expect(curatedData.map((exercise) => exercise.id)).toEqual(
        Object.keys(expectedReadyCaseCounts),
      );
      expect(
        readyData
          .filter((exercise) => exercise.runtime === 'browser-python')
          .map((exercise) => exercise.id)
          .sort(),
      ).toEqual(Object.keys(expectedReadyCaseCounts).sort());
      expect(
        Object.fromEntries(curatedData.map((exercise) => [exercise.id, exercise.cases.length])),
      ).toEqual(expectedReadyCaseCounts);
      expect(curatedData.filter((exercise) => exercise.difficulty === 'Easy')).toHaveLength(12);
      expect(curatedData.filter((exercise) => exercise.difficulty === 'Medium')).toHaveLength(3);
      expect(curatedData.reduce((total, exercise) => total + exercise.cases.length, 0)).toBe(125);
    });

    for (const id of Object.keys(expectedReadyCaseCounts)) {
      it(`${id}: supplies its authored function contract and separates instructions from the editor`, () => {
        const exercise = readyById.get(id)!;
        expect(exercise.entryPoint).toMatch(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
        const methodSignature = '    ' + expectedSignatures[exercise.id].replace('(', '(self, ');
        expect(exercise.starterCode).toMatch(
          /^class Solution:\n    def [A-Za-z_][A-Za-z0-9_]*\(self, [^\n]*\):\n        pass\n$/,
        );
        expect(exercise.starterCode.split('\n')[1]).toBe(methodSignature);
        expect(exercise.referenceCode.split('\n')[1]).toBe(methodSignature);
        expect(
          exercise.starterCode.startsWith(`class Solution:\n    def ${exercise.entryPoint}(`),
        ).toBe(true);
        expect(
          exercise.referenceCode.startsWith(`class Solution:\n    def ${exercise.entryPoint}(`),
        ).toBe(true);
        expect(exercise.referenceCode).toMatch(/\breturn\b/);
        expect(exercise.referenceCode).not.toMatch(/(?:"""|'''|^\s*pass\s*$)/m);
        expect(['Easy', 'Medium']).toContain(exercise.difficulty);
        expect(exercise.title.trim()).not.toBe('');
        expect(exercise.topic.trim()).not.toBe('');
        expect(exercise.prompt.trim()).not.toBe('');
        expect(exercise.requirements.length).toBeGreaterThanOrEqual(2);
        expect(exercise.requirements.every((requirement) => requirement.trim().length > 0)).toBe(
          true,
        );
        expect(exercise.runtime).toBe('browser-python');
      });

      it(`${id}: provides distinct bounded cases and matching visible examples`, () => {
        const exercise = readyById.get(id)!;
        expect(exercise.cases.length).toBeGreaterThanOrEqual(8);
        expect(exercise.cases.length).toBeLessThanOrEqual(32);
        expect(new Set(exercise.cases.map((test) => test.name)).size).toBe(exercise.cases.length);
        expect(new Set(exercise.cases.map((test) => test.args)).size).toBe(exercise.cases.length);
        expect(exercise.customInput).toBe(exercise.cases[0].args);
        expect(exercise.examples).toHaveLength(2);
        exercise.examples.forEach((example, index) => {
          expect(example.input).toBe(exampleCall(exercise.entryPoint!, exercise.cases[index].args));
          expect(example.output).toBe(exercise.cases[index].expected);
        });
        for (const test of exercise.cases) {
          expect(test.name.trim().length).toBeGreaterThan(0);
          expect(test.name.length).toBeLessThanOrEqual(80);
          expect(test.args).toMatch(/^\([\s\S]*\)$/);
          expect(test.args.length).toBeLessThanOrEqual(8_192);
          expect(test.expected.trim().length).toBeGreaterThan(0);
          expect(test.expected.length).toBeLessThanOrEqual(8_192);
          expect([undefined, 'unchanged', 'independent_rows']).toContain(
            'check' in test ? test.check : undefined,
          );
          expect(
            Object.keys(test).every((key) => ['name', 'args', 'expected', 'check'].includes(key)),
          ).toBe(true);
        }
        expect(exercise.starterCode.length).toBeLessThanOrEqual(32_768);
        expect(exercise.referenceCode.length).toBeLessThanOrEqual(32_768);
        expect(
          JSON.stringify({
            code: exercise.referenceCode,
            entryPoint: exercise.entryPoint,
            cases: exercise.cases,
          }).length,
        ).toBeLessThanOrEqual(196_608);
      });
    }

    it('retains nonmutation and independent-row checks, including multiple zero-width rows', () => {
      const textOnly = new Set(['normalize_text', 'split_words', 'keep_alphanumeric']);
      for (const exercise of curatedData) {
        const expected =
          exercise.entryPoint === 'make_zero_grid'
            ? 'independent_rows'
            : textOnly.has(exercise.entryPoint!)
              ? undefined
              : 'unchanged';
        for (const test of exercise.cases)
          expect('check' in test ? test.check : undefined, exercise.id).toBe(expected);
      }
      const grid = readyById.get('python-core-make-zero-grid-01')!;
      expect(
        grid.cases.some(
          (test) =>
            /^\([2-9]\d*, 0\)$/.test(test.args) &&
            'check' in test &&
            test.check === 'independent_rows',
        ),
      ).toBe(true);
    });
  });
});
