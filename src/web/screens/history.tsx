import { useEffect, useMemo, useState } from 'preact/hooks';
import { addMonths, formatDate, monthOf } from '../../shared/dates';
import { categoryAverages, monthlySpending, weeklyNegotiable, type HistoryRow } from '../../shared/history';
import { usd, usd0 } from '../../shared/money';
import { phaseValue } from '../../shared/settings';
import { api } from '../api';
import type { ScreenProps } from '../app';
import { Delta } from '../components';
import { Sprout } from '../creature';

export function History({ state }: ScreenProps) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.history().then((r) => setRows(r.rows.map(([date, category, source, bank, amountUsd]) => ({ date, category, source, bank, amountUsd })))).catch((e) => setErr(String(e.message ?? e)));
  }, []);

  const data = useMemo(() => {
    if (!rows) return null;
    const monthly = monthlySpending(rows);
    const weekly = [...weeklyNegotiable(rows)].slice(-16);
    const thisMonth = monthOf(state.today);
    const avgMonths = [addMonths(thisMonth, -2), addMonths(thisMonth, -1)];
    return { monthly, weekly, avgMonths, averages: categoryAverages(rows, avgMonths) };
  }, [rows, state.today]);

  const maxWeek = data ? Math.max(1, ...data.weekly.map(([, v]) => v), ...data.weekly.map(([w]) => phaseValue(state.settings.allowance, w))) : 1;

  return (
    <div>
      <h1>History</h1>
      {err && <div class="notice bad">{err}</div>}
      {!data ? <div class="card"><span class="spinner" /> Loading…</div> : (
        <>
          <div class="card">
            <h2>Weekly negotiable spending</h2>
            {data.weekly.length === 0 ? <p class="muted">No data yet.</p> : (
              <>
                <div class="chart" role="img" aria-label="Weekly negotiable spending">
                  {data.weekly.map(([w, v]) => {
                    const allow = phaseValue(state.settings.allowance, w);
                    return <div class={v > allow ? 'over' : ''} style={{ height: `${Math.max(1, (Math.max(0, v) / maxWeek) * 100)}%` }} title={`${formatDate(w)}: ${usd(v)}`} />;
                  })}
                </div>
                <div class="chart-labels" aria-hidden="true">{data.weekly.map(([w]) => <span>{Number(w.slice(8))}</span>)}</div>
                <table style={{ marginTop: 8 }}>
                  <thead><tr><th>Week of</th><th class="r">Spent</th><th class="r">Allowance</th></tr></thead>
                  <tbody>{[...data.weekly].reverse().map(([w, v]) => { const a = phaseValue(state.settings.allowance, w); return <tr><td>{formatDate(w)}</td><td class={`r ${v > a ? 'bad' : ''}`}>{usd(v)}</td><td class="r">{usd0(a)}</td></tr>; })}</tbody>
                </table>
              </>
            )}
          </div>

          <div class="card">
            <h2>Monthly spending</h2>
            <p class="muted">Everything except Transfer and Investing.</p>
            <table><tbody>{[...data.monthly].reverse().map(([m, v]) => <tr><td>{m}</td><td class="r">{usd(v)}</td></tr>)}</tbody></table>
          </div>

          <div class="card">
            <h2>Category averages</h2>
            <p class="muted">Monthly average over {data.avgMonths.join(' and ')}.</p>
            <table><tbody>{data.averages.map((a) => <tr><td>{a.category}</td><td class="r">{usd(a.avg)}</td></tr>)}</tbody></table>
          </div>
        </>
      )}

      <div class="card">
        <h2>Score log</h2>
        {state.events.length === 0 ? <p class="muted">No changes yet. The first week is scored after Sunday 8pm.</p> : (
          <ul class="plain">
            {state.events.map((e) => (
              <li>
                <div class="row" style={{ alignItems: 'flex-start' }}><Delta d={e.delta} /><span class="grow">{e.reason}</span><span class="muted num">{e.healthAfter}</span></div>
                <small class="muted">{new Date(e.at).toLocaleString('en-GB', { timeZone: 'Asia/Phnom_Penh', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div class="card">
        <h2>Graveyard</h2>
        {state.graveyard.length === 0 ? <p class="muted">Empty. Keep it that way.</p> : (
          <ul class="plain">
            {state.graveyard.map((c) => (
              <li class="grave">
                <Sprout health={0} size={60} label={`${c.name}, died`} />
                <div><strong>{c.name}</strong><br /><small class="muted">{new Date(c.bornAt).toLocaleDateString('en-GB', { timeZone: 'Asia/Phnom_Penh' })} – {c.diedAt ? new Date(c.diedAt).toLocaleDateString('en-GB', { timeZone: 'Asia/Phnom_Penh' }) : ''}</small></div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
