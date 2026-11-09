# Private fixtures (never committed)

Everything in this folder except this README is ignored by git.

Drop your real files here to run the extra checks in `tests/private.test.ts`:

| File name | What it checks |
|---|---|
| `aba-812.pdf` | ABA 812, 5 Aug–31 Oct: 849 rows, in 9,565.64, out 9,146.68, closing 418.96 |
| `revolut.pdf` | Revolut: 433 rows; section 1 out 11,834.75 / in 10,219.34 / closing 57.56; section 2 out 9,269.99 / in 9,232.59 / closing 20.16 |
| `budget_guy_seed_transactions.csv` | Sep–Oct spending averages $3,968/month (excluding Transfer and Investing) |

Missing files are skipped, not failed. Run `npm test`.
