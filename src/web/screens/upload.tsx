import { useState } from 'preact/hooks';
import { ALL_CATEGORIES } from '../../shared/categories';
import { isSavingsMove } from '../../shared/categorise';
import { formatDate } from '../../shared/dates';
import { usd } from '../../shared/money';
import { contextFrom, findAccount, prepareStatement, type PreparedStatement } from '../../shared/statement';
import type { ProofResult } from '../../shared/types';
import type { ParsedStatement } from '../../parsers/index';
import { api, type AppState, type ConfirmResult } from '../api';
import type { ScreenProps } from '../app';
import { CreatureView, EventList } from '../components';
import { parsePdfFile } from '../pdf';

interface Item {
  key: string;
  fileName: string;
  status: 'parsing' | 'error' | 'ready' | 'saving' | 'done';
  error?: string;
  parsed?: ParsedStatement;
  prep?: PreparedStatement;
  accountLabel?: string;
  proof?: ProofResult;
  /** row index → reviewed (kept as is) */
  reviewed: Set<number>;
  changed: Set<number>;
  result?: ConfirmResult;
  showAll?: boolean;
}

const money = (n: number, cur: 'USD' | 'GBP') => (cur === 'GBP' ? `£${n.toFixed(2)}` : usd(n));

export function Upload({ state, reload }: ScreenProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [anim, setAnim] = useState<ConfirmResult | null>(null);
  const update = (key: string, f: (i: Item) => Item) => setItems((xs) => xs.map((x) => (x.key === key ? f(x) : x)));

  const ctx = contextFrom(state.rules, state.accounts, state.settings);

  async function onFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    // Copy now: the input is cleared straight after, which empties the live FileList.
    const files = [...fileList];
    setAnim(null);
    const fresh: Item[] = files.map((f, i) => ({ key: `${Date.now()}-${i}-${f.name}`, fileName: f.name, status: 'parsing', reviewed: new Set(), changed: new Set() }));
    setItems((xs) => [...xs.filter((x) => x.status !== 'done'), ...fresh]);
    const results: Item[] = [];
    for (let i = 0; i < files.length; i++) {
      const it = fresh[i];
      try {
        const parsed = await parsePdfFile(files[i]);
        const acct = findAccount(parsed, state.accounts);
        if (!acct) {
          throw new Error(`This is a ${parsed.bank === 'REV' ? 'Revolut' : 'ABA'} statement for the account ending ${parsed.accountLast3}, which isn't set up. Add it in Settings, or pick the right file.`);
        }
        const prep = await prepareStatement(parsed, acct.id, state.settings.fxGbpUsd, ctx);
        results.push({ ...it, status: 'ready', parsed, prep, accountLabel: acct.label });
      } catch (e) {
        results.push({ ...it, status: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }
    // Oldest first per account, so consecutive statements chain correctly.
    results.sort((a, b) => (a.prep?.summary.accountId ?? '').localeCompare(b.prep?.summary.accountId ?? '') || (a.prep?.summary.periodStart ?? '').localeCompare(b.prep?.summary.periodStart ?? ''));
    setItems((xs) => [...xs.filter((x) => !fresh.some((f) => f.key === x.key)), ...results]);
    for (const r of results) if (r.status === 'ready') void runCheck(r);
  }

  async function runCheck(it: Item) {
    if (!it.prep) return;
    try {
      const proof = await api.check(it.prep.summary, it.prep.rows);
      update(it.key, (x) => ({ ...x, proof }));
    } catch (e) {
      update(it.key, (x) => ({ ...x, status: 'error', error: e instanceof Error ? e.message : String(e) }));
    }
  }

  function setCategory(it: Item, idx: number, category: string) {
    update(it.key, (x) => {
      const rows = x.prep!.rows.slice();
      const r = { ...rows[idx], category };
      r.savings = (category === 'Transfer' || category === 'Investing') && (r.savings || isSavingsMove(r.payee, r.amountUsd, ctx));
      if (category !== 'Transfer' && category !== 'Investing') r.savings = false;
      rows[idx] = r;
      const changed = new Set(x.changed); changed.add(idx);
      const reviewed = new Set(x.reviewed); reviewed.add(idx);
      return { ...x, prep: { ...x.prep!, rows }, changed, reviewed };
    });
  }
  function setSavings(it: Item, idx: number, savings: boolean) {
    update(it.key, (x) => {
      const rows = x.prep!.rows.slice();
      rows[idx] = { ...rows[idx], savings };
      return { ...x, prep: { ...x.prep!, rows } };
    });
  }
  function toggleReviewed(it: Item, idx: number, v: boolean) {
    update(it.key, (x) => { const reviewed = new Set(x.reviewed); if (v) reviewed.add(idx); else reviewed.delete(idx); return { ...x, reviewed }; });
  }

  async function confirm(it: Item) {
    if (!it.prep) return;
    update(it.key, (x) => ({ ...x, status: 'saving' }));
    try {
      const rules = [...it.changed].map((i) => ({ payee: it.prep!.rows[i].payee, category: it.prep!.rows[i].category }));
      const result = await api.confirm(it.prep.summary, it.prep.rows, rules);
      update(it.key, (x) => ({ ...x, status: 'done', result, proof: result.proof }));
      if (result.events.length || result.healthBefore !== result.healthAfter) setAnim(result);
      const fresh = await reload();
      // Re-check the other statements: the next one for the same account now chains from this one.
      if (fresh) for (const other of items) if (other.key !== it.key && other.status === 'ready') void runCheck(other);
    } catch (e) {
      update(it.key, (x) => ({ ...x, status: 'ready', error: e instanceof Error ? e.message : String(e) }));
    }
  }

  return (
    <div>
      <h1>Upload statements</h1>
      {anim && (
        <div class="card">
          <CreatureView name={state.creature.name} before={anim.healthBefore} after={anim.healthAfter} died={anim.died} />
          {anim.events.length > 0 && <EventList events={anim.events} />}
        </div>
      )}
      <div class="card">
        <p>Pick this week's PDF statements (ABA and Revolut). They are read on this phone and never uploaded — only the transaction rows are saved.</p>
        <p class="muted">Missed a Sunday? Upload anyway: the missed week gets scored once its statements are in. Older statements can be added too, as long as their balances join up.</p>
        <label for="pdfs">Statement PDFs</label>
        <input id="pdfs" type="file" accept="application/pdf,.pdf" multiple onChange={(e) => { void onFiles((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ''; }} />
      </div>
      <ManualEntry state={state} reload={reload} />
      {items.map((it) => <StatementCard it={it} blockedBy={items.find((o) => o !== it && o.status !== 'done' && o.status !== 'error' && o.prep && it.prep && o.prep.summary.accountId === it.prep.summary.accountId && o.prep.summary.periodStart < it.prep.summary.periodStart)?.fileName} manual={state.manual} onCategory={setCategory} onSavings={setSavings} onReviewed={toggleReviewed} onConfirm={confirm} onToggleAll={() => update(it.key, (x) => ({ ...x, showAll: !x.showAll }))} onRemove={() => setItems((xs) => xs.filter((x) => x.key !== it.key))} />)}
    </div>
  );
}

interface CardProps {
  it: Item;
  /** an older statement for the same account that must be confirmed first */
  blockedBy?: string;
  manual: AppState['manual'];
  onCategory: (it: Item, idx: number, c: string) => void;
  onSavings: (it: Item, idx: number, v: boolean) => void;
  onReviewed: (it: Item, idx: number, v: boolean) => void;
  onConfirm: (it: Item) => void;
  onToggleAll: () => void;
  onRemove: () => void;
}

function StatementCard({ it, blockedBy, manual, onCategory, onSavings, onReviewed, onConfirm, onToggleAll, onRemove }: CardProps) {
  if (it.status === 'parsing') return <div class="card"><span class="spinner" /> Reading {it.fileName}…</div>;
  if (it.status === 'error' && !it.prep) {
    return (
      <div class="card">
        <div class="row space"><strong class="ellipsis grow">{it.fileName}</strong><button class="secondary small" onClick={onRemove}>Remove</button></div>
        <div class="notice bad">{it.error}</div>
      </div>
    );
  }
  const p = it.parsed!;
  const prep = it.prep!;
  const cur = p.currency;
  const needs = prep.rows.map((r, i) => ({ r, i })).filter(({ r }) => r.needsReview);
  const unreviewed = needs.filter(({ i }) => !it.reviewed.has(i)).length;
  const bigUnknown = prep.rows.filter((r) => r.category === 'Unidentified' && !r.isCash && r.amountUsd >= 10);
  const dupes = manual.filter((m) => prep.rows.some((r) => Math.abs(r.amountUsd - m.amountUsd) <= 0.01 && Math.abs(Date.parse(r.date) - Date.parse(m.date)) <= 2 * 86400e3));

  return (
    <div class="card">
      <div class="row space">
        <strong class="ellipsis grow">{it.accountLabel} · {formatDate(p.periodStart)} – {formatDate(p.periodEnd)}</strong>
        {it.status !== 'done' && <button class="secondary small" onClick={onRemove}>Remove</button>}
      </div>
      <small class="muted">{it.fileName}</small>
      <table style={{ marginTop: 8 }}>
        <tbody>
          <tr><td>Rows</td><td class="r">{p.rows.length}</td></tr>
          <tr><td>Opening</td><td class="r">{money(p.opening, cur)}</td></tr>
          <tr><td>Money in</td><td class="r">{money(p.totalIn, cur)}</td></tr>
          <tr><td>Money out</td><td class="r">{money(p.totalOut, cur)}</td></tr>
          <tr><td>Closing</td><td class="r">{money(p.closing, cur)}</td></tr>
          {cur === 'GBP' && <tr><td>Rate used</td><td class="r">£1 = ${prep.summary.fx}</td></tr>}
        </tbody>
      </table>
      {p.sections.length > 1 && (
        <details><summary>{p.sections.length} sections</summary>
          <table><thead><tr><th>#</th><th class="r">Out</th><th class="r">In</th><th class="r">Closing</th></tr></thead><tbody>
            {p.sections.map((s, i) => <tr><td>{i + 1}</td><td class="r">{money(s.totalOut, cur)}</td><td class="r">{money(s.totalIn, cur)}</td><td class="r">{money(s.closing, cur)}</td></tr>)}
          </tbody></table>
        </details>
      )}
      {p.notes.map((n) => <p class="muted">{n}</p>)}
      <p class="good">✓ Every balance check in the statement passed.</p>

      <h3>Proof</h3>
      {!it.proof ? <p><span class="spinner" /> Checking…</p> : (
        <ul class="plain">
          {it.proof.checks.map((c) => <li><span class={c.ok ? 'good' : c.blocking ? 'bad' : 'warn'}>{c.ok ? '✓' : c.blocking ? '✗' : '!'}</span> <strong>{c.label}</strong><br /><small>{c.detail}</small></li>)}
        </ul>
      )}
      {it.proof && !it.proof.ok && it.status !== 'done' && (
        <div class="notice bad">This statement fails the proof check. If you confirm, the attempt is recorded but no rows are saved, and it still counts as failing at the deadline (−25). Fix it by uploading a statement that covers the missing days — even after the deadline, the week then gets scored late.</div>
      )}
      {it.proof && <p class="muted">{it.proof.newRows} new rows; {p.rows.length - it.proof.newRows} already saved (skipped).</p>}

      {needs.length > 0 && it.status !== 'done' && (
        <>
          <h3>Review ({unreviewed} left)</h3>
          <p class="muted">Unknown payees of $10+ and money coming in. Pick a category or tick “looks right”. Your choice is remembered next time.</p>
          <ul class="plain">
            {needs.map(({ r, i }) => (
              <li>
                <div class="row space"><span class="ellipsis grow">{r.payee}</span><strong class={r.amountUsd < 0 ? 'good' : ''}>{usd(-r.amountUsd)}</strong></div>
                <small class="muted">{formatDate(r.date)}</small>
                <select aria-label={`Category for ${r.payee}`} value={r.category} onChange={(e) => onCategory(it, i, (e.target as HTMLSelectElement).value)}>
                  {ALL_CATEGORIES.map((c) => <option value={c}>{c}</option>)}
                </select>
                <label class="check"><input type="checkbox" checked={it.reviewed.has(i)} onChange={(e) => onReviewed(it, i, (e.target as HTMLInputElement).checked)} /> Looks right</label>
                {(r.category === 'Transfer' || r.category === 'Investing') && r.amountUsd > 0 && (
                  <label class="check"><input type="checkbox" checked={r.savings} onChange={(e) => onSavings(it, i, (e.target as HTMLInputElement).checked)} /> This went to savings</label>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {dupes.length > 0 && it.status !== 'done' && (
        <div class="notice warn">This statement has {dupes.length === 1 ? 'a row' : 'rows'} matching something you added by hand ({dupes.map((d) => `${usd(d.amountUsd)} ${d.payee}`).join('; ')}). If it's the same spending, delete the hand-added one so it isn't counted twice.</div>
      )}
      {bigUnknown.length > 0 && it.status !== 'done' && <p class="warn">{bigUnknown.length} row(s) will stay Unidentified (counts as negotiable spending).</p>}

      {it.status !== 'done' && (
        <>
          <button class="secondary full small" onClick={onToggleAll} style={{ marginTop: 8 }}>{it.showAll ? 'Hide all rows' : `Show all ${prep.rows.length} rows`}</button>
          {it.showAll && <AllRows it={it} onCategory={onCategory} />}
        </>
      )}

      {it.error && <div class="notice bad">{it.error}</div>}
      {it.status === 'done' && it.result ? (
        it.result.stored ? (
          <div class={`notice ${it.result.proof.covers ? 'good' : 'warn'}`}>Saved {it.result.inserted} new rows.{!it.result.proof.covers && ' It stops before last Saturday, so upload a newer statement too.'}</div>
        ) : <div class="notice bad">Recorded as a failed proof check. Nothing was saved.</div>
      ) : (
        <button class="full" style={{ marginTop: 12 }} disabled={!it.proof || unreviewed > 0 || it.status === 'saving' || !!blockedBy} onClick={() => onConfirm(it)}>
          {it.status === 'saving' ? 'Saving…' : blockedBy ? `Confirm ${blockedBy} first` : unreviewed > 0 ? `Review ${unreviewed} more to confirm` : it.proof?.ok ? 'Confirm' : 'Record failed attempt'}
        </button>
      )}
    </div>
  );
}

function AllRows({ it, onCategory }: { it: Item; onCategory: CardProps['onCategory'] }) {
  const [limit, setLimit] = useState(100);
  const rows = it.prep!.rows;
  return (
    <div>
      <ul class="plain">
        {rows.slice(0, limit).map((r, i) => (
          <li>
            <div class="row space"><small>{formatDate(r.date)}{r.time ? ` ${r.time}` : ''}</small><strong class={r.amountUsd < 0 ? 'good' : ''}>{usd(-r.amountUsd)}</strong></div>
            <div class="ellipsis">{r.payee}</div>
            <select aria-label={`Category for ${r.payee}`} value={r.category} onChange={(e) => onCategory(it, i, (e.target as HTMLSelectElement).value)}>
              {ALL_CATEGORIES.map((c) => <option value={c}>{c}</option>)}
            </select>
          </li>
        ))}
      </ul>
      {limit < rows.length && <button class="secondary full small" onClick={() => setLimit(limit + 200)}>Show more</button>}
    </div>
  );
}

const MONEY_IN = ['Friends paying back', 'Transfer', 'Investing'];

/** Spending that will never be on an uploaded statement (another card, a friend paid, etc.). */
function ManualEntry({ state, reload }: { state: AppState; reload: () => Promise<AppState | null> }) {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<'out' | 'in'>('out');
  const [date, setDate] = useState(state.today);
  const [payee, setPayee] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const amt = Number(amount);
  const cats = dir === 'in' ? MONEY_IN : ALL_CATEGORIES;
  const valid = Number.isFinite(amt) && amt > 0 && payee.trim() && category && date && date <= state.today;

  async function submit(e: Event) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.addManual({ date, payee, amountUsd: dir === 'in' ? -amt : amt, category });
      setMsg({ ok: true, text: `Added ${usd(amt)} ${dir === 'in' ? 'in' : ''} for ${payee}.${r.note ? ` ${r.note}` : ''}` });
      setPayee(''); setAmount(''); setCategory('');
      await reload();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
    setBusy(false);
  }
  async function remove(hash: string) {
    try { await api.deleteManual(hash); await reload(); } catch (err) { setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
  }

  return (
    <div class="card">
      <div class="row space">
        <h2 style={{ margin: 0 }}>Add a transaction by hand</h2>
        <button class="secondary small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Close' : 'Add'}</button>
      </div>
      {open && (
        <form onSubmit={submit}>
          <p class="muted">Only for spending that won't appear on an uploaded statement (another card, a friend paid and you owe them…). Spending counts towards the week like statement rows. It isn't proof: the weekly statements are still needed.</p>
          <div class="row">
            <button type="button" class={dir === 'out' ? '' : 'secondary'} onClick={() => { setDir('out'); setCategory(''); }}>Money out</button>
            <button type="button" class={dir === 'in' ? '' : 'secondary'} onClick={() => { setDir('in'); setCategory(''); }}>Money in</button>
          </div>
          <label for="m-date">Date</label>
          <input id="m-date" type="date" max={state.today} value={date} onInput={(e) => setDate((e.target as HTMLInputElement).value)} required />
          <label for="m-payee">What / where</label>
          <input id="m-payee" maxLength={120} value={payee} onInput={(e) => setPayee((e.target as HTMLInputElement).value)} required />
          <label for="m-amt">Amount (USD)</label>
          <input id="m-amt" type="number" inputMode="decimal" step="0.01" min="0.01" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} required />
          <label for="m-cat">Category</label>
          <select id="m-cat" value={category} onChange={(e) => setCategory((e.target as HTMLSelectElement).value)} required>
            <option value="">Pick…</option>
            {cats.map((c) => <option value={c}>{c}</option>)}
          </select>
          {dir === 'in' && <p class="muted">Money in added by hand shows in History but doesn't reduce your weekly spending — only statements can prove it.</p>}
          {dir === 'out' && (category === 'Transfer' || category === 'Investing') && <p class="muted">Savings only count when a statement shows them.</p>}
          <button class="full" style={{ marginTop: 12 }} disabled={!valid || busy}>{busy ? 'Adding…' : 'Add transaction'}</button>
        </form>
      )}
      {msg && <div class={`notice ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</div>}
      {state.manual.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary>Added by hand ({state.manual.length})</summary>
          <ul class="plain">
            {state.manual.map((m) => (
              <li>
                <div class="row space"><span class="ellipsis grow">{m.payee}</span><strong class={m.amountUsd < 0 ? 'good' : ''}>{usd(-m.amountUsd)}</strong></div>
                <small class="muted">{formatDate(m.date)} · {m.category}{m.savings ? ' · savings' : ''}</small>
                {Date.now() - m.createdAt < 24 * 3600e3 && <div><button class="secondary small" onClick={() => remove(m.hash)}>Delete</button></div>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
