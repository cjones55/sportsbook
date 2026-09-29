# Sportsbook

A private, credit-based sportsbook. The bookie shares one link; clients log in, see real
lines (DraftKings first, via The Odds API), and place straight bets, parlays or teasers with their
credit. The admin login manages clients, credit, bets, grading and settings. All amounts are USD credit.

No dependencies: Node 22.5+ and its built-in SQLite.

## Run it

```bash
cp .env.example .env      # set ADMIN_PASSWORD, optionally ODDS_API_KEY
npm start                 # http://localhost:3000
npm test                  # API tests
```

The first start creates the admin account from `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

## What's in it

**Clients**: odds board by sport (spread, moneyline, total), bet slip with straight bets,
parlays or teasers (6, 6.5 or 7 points on football and basketball spreads and totals, 2 to 6 legs), open and settled bets, credit history, password change. Works on phones.

**Admin**
- Dashboard: book profit, open action, max liability, share link.
- Clients: create logins, add or remove credit, give free play (bets with it pay profit only; a push returns the free play), per-client max bet, reset passwords, suspend, private notes.
- Bets: every bet; grade each pick Won / Lost / Push / Void by hand, or void a whole bet. Re-grading a settled bet corrects the client's credit automatically.
- Risk: open action per game and side.
- Ledger: every credit movement.
- Settings: book name, pause betting, min/max bet, max payout, parlay size, teaser payout table, self sign-up with invite code, odds API key, which sports show.

**Odds**: [The Odds API](https://the-odds-api.com) supplies lines from DraftKings, FanDuel,
BetMGM, Caesars and BetRivers (preference order is editable). Without a key the book runs on demo
odds. Lines are cached (default 30 minutes per sport) to save quota; the free plan is 500
requests a month and one sport refresh costs about 3, so a busy book will want the paid plan.
Bets are checked against the current line when placed; if the price moved, the client is
shown the new price. Games that already started can't be bet.

**Grading**: every 15 minutes the server pulls final scores for games with open bets and
grades them. Tennis and anything the scores feed doesn't cover gets graded by hand in Admin > Bets.

## Hosting

Any host that runs Node 22+ and keeps a persistent disk works (Render with a disk, Railway
with a volume, Fly.io with a volume, or a small VPS). Set `DATA_DIR` to the persistent disk
so the database survives restarts, and set `ADMIN_PASSWORD` and `ODDS_API_KEY` as environment
variables. Start command: `npm start`. Health check: `/healthz`.
