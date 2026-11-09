import { useState } from 'preact/hooks';
import { ALL_CATEGORIES, isNegotiable, NEGOTIABLE } from '../../shared/categories';
import { formatDate } from '../../shared/dates';
import { usd } from '../../shared/money';
import { api } from '../api';
import type { ScreenProps } from '../app';

export function WriteItDown({ state, reload }: ScreenProps) {
  const [mode, setMode] = useState<'planned' | 'cash'>('planned');
  const [amount, setAmount] = useState('');
  const [what, setWhat] = useState('');
  const [why, setWhy] = useState('');
  const [category, setCategory] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [cashHash, setCashHash] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const amt = Number(amount);
  const valid = Number.isFinite(amt) && amt > 0 && what.trim() && (mode === 'planned' || (cashHash && category));
  const openCash = state.cash.filter((c) => c.amountUsd - c.logged > 0.009);

  async function submit(e: Event) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.addLog({ kind: mode, amountUsd: Math.round(amt * 100) / 100, what, why, category: category || null, urgent, cashTxHash: mode === 'cash' ? cashHash : null, date: state.today });
      let text = `Written down: ${usd(amt)} for ${what}.`;
      if (mode === 'planned' && amt > 100 && !urgent) {
        const at = new Date(Date.now() + 48 * 3600e3).toLocaleString('en-GB', { timeZone: 'Asia/Phnom_Penh', weekday: 'short', hour: '2-digit', minute: '2-digit' });
        text += ` Rule: wait 48 hours — don't buy before ${at}.`;
      }
      setMsg({ ok: true, text });
      setAmount(''); setWhat(''); setWhy(''); setCategory(''); setUrgent(false); setCashHash('');
      await reload();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try { await api.deleteLog(id); await reload(); } catch (err) { setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
  }

  return (
    <div>
      <h1>Write it down</h1>
      <div class="card">
        <div class="row">
          <button class={mode === 'planned' ? '' : 'secondary'} onClick={() => setMode('planned')}>Before I pay</button>
          <button class={mode === 'cash' ? '' : 'secondary'} onClick={() => setMode('cash')}>What cash bought</button>
        </div>
        <p class="muted">
          {mode === 'planned'
            ? 'Anything negotiable of $30 or more must be written down before you pay (within $2, up to 2 days before), or it costs −5.'
            : 'Cash counts as spending when you withdraw it. Log what it bought: if it went on something committed (e.g. rent), it comes off your weekly spending.'}
        </p>
        <form onSubmit={submit}>
          {mode === 'cash' && (
            <>
              <label for="cash">Cash withdrawal</label>
              <select id="cash" value={cashHash} onChange={(e) => setCashHash((e.target as HTMLSelectElement).value)}>
                <option value="">Pick a withdrawal…</option>
                {openCash.map((c) => <option value={c.hash}>{formatDate(c.date)} · {usd(c.amountUsd)} ({usd(c.amountUsd - c.logged)} left)</option>)}
              </select>
              {openCash.length === 0 && <small class="muted">No cash withdrawals in the last 60 days of uploaded statements.</small>}
            </>
          )}
          <label for="amt">Amount (USD)</label>
          <input id="amt" inputMode="decimal" type="number" step="0.01" min="0.01" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} required />
          <label for="what">What</label>
          <input id="what" value={what} maxLength={120} onInput={(e) => setWhat((e.target as HTMLInputElement).value)} required />
          {mode === 'planned' && (
            <>
              <label for="why">Why</label>
              <textarea id="why" value={why} maxLength={300} onInput={(e) => setWhy((e.target as HTMLTextAreaElement).value)} />
            </>
          )}
          <label for="cat">Category{mode === 'planned' ? ' (optional)' : ''}</label>
          <select id="cat" value={category} onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}>
            <option value="">—</option>
            {(mode === 'planned' ? (NEGOTIABLE as readonly string[]) : ALL_CATEGORIES).map((c) => <option value={c}>{c}</option>)}
          </select>
          {mode === 'planned' && amt > 100 && (
            <label class="check" style={{ marginTop: 10 }}><input type="checkbox" checked={urgent} onChange={(e) => setUrgent((e.target as HTMLInputElement).checked)} /> Urgent (skip the 48-hour wait)</label>
          )}
          {mode === 'planned' && amt > 100 && !urgent && <div class="notice warn">Over $100: wait 48 hours before buying unless it's urgent.</div>}
          {mode === 'cash' && category && !isNegotiable(category) && <p class="good">This will come off this week's negotiable spending.</p>}
          <button class="full" style={{ marginTop: 12 }} disabled={!valid || busy}>{busy ? 'Saving…' : 'Write it down'}</button>
        </form>
        {msg && <div class={`notice ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</div>}
      </div>

      <div class="card">
        <h2>Recent entries</h2>
        {state.logs.length === 0 ? <p class="muted">Nothing yet.</p> : (
          <ul class="plain">
            {state.logs.slice(0, 40).map((l) => (
              <li>
                <div class="row space"><strong class="ellipsis grow">{l.what}</strong><span class="num">{usd(l.amountUsd)}</span></div>
                <small class="muted">{formatDate(l.date)} · {l.kind === 'cash' ? 'cash' : 'before paying'}{l.category ? ` · ${l.category}` : ''}{l.urgent ? ' · urgent' : ''}{l.why ? ` · ${l.why}` : ''}</small>
                {Date.now() - l.createdAt < 24 * 3600e3 && <div><button class="secondary small" onClick={() => remove(l.id)}>Delete</button></div>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
