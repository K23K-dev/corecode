'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Alert, Button, EmptyState, Group, Loader } from '@mantine/core';
import { CircleAlert } from 'lucide-react';
import { requestJson } from '../lib/api';
import { ProgressStore } from '../lib/progress-store';
import { CatalogSchema, type Catalog } from '../schemas/catalog';
import TopBar from './TopBar';

type AppData = { catalog: Catalog; store: ProgressStore };
const AppContext = createContext<AppData | null>(null);

export function useAppData() {
  const data = useContext(AppContext);
  if (!data) throw new Error('useAppData must be called inside AppProvider.');
  return data;
}

export function ProgressWarning({ store }: { store: ProgressStore }) {
  const { warning } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return warning ? (
    <Alert color="yellow" radius={0} role="alert">
      <Group justify="space-between">
        {warning}
        <Button size="xs" variant="light" color="yellow" onClick={store.retry}>
          Retry
        </Button>
      </Group>
    </Alert>
  ) : null;
}

export default function AppProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState<AppData | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    let store: ProgressStore | undefined;
    setError('');
    void (async () => {
      try {
        const { value } = await requestJson('/api/catalog', {
          failure: 'The problem catalog is unavailable. Please retry in a moment.',
        });
        const catalog = CatalogSchema.parse(value);
        if (!active) return;
        store = await ProgressStore.open();
        if (!active) {
          store.dispose();
          return;
        }
        setLoaded({ catalog, store });
      } catch (reason) {
        if (active)
          setError(reason instanceof Error ? reason.message : 'The database is unavailable.');
      }
    })();
    return () => {
      active = false;
      store?.dispose();
    };
  }, [attempt]);
  useEffect(() => {
    if (!loaded) return;
    const { store } = loaded;
    const save = () => {
      void store.flush();
    };
    const refresh = () => {
      void store.refresh();
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') save();
      else refresh();
    };
    window.addEventListener('pagehide', save);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pagehide', save);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [loaded]);
  if (loaded) return <AppContext.Provider value={loaded}>{children}</AppContext.Provider>;
  return (
    <>
      <TopBar />
      <main>
        <EmptyState
          mt={120}
          role={error ? 'alert' : 'status'}
          icon={error ? <CircleAlert size={25} /> : <Loader size="sm" />}
          title={error ? 'Practice could not be loaded' : 'Loading your practice…'}
          description={error || undefined}
        >
          {error && <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>}
        </EmptyState>
      </main>
    </>
  );
}
