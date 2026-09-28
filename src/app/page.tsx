'use client';

import { memo, useCallback, useEffect, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import {
  Accordion,
  Button,
  Container,
  EmptyState,
  Flex,
  Group,
  Progress,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { Search } from 'lucide-react';
import type { Problem } from '../schemas/catalog';
import { ProgressWarning, useAppData } from '../components/AppProvider';
import ProblemTable from '../components/ProblemTable';
import ProgressSidebar from '../components/ProgressSidebar';
import TopBar from '../components/TopBar';
import { useProblemList } from '../hooks/useProblemList';

const MemoizedProgressSidebar = memo(ProgressSidebar);

/** "/": every problem by deck, with search and the progress sidebar. */
export default function ProblemListPage() {
  const { catalog, store } = useAppData();
  const { progress, stars } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const router = useRouter();
  useEffect(() => {
    document.title = 'Code Practice';
    void store.refresh();
  }, [store]);
  const onSelect = useCallback(
    (problem: Problem, tab: 'question' | 'solution' = 'question') => {
      router.push(
        `/problems/${encodeURIComponent(problem.id)}${tab === 'solution' ? '?tab=solution' : ''}`,
      );
    },
    [router],
  );
  const onStar = useCallback((id: string, value: boolean) => store.setStar(id, value), [store]);
  const { query, setQuery, clearSearch, expanded, setExpanded, groups } = useProblemList(
    catalog,
    progress,
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
            <div>
              <Title order={1}>
                Code Practice
                <Text span c="teal" inherit>
                  .
                </Text>
              </Title>
              <Text c="dimmed">
                Build your skills, one problem at a time. Practice by topic and track your progress.
              </Text>
            </div>
            <TextInput
              type="search"
              aria-label="Search problems"
              placeholder="Search problems"
              leftSection={<Search size={15} />}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            {groups.length === 0 ? (
              <EmptyState icon={<Search size={25} />}>
                <EmptyState.Title order={2}>No matching problems</EmptyState.Title>
                <EmptyState.Description>Try another search.</EmptyState.Description>
                <EmptyState.Actions>
                  <Button onClick={clearSearch}>Clear search</Button>
                </EmptyState.Actions>
              </EmptyState>
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
                      <ProblemTable
                        items={group.items}
                        label={`${group.name} problems`}
                        progress={progress}
                        starred={stars}
                        onSelect={onSelect}
                        onStar={onStar}
                      />
                    </Accordion.Panel>
                  </Accordion.Item>
                ))}
              </Accordion>
            )}
          </Stack>
          <MemoizedProgressSidebar problems={catalog.problems} progress={progress} />
        </Flex>
      </Container>
    </>
  );
}
