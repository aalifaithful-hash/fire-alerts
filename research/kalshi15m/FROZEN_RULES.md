# Frozen rules (committed before the test set was run)

**Deviation from pre-registration:** when these rules were frozen, candles had finished downloading only for BTC, ETH and EUR/USD. Rules were developed on those three. Gold, WTI, SOL and XRP were not looked at at all. They will serve as a second, fully unseen check once downloaded.

**Common execution for every rule:** at most one entry per market. The rule checks each listed minute from earliest to latest and enters at the first minute whose quote passes. The quote must be valid (ask < 0.99, bid > 0.01, spread ≤ 5¢). The order pays the ask (+ slippage) and takes Kalshi's taker fee. Contracts = floor($20 / (price + 0.02)). The position is held to settlement with no early exit. The bankroll is $1,000 with fixed stakes, and at most $100 can be open at once.

| Rule | Market | Side | When (minutes before close) | Pay | Skip if |
|---|---|---|---|---|---|
| R1 "tie-rule YES" | KXEURUSD15M | YES | first of 9…3 | YES ask in [0.20, 0.95) | price outside the band, or invalid quote |
| R2 "favourite" | KXBTC15M, KXETH15M | whichever side is priced ≥ the other | first of 14…6 | that side's ask in [0.80, 0.95) | price outside the band, or invalid quote |
| R3 "other bot" (control) | all three | NO | 2 | NO ask in [0.60, 0.99) | price outside the band, or invalid quote |

**Development results** (per contract, after fees, 0 slippage):
- R1: 1,557 trades, −0.14¢ per contract, +$166 total.
- R2: 5,670 trades, −0.09¢ per contract, −$59 total.
- R3: 2,681 trades, −1.03¢ per contract, −$651 total.

None was clearly profitable on development data. They are tested anyway, because the protocol requires that each frozen rule be reported.
