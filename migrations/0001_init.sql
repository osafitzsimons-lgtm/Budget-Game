-- Generated from src/worker/schema.ts by `npm run schema`. Safe to run more than once.
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, bank TEXT NOT NULL, last3 TEXT NOT NULL, label TEXT NOT NULL, optional INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, uploaded_at INTEGER NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, opening REAL NOT NULL, closing REAL NOT NULL, currency TEXT NOT NULL, row_count INTEGER NOT NULL, new_rows INTEGER NOT NULL, ok INTEGER NOT NULL, baseline INTEGER NOT NULL, checks TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS uploads_account ON uploads(account_id, uploaded_at);
CREATE TABLE IF NOT EXISTS transactions (hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, bank TEXT NOT NULL, source TEXT NOT NULL, date TEXT NOT NULL, time TEXT, payee TEXT NOT NULL, amount_orig REAL NOT NULL, currency TEXT NOT NULL, amount_usd REAL NOT NULL, balance REAL, category TEXT NOT NULL, savings INTEGER NOT NULL DEFAULT 0, is_cash INTEGER NOT NULL DEFAULT 0, upload_id TEXT, seq INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS tx_account ON transactions(account_id, date);
CREATE TABLE IF NOT EXISTS payee_rules (key TEXT PRIMARY KEY, category TEXT NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, date TEXT NOT NULL, amount_usd REAL NOT NULL, what TEXT NOT NULL, why TEXT NOT NULL, kind TEXT NOT NULL, category TEXT, urgent INTEGER NOT NULL DEFAULT 0, cash_tx_hash TEXT);
CREATE INDEX IF NOT EXISTS logs_date ON logs(date);
CREATE TABLE IF NOT EXISTS creatures (id INTEGER PRIMARY KEY, name TEXT NOT NULL, born_at INTEGER NOT NULL, died_at INTEGER, start_health INTEGER NOT NULL, health INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS score_events (id INTEGER PRIMARY KEY AUTOINCREMENT, creature_id INTEGER NOT NULL, week_start TEXT NOT NULL, kind TEXT NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, health_after INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS week_evals (week_start TEXT PRIMARY KEY, evaluated_at INTEGER NOT NULL, early INTEGER NOT NULL);
INSERT OR IGNORE INTO accounts (id, bank, last3, label, optional, active, sort) VALUES ('ABA-812', 'ABA', '812', 'ABA 812', 0, 1, 1), ('ABA-013', 'ABA', '013', 'ABA 013', 0, 1, 2), ('ABA-811', 'ABA', '811', 'ABA 811', 1, 1, 3), ('REV-554', 'REV', '554', 'Revolut 554', 0, 1, 4);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
