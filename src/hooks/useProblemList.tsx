'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Catalog, Problem } from '../schemas/catalog';
import { localDateKey } from '../schemas/activity';
import type { ProgressData } from '../schemas/progress';

export type LibraryFilters = {
  query: string;
  deckId: string;
  difficulty: string;
  completion: string;
  starredOnly: boolean;
};
export type ProblemSort = {
  key: 'title' | 'difficulty';
  direction: 'ascending' | 'descending';
} | null;
export type Calendar = ReturnType<typeof useViewState>['calendar'];

const NO_FILTERS: LibraryFilters = {
  query: '',
  deckId: 'all',
  difficulty: 'all',
  completion: 'all',
  starredOnly: false,
};
const DIFFICULTY_ORDER = ['Easy', 'Medium', 'Hard'];
const ViewContext = createContext<ReturnType<typeof useViewState> | null>(null);

function useViewState() {
  const [filters, setFilters] = useState(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [view, setView] = useState<'decks' | 'all'>('decks');
  const [sort, setSort] = useState<ProblemSort>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [month, setMonth] = useState(() => localDateKey(new Date()).slice(0, 7));
  const [selected, setSelected] = useState(() => localDateKey(new Date()));
  const calendar = useMemo(() => ({ month, setMonth, selected, setSelected }), [month, selected]);
  return {
    filters,
    setFilters,
    filtersOpen,
    setFiltersOpen,
    view,
    setView,
    sort,
    setSort,
    expanded,
    setExpanded,
    calendar,
  };
}

/** The root layout renders this, so the problem list's view survives visits to problems. */
export function ProblemListProvider({ children }: { children: ReactNode }) {
  return <ViewContext.Provider value={useViewState()}>{children}</ViewContext.Provider>;
}

/** The problem list's view state, the problems it selects, and the actions that change it. */
export function useProblemList(
  { decks, problems }: Catalog,
  progress: ProgressData,
  stars: Set<string>,
) {
  const state = useContext(ViewContext);
  if (!state) throw new Error('The problem list must be opened inside ProblemListProvider.');
  const { filters, setFilters, sort, setSort, expanded, setExpanded } = state;
  const { query, deckId, difficulty, completion, starredOnly } = filters;
  const isSolved = useCallback(
    (problem: Problem) => Boolean(progress.exercises[problem.id]?.solved),
    [progress],
  );
  const search = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const matches = problems.filter(
      (problem) =>
        (!search ||
          `${problem.title} ${problem.deck} ${problem.topic ?? ''} ${problem.prompt}`
            .toLowerCase()
            .includes(search)) &&
        (deckId === 'all' || problem.deckId === deckId) &&
        (difficulty === 'all' || problem.difficulty === difficulty) &&
        (completion === 'all' ||
          (completion === 'solved' ? isSolved(problem) : !isSolved(problem))) &&
        (!starredOnly || stars.has(problem.id)),
    );
    if (sort)
      matches.sort((a, b) => {
        const comparison =
          sort.key === 'title'
            ? a.title.localeCompare(b.title)
            : DIFFICULTY_ORDER.indexOf(a.difficulty) - DIFFICULTY_ORDER.indexOf(b.difficulty) ||
              a.title.localeCompare(b.title);
        return sort.direction === 'ascending' ? comparison : -comparison;
      });
    return matches;
  }, [problems, search, deckId, difficulty, completion, starredOnly, stars, isSolved, sort]);
  const contentFilters = Boolean(
    search || difficulty !== 'all' || completion !== 'all' || starredOnly,
  );
  const groups = useMemo(
    () =>
      decks
        .filter((deck) => deckId === 'all' || deck.id === deckId)
        .map((deck) => {
          const all = problems.filter((problem) => problem.deckId === deck.id);
          return {
            ...deck,
            items: filtered.filter((problem) => problem.deckId === deck.id),
            total: all.length,
            solved: all.filter(isSolved).length,
          };
        })
        // Decks without problems stay hidden; while filtering, so do decks without matches.
        .filter((group) => group.total > 0 && (group.items.length > 0 || !contentFilters)),
    [decks, deckId, filtered, problems, contentFilters, isSolved],
  );
  const allExpanded = groups.length > 0 && groups.every((group) => expanded.has(group.id));
  const filterCount =
    Number(deckId !== 'all') +
    Number(difficulty !== 'all') +
    Number(completion !== 'all') +
    Number(starredOnly);
  const sortColumn = useCallback(
    (key: 'title' | 'difficulty') => {
      setSort((previous) => ({
        key,
        direction:
          previous?.key === key && previous.direction === 'ascending' ? 'descending' : 'ascending',
      }));
    },
    [setSort],
  );

  // Searching or choosing a filter opens every deck so matches are visible.
  const revealDecks = () => setExpanded(new Set(decks.map((deck) => deck.id)));
  return {
    ...state,
    isSolved,
    filtered,
    groups,
    difficulties: DIFFICULTY_ORDER.filter((value) =>
      problems.some((problem) => problem.difficulty === value),
    ),
    filterCount,
    hasFilters: Boolean(search || filterCount),
    allExpanded,
    sortColumn,
    setQuery(value: string) {
      setFilters((current) => ({ ...current, query: value }));
      if (value.trim()) revealDecks();
    },
    filter(change: Partial<LibraryFilters>) {
      setFilters((current) => ({ ...current, ...change }));
      revealDecks();
    },
    clearFilters() {
      setFilters(NO_FILTERS);
      setExpanded(new Set());
    },
    toggleAllDecks() {
      setExpanded(allExpanded ? new Set() : new Set(groups.map((group) => group.id)));
    },
  };
}
