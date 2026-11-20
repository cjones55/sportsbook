# Sportsbook

A private, credit-based sportsbook. The bookie shares one link; clients log in, see real
lines (DraftKings first, via The Odds API), and place straight bets, parlays or teasers with their
credit. The admin login manages clients, credit, bets, grading and settings. All amounts are USD credit.

No dependencies: Node 22.13+ and its built-in SQLite.

## Run it

```bash
cp .env.example .env      # set ADMIN_PASSWORD, optionally ODDS_API_KEY
npm start                 # http://localhost:3000
npm test                  # API tests
```

The first start creates the admin account from `ADMIN_USERNAME` / `ADMIN_PASSWORD`. Changing either later (for example in Render > Environment) resets the admin login to the new values on the next start.

## What's in it

**Clients**: odds board by sport (spread, moneyline, total), bet slip with straight bets,
parlays or teasers (6, 6.5 or 7 points on football and basketball spreads and totals, 2 to 6 legs), props (a game's Props button, plus a Specials tab for the bookie's stand-alone props), open and settled bets, credit history, password change. Works on phones.

**Blackjack**: clients play blackjack against the house with their credit (6 decks shuffled every hand, dealer stands on soft 17, blackjack pays 3 to 2, double on any two cards, split up to 4 hands). Cards are dealt on the server and the dealer's hole card stays hidden until the hand ends. The admin sees every hand under Bets > Blackjack and on each client's page, blackjack profit counts toward book profit, and Settings has an on/off switch and min/max bet (default $1 to $100). An unfinished hand can be voided for a refund.

**Admin**
- Dashboard: book profit, open action, max liability, share link.
- Clients: create logins, add or remove credit, give free play (bets with it pay profit only; a push returns the free play), per-client max bet, reset passwords, suspend, private notes.
- Bets: every bet, plus a Blackjack tab with every hand; grade each pick Won / Lost / Push / Void by hand, or void a whole bet. Re-grading a settled bet corrects the client's credit automatically.
- Props: write your own props on a game (overtime? first score?) or stand-alone specials (MVP, futures), with your own odds. Pick the winner and every bet on it is graded; undo or void if needed.
- Risk: open action per game and side.
- Ledger: every credit movement.
- Settings: book name, pause betting, min/max bet, max payout, parlay size, teaser payout table, self sign-up with invite code, odds API key, which sports show.

**Odds**: [The Odds API](https://the-odds-api.com) supplies lines from DraftKings, FanDuel,
BetMGM, Caesars and BetRivers (preference order is editable). Without a key the book runs on demo
odds. Lines are cached (default 30 minutes per sport) to save quota; the free plan is 500
requests a month and one sport refresh costs about 3, so a busy book will want the paid plan.
Bets are checked against the current line when placed; if the price moved, the client is
shown the new price. Games that already started can't be bet.

**Props**: player and game props for NFL, college football, NBA, MLB and NHL come from the same feed
(football includes anytime TD, first TD scorer and 2+ TDs), plus alternate spreads and totals for NFL,
college football, NBA and college basketball, fetched
one game at a time only when someone opens that game's props (cached 60 minutes by default).
Each load costs about one request per prop market, roughly 6 to 8, so props use the free plan's 500
requests quickly; the $30 plan (20,000 a month) suits a small book. Alternate lines are graded automatically from final scores like the main lines. Props and alt lines can go in parlays, including
same-game parlays (several picks from one game; switch off in Settings), but not in teasers. A parlay with a prop in it
waits for the bookie to grade that pick. Without a key, demo props are shown.

**Profit boosts**: under Admin > Boosts the bookie creates boosts that raise a winning bet's profit
by a percentage (the stake is never boosted). Each boost can be limited to straight bets or parlays
(with a minimum number of picks), one sport, a max stake, a number of uses per client, an end time,
and everyone or one client. Clients see live boosts at the top of the board and pick one on the bet
slip. Boosts don't apply to teasers or free play. The Boosts page shows each boost's bets and how
much extra it has paid out.

**Grading**: every 15 minutes the server pulls final scores for games with open bets and
grades them. Tennis, props (the feed has no player stats) and anything else the scores feed
doesn't cover gets graded by hand in Admin > Bets (the "Props to grade" tab lists open props).

## Hosting

Any host that runs Node 22+ and keeps a persistent disk works (Render with a disk, Railway
with a volume, Fly.io with a volume, or a small VPS). Set `DATA_DIR` to the persistent disk
so the database survives restarts, and set `ADMIN_PASSWORD` and `ODDS_API_KEY` as environment
variables. Start command: `npm start`. Health check: `/healthz`.
