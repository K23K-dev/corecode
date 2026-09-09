import { memo, useCallback, useId, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  FileText,
  Layers3,
  Search,
  Shuffle,
  SlidersHorizontal,
  Star,
  X,
} from 'lucide-react';
import type { Exercise } from '../lib/exercises';
import type { Catalog } from '../lib/database-client';
import type { ProgressData } from '../lib/progress';
import PracticeTracker from './PracticeTracker';
import '../library-page.css';

const difficultyOrder = ['Easy', 'Medium', 'Hard'];
type ProblemSort = { key: 'title' | 'difficulty'; direction: 'ascending' | 'descending' } | null;
const MemoizedPracticeTracker = memo(PracticeTracker);

// Opening a deck changes only its disclosure shell, not its problem rows.
const ProblemTable = memo(function ProblemTable({
  items,
  label,
  progress,
  starred,
  sort,
  onSort,
  onSelect,
  onStar,
}: {
  items: Exercise[];
  label: string;
  progress: ProgressData;
  starred: string[];
  sort: ProblemSort;
  onSort: (key: 'title' | 'difficulty') => void;
  onSelect: (exercise: Exercise, tab?: 'question' | 'solution') => void;
  onStar: (id: string, value: boolean) => void;
}) {
  const stars = new Set(starred);
  const isSolved = (exercise: Exercise) => Boolean(progress.exercises[exercise.id]?.solved);
  function sortIcon(key: 'title' | 'difficulty') {
    const Icon =
      sort?.key !== key ? ArrowUpDown : sort.direction === 'ascending' ? ArrowUp : ArrowDown;
    return <Icon size={12} aria-hidden="true" />;
  }
  return (
    <table className="pl-problem-table" aria-label={label}>
      <thead>
        <tr>
          <th scope="col" className="pl-status-column">
            Status
          </th>
          <th scope="col" className="pl-star-column">
            Star
          </th>
          <th scope="col" aria-sort={sort?.key === 'title' ? sort.direction : 'none'}>
            <button className="pl-sort-button" onClick={() => onSort('title')}>
              Problem {sortIcon('title')}
            </button>
          </th>
          <th
            scope="col"
            className="pl-difficulty-column"
            aria-sort={sort?.key === 'difficulty' ? sort.direction : 'none'}
          >
            <button className="pl-sort-button" onClick={() => onSort('difficulty')}>
              Difficulty {sortIcon('difficulty')}
            </button>
          </th>
          <th scope="col" className="pl-solution-column">
            Solution
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((exercise) => (
          <tr
            key={exercise.id}
            data-problem-id={exercise.id}
            className={isSolved(exercise) ? 'is-solved' : undefined}
            onClick={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest('button, a, input, select, textarea')
              )
                return;
              onSelect(exercise);
            }}
          >
            <td className="pl-status-column">
              <span
                className={`pl-problem-status ${isSolved(exercise) ? 'is-solved' : ''}`}
                role="img"
                aria-label={isSolved(exercise) ? 'Solved' : 'Not solved'}
              >
                {isSolved(exercise) ? (
                  <CircleCheck size={18} aria-hidden="true" />
                ) : (
                  <Circle size={17} aria-hidden="true" />
                )}
              </span>
            </td>
            <td className="pl-star-column">
              <button
                type="button"
                className={`pl-star-button ${stars.has(exercise.id) ? 'is-starred' : ''}`}
                aria-label={`${stars.has(exercise.id) ? 'Unstar' : 'Star'} ${exercise.title}`}
                aria-pressed={stars.has(exercise.id)}
                onClick={() => onStar(exercise.id, !stars.has(exercise.id))}
              >
                <Star
                  size={19}
                  fill={stars.has(exercise.id) ? 'currentColor' : 'none'}
                  aria-hidden="true"
                />
              </button>
            </td>
            <td>
              <button type="button" className="pl-problem-link" onClick={() => onSelect(exercise)}>
                {exercise.title}
              </button>
            </td>
            <td className="pl-difficulty-column">
              <span className={`pl-difficulty pl-${exercise.difficulty.toLowerCase()}`}>
                {exercise.difficulty}
              </span>
            </td>
            <td className="pl-solution-column">
              <button
                type="button"
                className="pl-solution-button"
                aria-label={`View solution for ${exercise.title}`}
                onClick={() => onSelect(exercise, 'solution')}
              >
                <FileText size={17} aria-hidden="true" />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
});

export default function PracticeLibrary({
  progress,
  onSelect,
  catalog,
  starred,
  onStar,
  saveState = 'saved',
}: {
  progress: ProgressData;
  onSelect: (exercise: Exercise, tab?: 'question' | 'solution') => void;
  catalog: Catalog;
  starred: string[];
  onStar: (id: string, value: boolean) => void;
  saveState?: string;
}) {
  const { decks, exercises } = catalog;
  const stars = useMemo(() => new Set(starred), [starred]);
  const difficulties = difficultyOrder.filter((value) =>
    exercises.some((exercise) => exercise.difficulty === value),
  );
  const [query, setQuery] = useState('');
  const [deckId, setDeckId] = useState('all');
  const [difficulty, setDifficulty] = useState('all');
  const [completion, setCompletion] = useState('all');
  const [starredOnly, setStarredOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [view, setView] = useState<'decks' | 'all'>('decks');
  const [sort, setSort] = useState<ProblemSort>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const instanceId = useId();
  const isSolved = useCallback(
    (exercise: Exercise) => Boolean(progress.exercises[exercise.id]?.solved),
    [progress],
  );
  const solvedCount = exercises.filter(isSolved).length;
  const search = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const matches = exercises.filter(
      (exercise) =>
        (!search ||
          `${exercise.title} ${exercise.deck} ${exercise.topic ?? ''} ${exercise.prompt}`
            .toLowerCase()
            .includes(search)) &&
        (deckId === 'all' || exercise.deckId === deckId) &&
        (difficulty === 'all' || exercise.difficulty === difficulty) &&
        (completion === 'all' ||
          (completion === 'solved' ? isSolved(exercise) : !isSolved(exercise))) &&
        (!starredOnly || stars.has(exercise.id)),
    );
    if (sort)
      matches.sort((a, b) => {
        const comparison =
          sort.key === 'title'
            ? a.title.localeCompare(b.title)
            : difficultyOrder.indexOf(a.difficulty) - difficultyOrder.indexOf(b.difficulty) ||
              a.title.localeCompare(b.title);
        return sort.direction === 'ascending' ? comparison : -comparison;
      });
    return matches;
  }, [exercises, search, deckId, difficulty, completion, starredOnly, stars, isSolved, sort]);
  const contentFilters = Boolean(
    search || difficulty !== 'all' || completion !== 'all' || starredOnly,
  );
  const groups = useMemo(
    () =>
      decks
        .filter((deck) => deckId === 'all' || deck.id === deckId)
        .map((deck) => ({
          ...deck,
          items: filtered.filter((exercise) => exercise.deckId === deck.id),
          total: exercises.filter((exercise) => exercise.deckId === deck.id).length,
        }))
        .filter((group) => group.items.length > 0 || !contentFilters),
    [decks, deckId, filtered, exercises, contentFilters],
  );
  const allExpanded = groups.length > 0 && groups.every((group) => expanded.has(group.id));
  const filterCount =
    Number(deckId !== 'all') +
    Number(difficulty !== 'all') +
    Number(completion !== 'all') +
    Number(starredOnly);
  const hasFilters = Boolean(search || filterCount);
  const selectedEmptyDeck = decks.find(
    (deck) => deck.id === deckId && !exercises.some((exercise) => exercise.deckId === deck.id),
  );
  const filterPanelId = `${instanceId}-filters`;

  function revealDecks() {
    setExpanded(new Set(decks.map((deck) => deck.id)));
  }

  function clearFilters() {
    setQuery('');
    setDeckId('all');
    setDifficulty('all');
    setCompletion('all');
    setStarredOnly(false);
    setExpanded(new Set());
  }

  function toggleDeck(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const sortColumn = useCallback((key: 'title' | 'difficulty') => {
    setSort((previous) => ({
      key,
      direction:
        previous?.key === key && previous.direction === 'ascending' ? 'descending' : 'ascending',
    }));
  }, []);

  function problemTable(items: Exercise[], label: string) {
    return (
      <ProblemTable
        items={items}
        label={label}
        progress={progress}
        starred={starred}
        sort={sort}
        onSort={sortColumn}
        onSelect={onSelect}
        onStar={onStar}
      />
    );
  }

  return (
    <main className="practice-library" aria-label="Practice library">
      <div className="pl-layout">
        <div className="pl-content">
          <section className="pl-hero" aria-labelledby={`${instanceId}-title`}>
            <div className="pl-introduction">
              <h1 id={`${instanceId}-title`}>
                Code Practice<span>.</span>
              </h1>
              <p>
                Build your skills, one problem at a time. Practice by topic and track your progress.
              </p>
            </div>
            <div className="pl-statistics">
              <div className="pl-stat">
                <span>
                  <Check size={13} className="pl-stat-check" aria-hidden="true" /> Solved
                </span>
                <strong data-testid="library-solved-count">
                  {solvedCount}
                  <span>/{exercises.length}</span>
                </strong>
              </div>
              <div className="pl-stat">
                <span>
                  <Star size={13} className="pl-stat-star" aria-hidden="true" /> Starred
                </span>
                <strong data-testid="library-starred-count">
                  {exercises.filter((exercise) => stars.has(exercise.id)).length}
                </strong>
              </div>
            </div>
          </section>

          <div className="pl-view-selector" role="group" aria-label="Problem view">
            <button
              type="button"
              className={view === 'decks' ? 'is-active' : ''}
              aria-pressed={view === 'decks'}
              onClick={() => setView('decks')}
            >
              <Layers3 size={16} aria-hidden="true" /> By deck
            </button>
            <button
              type="button"
              className={view === 'all' ? 'is-active' : ''}
              aria-pressed={view === 'all'}
              onClick={() => setView('all')}
            >
              All problems
            </button>
          </div>

          <div className="pl-toolbar">
            <label className="pl-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                aria-label="Search problems"
                placeholder="Search problems"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (event.target.value.trim()) revealDecks();
                }}
              />
            </label>
            <div className="pl-tools">
              <button
                type="button"
                className={`pl-tool-button ${filterCount ? 'has-active-filter' : ''}`}
                aria-label="Filter problems"
                title="Filter problems"
                aria-expanded={filtersOpen}
                aria-controls={filterPanelId}
                onClick={() => setFiltersOpen((value) => !value)}
              >
                <SlidersHorizontal size={16} aria-hidden="true" />
                {filterCount > 0 && <span className="pl-filter-count">{filterCount}</span>}
              </button>
              <button
                type="button"
                className="pl-tool-button"
                aria-label="Shuffle filtered problems"
                title="Open a random matching problem"
                disabled={filtered.length === 0}
                onClick={() => onSelect(filtered[Math.floor(Math.random() * filtered.length)])}
              >
                <Shuffle size={16} aria-hidden="true" />
              </button>
              {hasFilters && (
                <button
                  type="button"
                  className="pl-tool-button"
                  aria-label="Clear all filters"
                  title="Clear all filters"
                  onClick={clearFilters}
                >
                  <X size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          <div id={filterPanelId} className="pl-filter-panel" hidden={!filtersOpen}>
            <label>
              Deck
              <select
                aria-label="Filter by deck"
                value={deckId}
                onChange={(event) => {
                  setDeckId(event.target.value);
                  revealDecks();
                }}
              >
                <option value="all">All decks</option>
                {decks.map((deck) => (
                  <option key={deck.id} value={deck.id}>
                    {deck.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Difficulty
              <select
                aria-label="Filter by difficulty"
                value={difficulty}
                onChange={(event) => {
                  setDifficulty(event.target.value);
                  revealDecks();
                }}
              >
                <option value="all">All difficulties</option>
                {difficulties.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Progress
              <select
                aria-label="Filter by completion"
                value={completion}
                onChange={(event) => {
                  setCompletion(event.target.value);
                  revealDecks();
                }}
              >
                <option value="all">All problems</option>
                <option value="unsolved">Unsolved</option>
                <option value="solved">Solved</option>
              </select>
            </label>
            <label className="pl-star-filter">
              <input
                type="checkbox"
                checked={starredOnly}
                onChange={(event) => {
                  setStarredOnly(event.target.checked);
                  revealDecks();
                }}
              />
              <Star size={15} aria-hidden="true" /> Starred only
            </label>
          </div>

          {view === 'decks' && (
            <div className="pl-topic-toolbar">
              <button
                type="button"
                className="pl-expand-button"
                disabled={groups.length === 0}
                onClick={() =>
                  setExpanded(allExpanded ? new Set() : new Set(groups.map((group) => group.id)))
                }
                aria-label={allExpanded ? 'Collapse all decks' : 'Expand all decks'}
              >
                {allExpanded ? 'Collapse' : 'Expand'}{' '}
                <ChevronDown
                  size={14}
                  className={allExpanded ? 'pl-chevron-up' : ''}
                  aria-hidden="true"
                />
              </button>
            </div>
          )}

          {hasFilters && (
            <p className="pl-match-count" role="status">
              {filtered.length} of {exercises.length} problems match your filters.
            </p>
          )}
          {(view === 'all' ? filtered.length === 0 : groups.length === 0) ? (
            <div className="pl-empty-state">
              <Search size={25} aria-hidden="true" />
              <h2>
                {selectedEmptyDeck
                  ? `No problems in ${selectedEmptyDeck.name} yet`
                  : 'No matching problems'}
              </h2>
              <p>
                {selectedEmptyDeck
                  ? 'This deck is set up, but its website exercises have not been built yet.'
                  : 'Try another search or clear your filters.'}
              </p>
              <button type="button" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          ) : view === 'all' ? (
            <section className="pl-all-problems" aria-label="All problems">
              {problemTable(filtered, 'All problems')}
            </section>
          ) : (
            <div className="pl-topic-groups">
              {groups.map((group) => {
                const open = expanded.has(group.id);
                const solved = exercises.filter(
                  (exercise) => exercise.deckId === group.id && isSolved(exercise),
                ).length;
                const bodyId = `${instanceId}-deck-${group.id}`;
                return (
                  <section className={`pl-topic-group ${open ? 'is-open' : ''}`} key={group.name}>
                    <h2>
                      <button
                        type="button"
                        className="pl-topic-heading"
                        aria-expanded={open}
                        aria-controls={bodyId}
                        onClick={() => toggleDeck(group.id)}
                      >
                        <ChevronRight
                          size={15}
                          className={open ? 'pl-chevron-open' : ''}
                          aria-hidden="true"
                        />
                        <span className="pl-topic-name">{group.name}</span>
                        {group.total > 0 ? (
                          <>
                            <span
                              className="pl-topic-completion"
                              aria-label={`${solved} of ${group.total} solved`}
                            >
                              {solved}/{group.total}
                            </span>
                            <span className="pl-topic-progress" aria-hidden="true">
                              <span style={{ width: `${(solved / group.total) * 100}%` }} />
                            </span>
                          </>
                        ) : (
                          <span className="pl-deck-pending">No problems yet</span>
                        )}
                      </button>
                    </h2>
                    <div id={bodyId} className="pl-topic-reveal" inert={!open} aria-hidden={!open}>
                      <div className="pl-topic-clip">
                        <div className="pl-topic-body">
                          {group.total > 0 ? (
                            problemTable(group.items, `${group.name} problems`)
                          ) : (
                            <div className="pl-deck-empty">
                              <p>No website problems in {group.name} yet.</p>
                              <p>
                                This deck is set up. Its exercises and grading still need to be
                                built.
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
        <MemoizedPracticeTracker exercises={exercises} progress={progress} saveState={saveState} />
      </div>
    </main>
  );
}
