# Kalshi 15-minute markets — pre-registered research protocol

Written 2026-11-19, before any outcome analysis. The only work done before this file was downloading data and checking its format.

## Data (public, no account)
- Kalshi public API `api.elections.kalshi.com/trade-api/v2`: settled markets, plus 1-minute candles holding the **closing yes_bid / yes_ask** of each minute.
  Live endpoints keep markets settled after 2026-09-19 (crypto lists go back to 2026-09-12). Earlier markets are in Kalshi's historical archive, which this study does not use.
- Coinbase Exchange public 1-minute candles for BTC/ETH/SOL/XRP-USD, used as a **stand-in** for CF Benchmarks' BRTI (the settlement index). BRTI itself is paid, so it is not used.
- Universe: KXBTC15M, KXETH15M, KXSOL15M, KXXRP15M (crypto), KXGOLD15M, KXWTI15M (commodities), KXEURUSD15M (FX).

## Split (fixed now)
- **Development:** markets with close_time < 2026-10-24T00:00Z.
- **Test (held out):** close_time ≥ 2026-10-24T00:00Z. Test outcomes are not examined until the rules below are frozen in `FROZEN_RULES.md` and committed.

## Execution model
- Decision at T−m minutes before close, using only the last candle with end_period_ts ≤ close−60·m. Forward-filling is allowed for up to 3 minutes; older quotes are treated as stale and the market is skipped.
- Buying YES pays yes_ask. Buying NO pays 1 − yes_bid (the NO ask).
- Skip when the ask is ≥ 0.99, the bid is ≤ 0.01 or the quoted spread is > 5¢ (thin or empty book).
- Taker fee per order: ceil_to_cent(0.07 × C × P × (1−P)). Contracts are whole numbers. Positions are held to settlement, so there is no exit fee; an early exit would pay a second taker fee at the bid.
- Slippage: the test is reported at +0¢, +1¢ and +2¢ on the entry price. This stands in for the unmodelled within-minute delay and order-book depth.
- Sizing: $1,000 simulated bankroll with **fixed** stakes and no compounding or increase after wins. Cost including fee is ≤ $20 per market (2%), and open exposure across concurrent markets is ≤ $100 (10%). When more signals arrive than fit, earlier entries win, then the series order above.

## Hypotheses
1. **H1 — Price calibration / favourite–longshot bias.** Late-window Kalshi prices are systematically miscalibrated, for example heavy favourites win more often than their price implies. *Disproved if* the realised win rate of each side/price/time bucket is within sampling error of price + fee.
2. **H2 — Quotes lag the underlying.** A volatility model on spot versus strike gives a better probability than the Kalshi quote. *Disproved if*, on dev, model edge does not translate into net profit after fees, or the model is not better calibrated than the market itself.
3. **H3 — Window-to-window momentum or mean reversion.** The previous window's outcome predicts the next one, bought at the first quote. *Disproved if* P(up | prev up) ≈ 0.5 within sampling error, or the edge is smaller than the entry spread + fee.

## Pass criteria (test set)
A rule **survives** only if all of the following hold:
- ≥ 100 test trades;
- net P&L > 0 at +1¢ slippage;
- a day-block bootstrap of the test P&L at +1¢ has a 95% lower bound > 0;
- it was frozen before the test was run.

Every rule frozen for testing is reported, whether it passes or fails. The test set is used once. No rule is adjusted after test results are seen.
