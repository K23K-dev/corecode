import { useEffect, useState } from 'react';
import App from './App';
import { loadCatalog, ProgressClient, type Catalog } from './lib/database-client';

export default function DatabaseApp() {
  const [loaded, setLoaded] = useState<{ catalog: Catalog; client: ProgressClient } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
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
  if (loaded) return <App catalog={loaded.catalog} client={loaded.client} />;
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
