# Averqo

GST invoicing, expenses, time tracking, GST returns, and reports for small
businesses in India. Built with **Angular** (website), **Go** (server), and
**MySQL** (database). It runs free in a **GitHub Codespace** for building and
trying it out, and on any server with Docker for real use.

One Averqo installation holds one business, with as many team members as you
like.

## What you can do

**Sales**
- **Customers** with GSTIN (checked, including its check digit), GST
  treatment, and state. Every customer has a printable **statement** of
  account, with opening balance, invoices, payments, credits, and a running
  balance.
- **Items**: goods and services with HSN/SAC, unit, rate, and GST rate.
- **Quotes**, **delivery challans**, **invoices**, **credit notes**, and
  **recurring invoices**, all in one editor with live CGST/SGST/IGST.
- **Payments received**: one payment can settle several invoices.
- **PDFs** with a UPI QR code, **email** through your own mail account, and
  **WhatsApp** sharing.

**Costs and time**
- **Expenses**:
  - Categories you can manage, and vendors that are remembered.
  - Enter the amount **including or before GST**. Averqo splits it into CGST +
    SGST or IGST from the vendor's state (read from their GSTIN).
  - Mark whether you can **claim the GST back** (input tax credit), and flag
    **reverse charge** purchases.
  - Attach the **receipt** (JPG, PNG, WebP, or PDF up to 5 MB).
  - Mark an expense **billable** to a customer, with an optional markup.
- **Time tracking**:
  - **Projects** per customer, each with an hourly rate, SAC code, GST rate,
    and budget.
  - A **start/stop timer**. It keeps running if you close the page and shows
    in the top bar.
  - A **weekly timesheet**, and "log time" for work you didn't time.
- **Unbilled work shows up automatically.** When you start an invoice for a
  customer, Averqo offers their unbilled hours and billable expenses as lines.
  Once invoiced they can't be billed twice. Removing the line, deleting the
  draft, or voiding the invoice makes them unbilled again.

**Tax and insight**
- **GST filing**, for any month or quarter (Settings decides which):
  - **GSTR-1**, table by table:
    - B2B, B2C (large), B2C (small), and exports.
    - Credit notes to registered and unregistered buyers.
    - Nil-rated supplies.
    - The HSN summary, split into B2B and B2C.
    - Documents issued.
  - A **CSV** for each GSTR-1 table, laid out like the GST offline tool, and a
    **GSTR-1 JSON** file to upload on the portal.
  - **GSTR-3B**: outward supplies, reverse charge, inter-state sales to
    unregistered buyers, eligible input tax credit, and **how the credit pays
    your tax**, in the order the law requires, with the cash to pay.
  - **Checks before you file**, such as missing HSN codes, drafts dated in the
    period, or expenses whose GST can't be claimed without the vendor's GSTIN.
  - **Mark as filed** with the date and ARN. Invoices and credit notes in a
    filed GSTR-1 period are then locked, so filed figures can't drift.
- **Reports**, each with a date range, print, and CSV export:
  - Sales: by customer, by item, by month, and invoice details.
  - Receivables: receivables aging, customer balances, and payments received.
  - Expenses: by category, and expense details.
  - Accounting and tax: profit and loss, and a GST tax summary.
  - Time: time by project.

**Everywhere**
- **Sign-in** for every page, with an **owner** and **staff**. Staff do the
  everyday work. Only owners change business settings and manage the team.
- **Ctrl K** (Cmd K on Mac) to search or jump anywhere.
- **Export CSV** on every list.

## Upgrading from Invoxa (phase 2)

Your data is kept. The database is upgraded automatically the first time the
new server starts.

1. Upload `averqo.zip` to the root of your repository in the Codespace (drag it
   into the Explorer panel).
2. In the terminal, from the repository root:

   ```bash
   rm -rf frontend/src frontend/dist backend
   unzip -o averqo.zip && rm averqo.zip
   cd backend && go mod tidy && cd ..
   cd frontend && npm install && cd ..
   ```

   The `rm -rf` line removes old code and old build output only. Your data
   lives in MySQL, not in these folders. It's needed because unzip never
   deletes old files.
3. Start the app (next section). The server log shows
   `applying migration 004_averqo_phase3_4.sql` once.
4. Open the website. You'll see **Create the owner account**. Do this straight
   away, before sharing the link with anyone, because until an owner exists
   anyone who opens the page can create it.

Commit when it's working:

```bash
git add -A && git commit -m "Upgrade to Averqo" && git push
```

You can also rename your GitHub repository to Averqo (on GitHub: Settings,
then General). This is optional.

## Starting the app in a Codespace (every time)

Open two terminals:

```bash
# Terminal 1: server on port 8080 (upgrades the database automatically)
cd backend && go run .

# Terminal 2: website on port 4200
cd frontend && npm start
```

Open the **Ports** tab and click the globe icon next to port **4200**.

## Production mode: one server

For real use, Averqo runs as a single program that serves both the website and
the API on one port:

```bash
cd frontend && npm run build && cd ..
cd backend && go build -o averqo . && ./averqo
```

Open port **8080**. The server finds the built website in
`frontend/dist/frontend/browser` by itself. It shuts down cleanly on Ctrl C
or SIGTERM, and adds the browser security headers a public site needs.

## Putting it on the internet

A Codespace is for building and testing. It stops when idle and isn't meant to
host a live website. For real use, run Averqo on a server with Docker (any
small VPS works):

1. Copy the project to the server, then copy `.env.example` to `.env` and
   change every password and the `SETUP_CODE` in it.
2. Start it:

   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```

3. Put HTTPS in front of port 8080 with a reverse proxy such as Caddy or
   Nginx, pointing your domain at it. Averqo then marks its sign-in cookie
   secure (`COOKIE_SECURE=true`).
4. Open your domain and create the owner account. The setup page asks for the
   `SETUP_CODE` from `.env`, so nobody else can claim your installation.

MySQL data is kept in the `averqo-db` Docker volume. Back it up regularly (see
below).

**Server settings** (environment variables): `DB_HOST`, `DB_PORT`, `DB_USER`,
`DB_PASSWORD`, `DB_NAME`, `PORT` (default 8080), `STATIC_DIR` (the built
website), `SETUP_CODE`, `COOKIE_SECURE`, and `TRUST_PROXY=1` (only when
behind a reverse proxy, so it sees real visitor addresses).

## Security

- Passwords are stored as PBKDF2-SHA256 hashes (600,000 rounds, random salt),
  never as text.
- Sign-ins last 30 days of use. The cookie is HttpOnly and SameSite, and only
  a hash of it is stored.
- Changing your password signs out your other devices. Turning off a team
  member signs them out at once.
- After 10 wrong passwords for an email (or 50 from one address) in 15
  minutes, sign-in is paused.
- Every change needs a header that other websites can't send (cross-site
  request protection).
- Security headers are set: a strict Content-Security-Policy, framing blocked,
  no MIME sniffing, and HSTS on HTTPS.
- Receipts are checked by their content (not their name) and served in a
  sandbox.

## GST: please read

- Averqo works out GST from your state and the customer's state (the place of
  supply): CGST + SGST within the state, IGST across states or for exports.
- Expenses use the vendor's state (from their GSTIN) to split input GST. Input
  tax credit is counted only when "claim this GST back" is ticked **and** the
  vendor's GSTIN is filled in (or it's a reverse charge purchase).
- B2C (large) uses the ₹1,00,000 limit in force since 1 August 2024.
- 0% lines are reported as nil-rated. If some are exempt or non-GST, move
  them on the portal.
- The **GSTR-1 JSON** follows the GST portal's published format, but it
  hasn't been tested against the live portal. The portal validates every
  upload and shows each table before you submit. If it rejects the file, use
  the CSV files with the GST offline tool, or enter the figures by hand.
- **GSTR-3B** figures are a guide. Always match input tax credit with
  **GSTR-2B** on the portal before filing.
- Averqo doesn't file returns for you (that needs a licensed GST Suvidha
  Provider), and it doesn't create e-invoices (IRN) or e-way bills.
- **Have your accountant review your first filing** and your HSN/SAC codes.

## Project layout

```
.devcontainer/          Codespace setup (Go, Node, MySQL container)
Dockerfile              Production image (website + server)
docker-compose.prod.yml Production: Averqo + MySQL
.env.example            Settings for production (copy to .env)
db/schema.sql           Creates the empty database in the Codespace
backend/
  main.go static.go     Start-up, routes, website serving, security headers
  auth.go               Sign-in, sessions, team, password hashing
  migrate.go migrations/ Database upgrades, applied once each
  customers.go items.go invoices.go payments.go documents.go recurring.go
  expenses.go           Expenses, receipts, categories, vendors
  timetracking.go       Projects, timesheet, timer, unbilled work
  gstfiling.go          GSTR-1, GSTR-1 JSON, GSTR-3B, checks, filed periods
  reports.go            Reports and customer statements
  pdf.go email.go       PDFs and email
  *_test.go             Unit tests: `go test ./...`
frontend/src/app/
  core/                 API client, sign-in, timer, models, helpers
  shell/                Ctrl K command palette
  shared/               Line editor, customer picker, send dialog, etc.
  pages/                One folder per module
frontend/src/styles.css The Averqo design system, including print styles
```

## API

Everything is under `/api` and needs a signed-in session, except `health`,
`auth/status`, `auth/login`, and `auth/setup`. Requests that change data
must send an `X-Requested-With` header.

- **Sign-in and team**: `auth/*` and `users`.
- **Settings and lookups**: `organization`, `meta`, `dashboard`, and `search`.
- **Sales**: `customers` (plus `/{id}/statement` and `/{id}/unbilled`),
  `items`, `invoices`, `quotes`, `challans`, `credit-notes`, `recurring`, and
  `payments`.
- **Costs and time**: `expenses` (plus `/{id}/receipt`), `expense-categories`,
  `vendors`, `projects`, `time-entries`, and `timer`.
- **GST**: `gst/gstr1`, `gst/gstr1.json`, `gst/gstr3b`, and `gst/returns`.
- **Reports**: `reports/{key}`.

## Backing up the data

```bash
# Codespace
mysqldump -h db -u invoice -pinvoicepass invoicedb > backup.sql
# Docker server
docker compose -f docker-compose.prod.yml exec db sh -c 'mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" averqo' > backup.sql
```

Receipts are stored in the database, so the backup includes them. Deleting a
Codespace deletes its database, so keep backups of anything important.

## Troubleshooting

- **"Can't reach the Averqo server"**: terminal 1 isn't running. Start it with
  `cd backend && go run .`.
- **The website shows a 502 error in the Codespace**: make sure you ran
  `npm install` after unzipping. The start script listens with `--host ::`,
  which Codespaces needs.
- **"lookup db: no such host"** when the server starts: the MySQL container
  isn't running. Use Codespaces: Rebuild Container.
- **Forgot your password**: another owner can set a new one in Settings, then
  Team. If you're the only owner, ask for help resetting it in the database.
- **"This request was blocked for security"**: reload the page. It appears if
  a page was open from before the upgrade.
- **"GSTR-1 for … is marked as filed"**: that period is locked. Unmark it on
  the GST filing page if you really need to change it, or issue a credit note
  in the current period.
- **Build errors, or port 8080 shows an old version**: make sure you ran the
  `rm -rf frontend/src frontend/dist backend` step, then `npm run build` again
  if you use production mode.

## Free tier

GitHub Free includes 120 core-hours a month of Codespaces (60 hours on the
default 2-core machine) and 15 GB of storage. Stop the codespace when you're
done (Codespaces menu, then **Stop Current Codespace**).
