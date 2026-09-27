'use client';

import { memo, useCallback, useEffect, useId, useMemo, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import {
  Accordion,
  ActionIcon,
  Button,
  Checkbox,
  Collapse,
  Container,
  EmptyState,
  Flex,
  Group,
  Indicator,
  NativeSelect,
  Paper,
  Progress,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { ChevronDown, Search, Shuffle, SlidersHorizontal, X } from 'lucide-react';
import { Runner, pendingSubmissionProblemIds } from '../lib/runner';
import type { Problem } from '../schemas/catalog';
import { ProgressWarning, useAppData } from '../components/AppProvider';
import ProblemTable from '../components/ProblemTable';
import ProgressSidebar from '../components/ProgressSidebar';
import TopBar from '../components/TopBar';
import { useProblemList } from '../hooks/useProblemList';

const MemoizedProgressSidebar = memo(ProgressSidebar);

/** "/": every problem by deck, with search, filters, and the progress sidebar. */
export default function ProblemListPage() {
  const { catalog, store } = useAppData();
  const {
    progress,
    stars: starred,
    status: saveState,
  } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const router = useRouter();
  useEffect(() => {
    document.title = 'Code Practice';
    void store.refresh();
    // Leaving an editor detaches its watcher; the library keeps pending results current.
    const observers = pendingSubmissionProblemIds().flatMap((id) => {
      const problem = catalog.problems.find((item) => item.id === id);
      if (!problem) return [];
      const observer = new Runner();
      void observer
        .recover(problem)
        .then(() => store.refresh())
        .catch(() => {});
      return [observer];
    });
    return () => observers.forEach((observer) => observer.detach());
  }, [store, catalog]);
  const onSelect = useCallback(
    (problem: Problem, tab: 'question' | 'solution' = 'question') => {
      router.push(
        `/problems/${encodeURIComponent(problem.id)}${tab === 'solution' ? '?tab=solution' : ''}`,
      );
    },
    [router],
  );
  const onStar = useCallback((id: string, value: boolean) => store.setStar(id, value), [store]);
  const onSolved = useCallback(
    (problem: Problem, value: boolean) => {
      store.setSolved(problem.id, value, problem.starterCode);
    },
    [store],
  );
  const { decks, problems } = catalog;
  const stars = useMemo(() => new Set(starred), [starred]);
  const {
    filters: { query, deckId, difficulty, completion, starredOnly },
    filtersOpen,
    setFiltersOpen,
    view,
    setView,
    sort,
    expanded,
    setExpanded,
    calendar,
    isSolved,
    filtered,
    groups,
    difficulties,
    filterCount,
    hasFilters,
    allExpanded,
    sortColumn,
    setQuery,
    filter,
    clearFilters,
    toggleAllDecks,
  } = useProblemList(catalog, progress, stars);
  const filterPanelId = useId();
  const table = (items: Problem[], label: string) => (
    <ProblemTable
      items={items}
      label={label}
      progress={progress}
      starred={starred}
      sort={sort}
      onSort={sortColumn}
      onSelect={onSelect}
      onStar={onStar}
      onSolved={onSolved}
    />
  );

  return (
    <>
      <TopBar />
      <ProgressWarning store={store} />
      <Container size={1200} py="xl">
        <Flex
          component="main"
          aria-label="Practice library"
          gap="xl"
          align="flex-start"
          direction={{ base: 'column', lg: 'row' }}
        >
          <Stack flex={1} w="100%" miw={0}>
            <Group justify="space-between" align="flex-end">
              <div>
                <Title order={1}>
                  Code Practice
                  <Text span c="teal" inherit>
                    .
                  </Text>
                </Title>
                <Text c="dimmed">
                  Build your skills, one problem at a time. Practice by topic and track your
                  progress.
                </Text>
              </div>
              <Group gap="xl">
                <div>
                  <Text fz="xs" c="dimmed">
                    Solved
                  </Text>
                  <Text fz={26} fw={700}>
                    {problems.filter(isSolved).length}
                    <Text span c="dimmed" fz="sm">
                      /{problems.length}
                    </Text>
                  </Text>
                </div>
                <div>
                  <Text fz="xs" c="dimmed">
                    Starred
                  </Text>
                  <Text fz={26} fw={700}>
                    {problems.filter((problem) => stars.has(problem.id)).length}
                  </Text>
                </div>
              </Group>
            </Group>
            <SegmentedControl
              w="fit-content"
              aria-label="Problem view"
              value={view}
              onChange={setView}
              data={[
                { value: 'decks', label: 'By deck' },
                { value: 'all', label: 'All problems' },
              ]}
            />
            <Group gap="xs" wrap="nowrap">
              <TextInput
                flex={1}
                type="search"
                aria-label="Search problems"
                placeholder="Search problems"
                leftSection={<Search size={15} />}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              <Indicator label={filterCount} size={16} disabled={filterCount === 0}>
                <ActionIcon
                  size="lg"
                  variant="default"
                  aria-label="Filter problems"
                  title="Filter problems"
                  aria-expanded={filtersOpen}
                  aria-controls={filterPanelId}
                  onClick={() => setFiltersOpen((value) => !value)}
                >
                  <SlidersHorizontal size={16} />
                </ActionIcon>
              </Indicator>
              <ActionIcon
                size="lg"
                variant="default"
                aria-label="Shuffle filtered problems"
                title="Open a random matching problem"
                disabled={filtered.length === 0}
                onClick={() => onSelect(filtered[Math.floor(Math.random() * filtered.length)])}
              >
                <Shuffle size={16} />
              </ActionIcon>
              {hasFilters && (
                <ActionIcon
                  size="lg"
                  variant="default"
                  aria-label="Clear all filters"
                  title="Clear all filters"
                  onClick={clearFilters}
                >
                  <X size={16} />
                </ActionIcon>
              )}
            </Group>
            <Collapse expanded={filtersOpen} id={filterPanelId}>
              <Group align="flex-end">
                <NativeSelect
                  label="Deck"
                  value={deckId}
                  onChange={(event) => filter({ deckId: event.currentTarget.value })}
                  data={[
                    { value: 'all', label: 'All decks' },
                    ...decks.map((deck) => ({ value: deck.id, label: deck.name })),
                  ]}
                />
                <NativeSelect
                  label="Difficulty"
                  value={difficulty}
                  onChange={(event) => filter({ difficulty: event.currentTarget.value })}
                  data={[{ value: 'all', label: 'All difficulties' }, ...difficulties]}
                />
                <NativeSelect
                  label="Progress"
                  value={completion}
                  onChange={(event) => filter({ completion: event.currentTarget.value })}
                  data={[
                    { value: 'all', label: 'All problems' },
                    { value: 'unsolved', label: 'Unsolved' },
                    { value: 'solved', label: 'Solved' },
                  ]}
                />
                <Checkbox
                  mb={8}
                  label="Starred only"
                  checked={starredOnly}
                  onChange={(event) => filter({ starredOnly: event.currentTarget.checked })}
                />
              </Group>
            </Collapse>
            {view === 'decks' && (
              <Group justify="flex-end">
                <Button
                  variant="subtle"
                  color="gray"
                  size="compact-sm"
                  disabled={groups.length === 0}
                  onClick={toggleAllDecks}
                  aria-label={allExpanded ? 'Collapse all decks' : 'Expand all decks'}
                  rightSection={
                    <ChevronDown size={14} style={{ rotate: allExpanded ? '180deg' : undefined }} />
                  }
                >
                  {allExpanded ? 'Collapse' : 'Expand'}
                </Button>
              </Group>
            )}
            {hasFilters && (
              <Text role="status" fz="sm" c="dimmed">
                {filtered.length} of {problems.length} problems match your filters.
              </Text>
            )}
            {(view === 'all' ? filtered.length === 0 : groups.length === 0) ? (
              <EmptyState icon={<Search size={25} />}>
                <EmptyState.Title order={2}>No matching problems</EmptyState.Title>
                <EmptyState.Description>
                  Try another search or clear your filters.
                </EmptyState.Description>
                <EmptyState.Actions>
                  <Button onClick={clearFilters}>Clear filters</Button>
                </EmptyState.Actions>
              </EmptyState>
            ) : view === 'all' ? (
              <Paper withBorder component="section" aria-label="All problems">
                {table(filtered, 'All problems')}
              </Paper>
            ) : (
              <Accordion
                multiple
                variant="separated"
                value={[...expanded]}
                onChange={(value) => setExpanded(new Set(value))}
              >
                {groups.map((group) => (
                  <Accordion.Item key={group.id} value={group.id}>
                    <Accordion.Control>
                      <Group wrap="nowrap">
                        <Text fw={600} flex={1}>
                          {group.name}
                        </Text>
                        <Text
                          fz="sm"
                          c="dimmed"
                          aria-label={`${group.solved} of ${group.total} solved`}
                        >
                          {group.solved}/{group.total}
                        </Text>
                        <Progress
                          w={100}
                          size="sm"
                          value={(group.solved / group.total) * 100}
                          aria-hidden
                        />
                      </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                      {table(group.items, `${group.name} problems`)}
                    </Accordion.Panel>
                  </Accordion.Item>
                ))}
              </Accordion>
            )}
          </Stack>
          <MemoizedProgressSidebar
            problems={problems}
            progress={progress}
            saveState={saveState}
            calendar={calendar}
          />
        </Flex>
      </Container>
    </>
  );
}
