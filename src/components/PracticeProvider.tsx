'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { LibraryStateProvider } from './PracticeLibrary';
import { loadCatalog, ProgressClient, type Catalog } from '../lib/database-client';

type PracticeState = { catalog: Catalog; client: ProgressClient };
const PracticeContext = createContext<PracticeState | null>(null);

export function usePractice() {
  const practice = useContext(PracticeContext);
  if (!practice) throw new Error('Practice must be opened inside PracticeProvider.');
  return practice;
}

export default function PracticeProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState<PracticeState | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const router = useRouter();
  useEffect(() => {
    // Preserve bookmarks from the original hash-based app.
    function openBookmark() {
      if (!window.location.hash) return;
      let id = '';
      try {
        id = decodeURIComponent(window.location.hash.slice(1));
      } catch {
        // Malformed legacy bookmarks return to the library.
      }
      router.replace(id && id !== 'library' ? `/problems/${encodeURIComponent(id)}` : '/');
    }
    openBookmark();
    window.addEventListener('hashchange', openBookmark);
    return () => window.removeEventListener('hashchange', openBookmark);
  }, [router]);
  useEffect(() => {
    let active = true;
    let client: ProgressClient | undefined;
    setError('');
    void (async () => {
      try {
        const catalog = await loadCatalog();
        if (!active) return;
        client = await ProgressClient.open();
        if (!active) {
          client.dispose();
          return;
        }
        setLoaded({ catalog, client });
      } catch (reason) {
        if (active)
          setError(reason instanceof Error ? reason.message : 'The database is unavailable.');
      }
    })();
    return () => {
      active = false;
      client?.dispose();
    };
  }, [attempt]);
  if (loaded)
    return (
      <PracticeContext.Provider value={loaded}>
        <LibraryStateProvider>{children}</LibraryStateProvider>
      </PracticeContext.Provider>
    );
  return (
    <div className="app library-view">
      <header className="topbar">
        <span className="brand">Code Practice</span>
      </header>
      <main className="empty-state" role={error ? 'alert' : 'status'}>
        <h1>{error ? 'Practice could not be loaded' : 'Loading your practice…'}</h1>
        {error && <p>{error}</p>}
        {error && (
          <button className="button primary" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        )}
      </main>
    </div>
  );
}
