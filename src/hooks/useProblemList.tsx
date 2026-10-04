'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Catalog } from '../schemas/catalog';
import type { ProgressData } from '../schemas/progress';

function useViewState() {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  return { query, setQuery, expanded, setExpanded };
}
const ViewContext = createContext<ReturnType<typeof useViewState> | null>(null);

// The root layout renders this, so the search and open decks survive visits to problems.
export function ProblemListProvider({ children }: { children: ReactNode }) {
  return <ViewContext.Provider value={useViewState()}>{children}</ViewContext.Provider>;
}

// The search, the decks it shows with their solved counts, and which decks are open.
export function useProblemList({ decks, problems }: Catalog, progress: ProgressData) {
  const state = useContext(ViewContext);
  if (!state) throw new Error('The problem list must be opened inside ProblemListProvider.');
  const { query, expanded, setExpanded } = state;
  const search = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      decks
        .map((deck) => {
          const all = problems.filter((problem) => problem.deckId === deck.id);
          return {
            ...deck,
            items: all.filter((problem) =>
              `${problem.title} ${problem.deck} ${problem.topic ?? ''} ${problem.prompt}`
                .toLowerCase()
                .includes(search),
            ),
            total: all.length,
            solved: all.filter((problem) => progress.exercises[problem.id]?.solved).length,
          };
        })
        // Decks without problems stay hidden; while searching, so do decks without matches.
        .filter((group) => group.total > 0 && (group.items.length > 0 || !search)),
    [decks, problems, progress, search],
  );
  return {
    query,
    expanded,
    setExpanded,
    groups,
    setQuery(value: string) {
      state.setQuery(value);
      // Searching opens every deck so the matches are visible.
      if (value.trim()) setExpanded(new Set(decks.map((deck) => deck.id)));
    },
    clearSearch() {
      state.setQuery('');
      setExpanded(new Set());
    },
  };
}
