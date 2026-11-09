# Setting up Budget Guy

This guide is click-by-click, and you don't need to be a developer to follow it. It takes about 15 minutes.
**You never need to paste a password, API key or token anywhere except the Cloudflare and GitHub websites themselves.**

What you'll end up with:

- The app at `https://budget-game.<your-subdomain>.workers.dev`, which only your email can open.
- It updates itself whenever the `main` branch on GitHub changes.
- An icon on your iPhone home screen.

Cloudflare's menus move around now and then. If a button isn't exactly where this guide says, use the search box at the top of the Cloudflare dashboard.

---

## Already done for you

- **GitHub → Cloudflare is connected.** Your Worker is called `budget-game`, and the code matches that name.
- **The database creates itself.** On the first deploy, Cloudflare makes a D1 database called `budget-game-db` and attaches it, and the app creates its own tables the first time it's opened. There's no ID to copy.
- **Every merge to `main` deploys automatically.**

If a deploy ever fails with a D1 "permission" or "authentication" error, Cloudflare's build robot isn't allowed to create databases on your account. Do this once, then press **Retry build**:
1. Go to **Workers & Pages → budget-game → Bindings → Add binding → D1 database**.
2. Set the **Variable name** to `DB`.
3. Choose **Create new** (or pick `budget-game-db` if it exists), then **Add binding**.

## 1. Lock it to your email with Cloudflare Access

### 1a. Turn on Zero Trust (first time only)

1. In the left menu, click **Zero Trust**.
2. If asked, choose a **team name** (for example `ollie-budget`). Your *team domain* becomes `ollie-budget.cloudflareaccess.com`.
3. Choose the **Free** plan. Cloudflare may ask for a payment card to activate it, but the free plan costs $0.

### 1b. Protect the Worker, including previews

1. Go back to **Workers & Pages** and click **budget-game**.
2. Open the **Access** tab.
3. Click **Protect this Worker behind Access**.
4. Choose **All traffic**, not "Previews only". This covers the main URL *and* every preview URL.
5. Under **Authentication policy**, choose **Cloudflare account**, which means only members of your Cloudflare account.
6. Click **Apply Access**.

### 1c. Restrict it to exactly one email

1. Go to **Zero Trust → Access controls → Applications**.
2. Find the application for **budget-game**, open its **⋯** menu and click **Edit** (or **Configure**).
3. Open **Policies** and edit the policy:
   - **Action:** Allow
   - **Include:** choose **Emails** and type your email address.
   - Remove every other rule, such as "Cloudflare account" or any "Email domain", so your email is the only rule.
   - Click **Save**.
4. Check **Login methods**. **One-time PIN** should be on: Cloudflare emails you a code to sign in.
5. Open **Additional settings** (in some versions this is under **Overview / Basic information**).
   - Copy the **Application Audience (AUD) Tag**, a long code, and keep it for step 2.
6. Go to **Zero Trust → Settings** and note your **Team domain**, for example `ollie-budget.cloudflareaccess.com`.

## 2. Add the app's settings (variables)

The app checks every request itself as well, using these three values. It refuses to work until all three are set.

1. Go to **Workers & Pages → budget-game → Settings → Variables and Secrets**.
2. Click **Add** and add these three. Choose type **Secret** for each, so they stay hidden and are never wiped by a redeploy:

   | Variable name | Value |
   |---|---|
   | `TEAM_DOMAIN` | your team domain, e.g. `ollie-budget.cloudflareaccess.com` |
   | `POLICY_AUD` | the AUD tag from step 1c |
   | `ALLOWED_EMAIL` | the same email you put in the Access policy |

3. Click **Deploy** (or **Save and deploy**).

Never add a variable called `LOCAL_DEV`. It is only for running on your own computer. Even if it were set, it only works on `localhost` addresses.

## 3. Open the app (the database sets itself up)

1. Open `https://budget-game.<your-subdomain>.workers.dev` in your browser.
2. Cloudflare asks for your email, sends you a code, and you type it in.
3. The app loads and your sprout appears at 70.

The first time you open it, the app creates its own database tables. That is the "migration": there's nothing to run. To check it worked, go to **Storage & databases → D1 → budget-game-db → Tables**. You should see `transactions`, `uploads`, `creatures` and others.

**If the tables are missing (fallback):** open **D1 → budget-game-db → Console**. Open `migrations/0001_init.sql` on GitHub, click **Raw**, copy everything, paste it into the Console and click **Execute**. It's safe to run more than once.

**Check the lock works:** open the URL in a private window and try a different email. It should be refused.

## 4. Add it to your iPhone home screen

1. On your iPhone, open **Safari**. It must be Safari, not Chrome.
2. Go to `https://budget-game.<your-subdomain>.workers.dev` and sign in with the email code.
3. Tap the **Share** button (the square with an arrow pointing up).
4. Scroll down and tap **Add to Home Screen**, then **Add**.
5. Open it from the new icon. It runs full-screen like an app. The home-screen app keeps its own sign-in, so you may need to enter an email code once more inside it.

## 5. First-time setup inside the app

1. **Settings:**
   - Set your sprout's **name**.
   - Choose your **savings account** (or type a savings payee word).
   - Type **your name as banks print it**, which helps spot transfers between your own accounts.
   - Check the **GBP → USD** rate (default 1.33).
   - Tap **Save settings**.
2. **Settings → Import history (CSV):** choose `budget_guy_seed_transactions.csv`. This teaches payee rules and fills History. It never changes health.
3. **Upload:** pick this week's ABA 812, ABA 013 and Revolut 554 PDFs (and ABA 811 if you like). The first upload for each account sets its starting balance.

Every week after that, upload all statements by **Sunday 8pm** (Phnom Penh time). If you miss it, upload anyway: the −25 stays, but the week is still scored once its statements are in. Spending that won't be on any statement (for example a friend paid on their card) can be added by hand on the Upload screen.

---

## Running it on a computer (optional)

You need [Node.js 22](https://nodejs.org) installed. In a terminal, in the project folder:

```bash
npm install
```

```bash
npm run dev
```

Then open <http://localhost:8787>. This uses a local test database and **fake** data. Fake statements to try uploading are written to the `sample-data/` folder, which git ignores.

Run the tests:

```bash
npm test
```

To also check against your real statements, put copies in `private-fixtures/` (see the README there). That folder is never committed.

---

## Troubleshooting

**Cloudflare's bot opens a pull request to rename the Worker.** You shouldn't see this any more, because the code now uses `budget-game`. If one does appear, close it without merging.

**The deploy fails with a D1 permission or authentication error.** See "Already done for you" at the top: add the `DB` binding once in the dashboard, then retry the build.

**The app says "Server is missing TEAM_DOMAIN, POLICY_AUD or ALLOWED_EMAIL".** Step 6 isn't finished. The app refuses everything until all three are set.

**Branch previews show "This is a preview build. It has no database".** That's on purpose: previews can never touch your real data.
