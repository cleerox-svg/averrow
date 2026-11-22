// Databases tab of the Operations workspace: capacity, load and health of every
// D1 database. Views: Cards (default) / Map / Table, and a per-store detail
// opened by `?db=<store>`. View, window and store live in the URL so every
// state is deep-linkable. The workspace owns the page h1.

import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageState, pageStateKind } from '@/design-system/components';
import { sectionErrors, useDatabases, type DbWindow } from '@/hooks/useDatabases';
import { CardsView, SummaryStrip } from './DatabaseCards';
import { DatabaseTable } from './DatabaseTable';
import { DatabaseMap } from './DatabaseMap';
import { DatabaseDetail } from './DatabaseDetail';
import { findStore } from './format';
import './databases.css';

type View = 'cards' | 'map' | 'table';
const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'cards', label: 'Cards' },
  { id: 'map', label: 'Map' },
  { id: 'table', label: 'Table' },
];
const WINDOWS: DbWindow[] = ['1h', '24h', 'cycle'];

export function Databases() {
  const [params, setParams] = useSearchParams();
  const rawView = params.get('view');
  const view: View = VIEWS.some((v) => v.id === rawView) ? (rawView as View) : 'cards';
  const rawWin = params.get('window');
  const win: DbWindow = WINDOWS.includes(rawWin as DbWindow) ? (rawWin as DbWindow) : '24h';
  const dbParam = params.get('db');

  const { data, isLoading, isError, isFetching, refetch } = useDatabases(win);

  const patch = useCallback((changes: Record<string, string | null>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(changes)) {
        if (v == null) next.delete(k); else next.set(k, v);
      }
      return next;
    }, { replace: true });
  }, [setParams]);

  const kind = pageStateKind({ isLoading: isLoading && !data, isError: isError && !data, isEmpty: !!data && data.databases.length === 0 });
  if (kind === 'loading') return <div className="dbp"><PageState kind="loading" /></div>;
  if (kind === 'error') {
    return <div className="dbp"><PageState kind="error" title="Couldn't load databases" onRetry={() => { void refetch(); }} /></div>;
  }
  if (!data || kind === 'empty') {
    return <div className="dbp"><PageState kind="empty" title="No databases reported" description="The platform returned no database registry." /></div>;
  }

  const errs = sectionErrors(data);
  const detail = dbParam ? findStore(data.databases, dbParam) : undefined;

  if (dbParam) {
    return (
      <div className="dbp">
        {isError && <PageState kind="error" layout="inline" title="Couldn't refresh databases" description="Showing the last loaded data." onRetry={() => { void refetch(); }} />}
        {detail
          ? <DatabaseDetail db={detail} />
          : <PageState kind="empty" title="Database not found" description={`There is no database "${dbParam}".`} action={{ label: 'All databases', onClick: () => patch({ db: null }) }} />}
      </div>
    );
  }

  return (
    <div className="dbp">
      <div className="dbp-toolbar">
        <p className="dbp-sub">Capacity, load and health of every D1 database the platform runs on.</p>
        <div className="dbp-seg" role="group" aria-label="View">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => patch({ view: v.id === 'cards' ? null : v.id })}>
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {isError && <PageState kind="error" layout="inline" title="Couldn't refresh databases" description="Showing the last loaded data." onRetry={() => { void refetch(); }} />}
      {errs.length > 0 && (
        <p className="dbp-note-banner" role="status">
          Some figures could not be loaded ({errs.join(', ')}) and show as not measured.
        </p>
      )}

      <SummaryStrip data={data} />

      <div aria-busy={isFetching} style={{ display: 'contents' }}>
        {view === 'cards' && <CardsView data={data} />}
        {view === 'map' && <DatabaseMap data={data} window={win} onWindow={(w) => patch({ window: w === '24h' ? null : w })} />}
        {view === 'table' && <DatabaseTable data={data} />}
      </div>
    </div>
  );
}
