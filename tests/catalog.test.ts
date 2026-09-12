import { beforeAll, describe, expect, it } from 'vitest';
import type { Catalog } from '../src/lib/database-client';
import type { Exercise } from '../src/lib/exercises';
import type { TestCase } from '../src/lib/practice-runner';

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
const supportedRuntimes = ['browser-python', 'python', 'sql', 'shell', 'javascript'];

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

function exampleCall(entryPoint: string, args: string): string {
  return `${entryPoint}(${args.slice(1, -1).replace(/,\s*$/, '')})`;
}

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
    it('provides a nonempty current catalog with stable unique IDs', () => {
      expect(readyData.length).toBeGreaterThan(0);
      expect(readyById.size).toBe(readyData.length);
      for (const exercise of readyData) {
        expect(exercise.id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
        expect(['__proto__', 'prototype', 'constructor']).not.toContain(exercise.id);
        expect(exercise.version, exercise.id).toMatch(/^[a-f0-9]{64}$/);
      }
    });

    it('keeps source ordinals and abbreviations out of displayed problem titles', () => {
      expect(
        readyData.filter(
          (item) => /\b0\d+\b/.test(item.title) || /^(?:Ds|Algo)\b/.test(item.title),
        ),
      ).toEqual([]);
    });

    it('preserves meaningful numbers in scientific problem titles', () => {
      expect(readyData.filter((item) => /\d/.test(item.title)).map((item) => item.title)).toEqual(
        expect.arrayContaining([
          'Best F1 threshold',
          'Batch Norm1d',
          'Conv2d single channel',
          'Max pool2d',
        ]),
      );
    });

    it('preserves the study decks and assigns every current problem to a unique valid deck', () => {
      const deckNames = decks.map((deck) => deck.name);
      expect(deckNames.filter((name) => expectedStudyDecks.includes(name))).toEqual(
        expectedStudyDecks,
      );
      expect(new Set(deckNames).size).toBe(decks.length);
      expect(new Set(decks.map((deck) => deck.id)).size).toBe(decks.length);
      expect(decks.every((deck) => /^[a-z]+(?:-[a-z]+)*$/.test(deck.id))).toBe(true);
      expect(
        readyData.every((exercise) =>
          decks.some((deck) => deck.id === exercise.deckId && deck.name === exercise.deck),
        ),
      ).toBe(true);
    });

    it('places foundational exercises before their same-deck composition exercises', () => {
      // These are selected prerequisite edges, not a second catalog or a complete sort order.
      const chains: Record<string, string[][]> = {
        python: [
          ['python-core-slice-window-01', 'python-core-reversed-copy-01'],
          ['python-core-frequency-map-01', 'python-core-most-common-values-01'],
        ],
        frontend: [
          ['frontend-html-001-semantic-product-card', 'frontend-browser-001-render-list'],
          ['frontend-tsx-001-typed-user-list', 'frontend-react-003-counter'],
          ['frontend-react-009-load-user', 'frontend-react-014-paginated-products'],
        ],
        backend: [
          ['backend-express-000-app-wiring', 'backend-express-001-get-product'],
          ['backend-pg-001-with-client', 'backend-pg-002-transaction'],
          ['backend-auth-000-insert-user', 'backend-auth-001-register', 'backend-auth-002-login'],
        ],
        sql: [
          [
            'sql-practice-select-aliases',
            'sql-select-filter-products',
            'sql-join-orders-customers',
          ],
          ['sql-group-top-categories', 'sql-practice-cte-customer-spend'],
          ['sql-practice-order-limit-ties', 'sql-practice-top-two-salaries-11'],
        ],
        linux: [
          ['linux-practice-inspect-location-19', 'linux-practice-file-workflow-21'],
          ['linux-practice-list-processes-08', 'linux-practice-kill-term-09'],
          ['linux-practice-tar-create-17', 'linux-practice-tar-extract-56'],
        ],
        'low-level-design': [
          ['lld-strategy-parking-fee-01', 'lld-parking-lot-allocate-space-01'],
          ['lld-state-vending-delegation-01', 'lld-vending-machine-vend-01'],
        ],
        'machine-learning': [
          ['ml-practice-014', 'ml-practice-030', 'ml-practice-002'],
          ['ml-practice-005', 'ml-practice-006', 'ml-practice-007'],
          ['ml-practice-016', 'ml-practice-017', 'ml-practice-018', 'ml-practice-019'],
        ],
        'deep-learning': [
          ['dl-practice-001', 'dl-practice-002', 'dl-practice-003'],
          ['dl-practice-006', 'dl-practice-007', 'dl-practice-009', 'dl-practice-010'],
          ['dl-practice-011', 'dl-practice-012', 'dl-practice-013', 'dl-practice-014'],
        ],
        llm: [
          [
            'llm-practice-001',
            'llm-practice-002',
            'llm-practice-003',
            'llm-practice-004',
            'llm-practice-007',
            'llm-practice-008',
            'llm-practice-010',
            'llm-practice-011',
            'llm-practice-012',
          ],
          ['llm-practice-013', 'llm-practice-014'],
          ['llm-practice-015', 'llm-practice-016'],
        ],
        'llm-applications': [
          [
            'llm-app-practice-001',
            'llm-app-practice-002',
            'llm-app-practice-003',
            'llm-app-practice-004',
            'llm-app-practice-005',
          ],
          ['llm-app-practice-006', 'llm-app-practice-007', 'llm-app-practice-008'],
        ],
        algorithms: [
          ['algo-sort-003-merge-sorted', 'algo-sort-004-merge-sort'],
          ['algo-sort-005-partition', 'algo-sort-006-quicksort', 'algo-search-004-quickselect'],
          [
            'algo-tree-001-preorder',
            'algo-tree-002-inorder',
            'algo-tree-003-postorder',
            'algo-tree-004-level-order',
          ],
          ['algo-graph-001-bfs-distances', 'algo-graph-003-connected-components'],
        ],
        'data-structures': [
          ['ds-stack-001-complete', 'ds-deque-003-complete'],
          ['ds-queue-001-complete', 'ds-deque-003-complete'],
          ['ds-array-001-resize', 'ds-array-002-remove-at', 'ds-array-003-complete'],
        ],
        numpy: [
          ['numpy-array-profile-01', 'numpy-make-grid-01', 'numpy-flatten-batch-01'],
          ['numpy-crop-01', 'numpy-independent-slice-01'],
          ['numpy-add-column-offsets-01', 'numpy-zscore-01'],
        ],
        pandas: [
          [
            'pandas-selection-return-types-01',
            'pandas-select-block-01',
            'pandas-slice-endpoints-01',
          ],
          ['pandas-missing-mask-01', 'pandas-missing-report-01'],
          ['pandas-observed-summary-01', 'pandas-missing-report-01'],
          ['pandas-group-size-vs-count-01', 'pandas-category-stats-01'],
          ['pandas-merge-retention-01', 'pandas-enriched-01', 'pandas-validated-order-items-01'],
        ],
      };
      const positions = new Map(readyData.map((exercise, index) => [exercise.id, index]));
      for (const [deckId, sequences] of Object.entries(chains)) {
        for (const ids of sequences) {
          let previous = -1;
          for (const id of ids) {
            expect(readyById.get(id)?.deckId, `${id} belongs to ${deckId}`).toBe(deckId);
            const position = positions.get(id)!;
            expect(position, `${deckId}: ${ids.join(' → ')}`).toBeGreaterThan(previous);
            previous = position;
          }
        }
      }
    });

    it('provides bounded behavioral metadata without leaking server-side grading code', () => {
      for (const exercise of readyData) {
        expect(supportedRuntimes, exercise.id).toContain(exercise.runtime);
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

    it('keeps Python, shell, SQL, and web runtime contracts consistent with their decks', () => {
      for (const exercise of readyData) {
        const allowedRuntimes =
          exercise.deckId === 'sql'
            ? ['sql']
            : exercise.deckId === 'linux'
              ? ['shell']
              : ['frontend', 'backend'].includes(exercise.deckId)
                ? ['javascript']
                : Object.hasOwn(expectedReadyCaseCounts, exercise.id)
                  ? ['browser-python']
                  : exercise.deckId === 'python'
                    ? ['python', 'browser-python']
                    : ['python'];
        expect(allowedRuntimes, exercise.id).toContain(exercise.runtime);
        if (exercise.runtime === 'python' || exercise.runtime === 'browser-python') {
          expect(exercise.language, exercise.id).toBe('Python');
          expect(exercise.extension, exercise.id).toBe('py');
        }
      }
    });

    it('keeps Python function wrappers consistent while preserving domain-class exercises', () => {
      const python = readyData.filter((exercise) => exercise.language === 'Python');
      const wrapped = python.filter((exercise) =>
        [
          exercise.starterCode,
          exercise.referenceCode,
          ...(exercise.solutionAlternatives ?? []).map((alternative) => alternative.code),
        ].some((source) => /^class Solution:/m.test(source)),
      );
      expect(wrapped.length).toBeGreaterThan(0);
      for (const exercise of wrapped) {
        expect(exercise.starterCode, exercise.id).toMatch(/^class Solution:/m);
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
      ).toEqual(expect.arrayContaining(Object.keys(expectedReadyCaseCounts)));
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
