import { useCallback, useEffect, useState } from 'preact/hooks';
import { ApiError, api, type AppState } from './api';
import { Home } from './screens/home';
import { Upload } from './screens/upload';
import { WriteItDown } from './screens/write';
import { Negotiables } from './screens/negotiables';
import { History } from './screens/history';
import { SettingsScreen } from './screens/settings';

export type Route = 'home' | 'upload' | 'write' | 'negotiables' | 'history' | 'settings';
const ROUTES: Route[] = ['home', 'upload', 'write', 'negotiables', 'history', 'settings'];

function currentRoute(): Route {
  const h = location.hash.replace(/^#\/?/, '') as Route;
  return ROUTES.includes(h) ? h : 'home';
}

export interface ScreenProps {
  state: AppState;
  reload: () => Promise<AppState | null>;
  go: (r: Route) => void;
}

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const TABS: { r: Route; label: string; d: string }[] = [
  { r: 'home', label: 'Home', d: 'M12 21c0-6 0-9 0-11M12 10C9 5 5 4 3 5c1 4 5 6 9 5zm0 0c2-4 6-6 9-5-1 4-5 6-9 5' },
  { r: 'upload', label: 'Upload', d: 'M12 16V4m0 0l-5 5m5-5l5 5M4 20h16' },
  { r: 'write', label: 'Write', d: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4' },
  { r: 'negotiables', label: 'Limits', d: 'M4 6h16M4 12h10M4 18h6' },
  { r: 'history', label: 'History', d: 'M4 19V9m6 10V5m6 14v-7m4 7H2' },
  { r: 'settings', label: 'Settings', d: 'M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 00-2-1.2L14.5 3h-5l-.4 2.6a7 7 0 00-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 002 1.2l.4 2.6h5l.4-2.6a7 7 0 002-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z' },
];

export function App() {
  const [route, setRoute] = useState<Route>(currentRoute());
  const [state, setState] = useState<AppState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const s = await api.state();
      setState(s);
      setError(null);
      return s;
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong.');
      return null;
    }
  }, []);

  useEffect(() => {
    void reload();
    const onHash = () => { setRoute(currentRoute()); window.scrollTo(0, 0); };
    const onVisible = () => { if (document.visibilityState === 'visible') void reload(); };
    window.addEventListener('hashchange', onHash);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.removeEventListener('hashchange', onHash); document.removeEventListener('visibilitychange', onVisible); };
  }, [reload]);

  const go = (r: Route) => { location.hash = `#/${r}`; };

  let body;
  if (!state) {
    body = error ? (
      <div class="card"><h2>Couldn't load</h2><p>{error}</p><button onClick={() => location.reload()}>Reload</button></div>
    ) : (
      <div class="card"><span class="spinner" /> Loading…</div>
    );
  } else {
    const props = { state, reload, go };
    body = {
      home: <Home {...props} />,
      upload: <Upload {...props} />,
      write: <WriteItDown {...props} />,
      negotiables: <Negotiables {...props} />,
      history: <History {...props} />,
      settings: <SettingsScreen {...props} />,
    }[route];
  }

  return (
    <>
      <main class="shell">
        {error && state && <div class="notice bad">{error}</div>}
        {body}
      </main>
      <nav class="tabs" aria-label="Screens">
        {TABS.map((t) => (
          <a href={`#/${t.r}`} aria-current={route === t.r ? 'page' : undefined}>{icon(t.d)}{t.label}</a>
        ))}
      </nav>
    </>
  );
}
