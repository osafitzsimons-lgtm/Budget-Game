# Setting up Budget Guy

This guide is click-by-click, and you don't need to be a developer to follow it. It takes about 30 minutes.
**You never need to paste a password, API key or token anywhere except the Cloudflare and GitHub websites themselves.**

What you'll end up with:

- The app at `https://budget-guy.<your-subdomain>.workers.dev`, which only your email can open.
- It updates itself whenever the `main` branch on GitHub changes.
- An icon on your iPhone home screen.

Cloudflare's menus move around now and then. If a button isn't exactly where this guide says, use the search box at the top of the Cloudflare dashboard.

---

## 1. Merge the pull request

1. Open the repository on GitHub: **osafitzsimons-lgtm/Budget-Game**.
2. Click **Pull requests** and open **"Build budget-guy…"**.
3. Click **Merge pull request**, then **Confirm merge**.

## 2. Create the database (D1)

1. Go to <https://dash.cloudflare.com> and sign in, or create a free account.
2. In the left menu, click **Storage & databases → D1 SQL database**.
3. Click **Create Database**.
4. For **Name**, type `budget-guy-db`. For **Location**, choose **Asia-Pacific** if it asks.
5. Click **Create**.
6. On the database page, find **Database ID** (a long code like `1a2b3c4d-…`) and click the copy icon next to it.

## 3. Tell the app which database to use

1. On GitHub, open the repository and click the file **`wrangler.jsonc`**.
2. Click the **pencil icon** (Edit this file).
3. Find the line `"database_id": "REPLACE-WITH-YOUR-D1-DATABASE-ID"`.
4. Replace `REPLACE-WITH-YOUR-D1-DATABASE-ID` with the ID you copied. Keep the quote marks.
5. Click **Commit changes…**, choose **Commit directly to the main branch**, then **Commit changes**.

The database ID is not a secret, so it is fine for it to be in the repository.

## 4. Connect GitHub to Cloudflare (Workers Builds)

1. In Cloudflare, click **Compute (Workers) → Workers & Pages** in the left menu.
2. Click **Create application**.
3. Choose **GitHub** under *Import a repository* (it may be labelled **Connect GitHub**).
4. A GitHub window opens asking to install **Cloudflare Workers and Pages**:
   - Choose **Only select repositories**, pick **Budget-Game**, and click **Install & Authorize**.
5. Back in Cloudflare, select the **Budget-Game** repository.
6. Fill in the settings:
   - **Project name / Worker name:** `budget-guy`. It must be exactly this, or the build fails.
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy` (the default)
   - **Root directory / Path:** leave empty (`/`)
   - **Production branch:** `main`
   - Leave the **Preview command** as `npx wrangler preview`. Branch previews are set up with **no database**, so a preview can never touch your real data.
7. Click **Save and Deploy**, then wait for the build to finish (a few minutes).
8. When it finishes, the Worker page shows a URL like `https://budget-guy.<your-subdomain>.workers.dev`.
   **Don't add anything yet.** Opening it now just shows "Server is missing TEAM_DOMAIN…". That's expected: the app refuses everything until step 6 is done.

## 5. Lock it to your email with Cloudflare Access

### 5a. Turn on Zero Trust (first time only)

1. In the left menu, click **Zero Trust**.
2. If asked, choose a **team name** (for example `ollie-budget`). Your *team domain* becomes `ollie-budget.cloudflareaccess.com`.
3. Choose the **Free** plan. Cloudflare may ask for a payment card to activate it, but the free plan costs $0.

### 5b. Protect the Worker, including previews

1. Go back to **Workers & Pages** and click **budget-guy**.
2. Open the **Access** tab.
3. Click **Protect this Worker behind Access**.
4. Choose **All traffic**, not "Previews only". This covers the main URL *and* every preview URL.
5. Under **Authentication policy**, choose **Cloudflare account**, which means only members of your Cloudflare account.
6. Click **Apply Access**.

### 5c. Restrict it to exactly one email

1. Go to **Zero Trust → Access controls → Applications**.
2. Find the application for **budget-guy**, open its **⋯** menu and click **Edit** (or **Configure**).
3. Open **Policies** and edit the policy:
   - **Action:** Allow
   - **Include:** choose **Emails** and type your email address.
   - Remove every other rule, such as "Cloudflare account" or any "Email domain", so your email is the only rule.
   - Click **Save**.
4. Check **Login methods**. **One-time PIN** should be on: Cloudflare emails you a code to sign in.
5. Open **Additional settings** (in some versions this is under **Overview / Basic information**).
   - Copy the **Application Audience (AUD) Tag**, a long code, and keep it for step 6.
6. Go to **Zero Trust → Settings** and note your **Team domain**, for example `ollie-budget.cloudflareaccess.com`.

## 6. Add the app's settings (variables)

The app checks every request itself as well, using these three values. It refuses to work until all three are set.

1. Go to **Workers & Pages → budget-guy → Settings → Variables and Secrets**.
2. Click **Add** and add these three. Choose type **Secret** for each, so they stay hidden and are never wiped by a redeploy:

   | Variable name | Value |
   |---|---|
   | `TEAM_DOMAIN` | your team domain, e.g. `ollie-budget.cloudflareaccess.com` |
   | `POLICY_AUD` | the AUD tag from step 5c |
   | `ALLOWED_EMAIL` | the same email you put in the Access policy |

3. Click **Deploy** (or **Save and deploy**).

Never add a variable called `LOCAL_DEV`. It is only for running on your own computer. Even if it were set, it only works on `localhost` addresses.

## 7. Open the app (the database sets itself up)

1. Open `https://budget-guy.<your-subdomain>.workers.dev` in your browser.
2. Cloudflare asks for your email, sends you a code, and you type it in.
3. The app loads and your sprout appears at 70.

The first time you open it, the app creates its own database tables. That is the "migration": there's nothing to run. To check it worked, go to **Storage & databases → D1 → budget-guy-db → Tables**. You should see `transactions`, `uploads`, `creatures` and others.

**If the tables are missing (fallback):** open **D1 → budget-guy-db → Console**. Open `migrations/0001_init.sql` on GitHub, click **Raw**, copy everything, paste it into the Console and click **Execute**. It's safe to run more than once.

**Check the lock works:** open the URL in a private window and try a different email. It should be refused.

## 8. Add it to your iPhone home screen

1. On your iPhone, open **Safari**. It must be Safari, not Chrome.
2. Go to `https://budget-guy.<your-subdomain>.workers.dev` and sign in with the email code.
3. Tap the **Share** button (the square with an arrow pointing up).
4. Scroll down and tap **Add to Home Screen**, then **Add**.
5. Open it from the new icon. It runs full-screen like an app. The home-screen app keeps its own sign-in, so you may need to enter an email code once more inside it.

## 9. First-time setup inside the app

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

**The Worker is called something other than `budget-guy` (e.g. `budget-game`).**
If you connected the repository before naming the Worker, Cloudflare may have named it after the repository. Its builds then quietly deploy under that name, so the app lives at `budget-game.<you>.workers.dev`.
- Fix it in the dashboard: **Workers & Pages → (your Worker) → Settings → General → Name** → change it to `budget-guy`.
- If renaming isn't offered, delete that Worker and redo step 4, typing `budget-guy`.
- If Cloudflare's bot opens a pull request changing the name in `wrangler.jsonc` to anything else, close it without merging.
- After renaming, set up Access (step 5) and the variables (step 6) for `budget-guy`, if you had done them on the old Worker.

**The deploy fails with a database error.** Check step 3: `wrangler.jsonc` must contain your real D1 Database ID, not `REPLACE-WITH-YOUR-D1-DATABASE-ID`.

**The app says "Server is missing TEAM_DOMAIN, POLICY_AUD or ALLOWED_EMAIL".** Step 6 isn't finished. The app refuses everything until all three are set.

**Branch previews show "This is a preview build. It has no database".** That's on purpose: previews can never touch your real data.
