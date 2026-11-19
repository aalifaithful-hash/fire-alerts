# Results: no strategy survived

**Test window:** 2026-10-24 → 2026-11-19 (held out, run once). BTC 2,475, ETH 2,475 and EUR/USD 1,710 markets.
**Assumptions:** taker fees, $20 per market, $100 open-exposure cap, no compounding.

| Rule | Trades | Win rate | Avg price paid | Net per contract | Net $ (+0¢ slip) | Net $ (+1¢) | Net $ (+2¢) | Pass? |
|---|---|---|---|---|---|---|---|---|
| R1 EUR/USD YES (tie rule) | 1,410 | 54.2% | 55.3¢ | −2.5¢ | −$819 | −$1,390 | −$1,941 | **No** |
| R2 BTC/ETH favourite 80–95¢ | 3,625 | 83.2% | 84.2¢ | −1.9¢ | −$1,578 | −$2,309 | −$3,049 | **No** |
| R3 other bot's NO ≥60¢ at 2 min | 1,789 | 85.5% | 87.3¢ | −2.6¢ | −$1,132 | −$1,478 | −$1,762 | **No** |

The 95% bootstrap lower bound is negative for every rule. The $ totals assume betting would continue after a $1,000 bankroll had been lost. In reality R2 would have wiped out the bankroll within the 4-week test.

## Every idea tried
- **H1, price miscalibration:** prices are close to fair. Contracts under 30¢ lose 2–3¢ each after fees. Favourites are break-even before slippage. Of 195 development slices, 49 were positive, which is about what chance produces when nothing real is there. Rules R1 and R2 came from H1, and both failed on test.
- **H2, Kalshi lags spot (Coinbase volatility model):** worse than the Kalshi mid at every horizon on BTC development data (Brier 0.127 vs 0.117 at 2 minutes). The model's claimed edge did not predict profit. Rejected at 1-minute resolution. A lag shorter than one minute, measured against BRTI, has not been tested.
- **H3, previous-window momentum or reversal:** P(up) was 49.4–51.4% after up or down windows. Both versions lost about 2.1–2.5¢ per contract on development data. Rejected; not taken to test.
- **Other bot's claim** (NO ≥60¢ with 2 minutes left loses after fees): **confirmed** on both development data (−1.0¢ per contract) and test data (−2.6¢ per contract).

## Conclusion
No forward paper test is warranted. Per the protocol, rules are not being re-tuned.

## Not tested / missing
- BRTI tick data (paid).
- Order-book depth.
- Sub-minute quotes.
- Hourly and daily crypto markets.
- Maker (limit-order) execution. Resting orders pay lower or no fees but get filled adversely; testing that needs order-book history.

## Unseen-market check (run after RESULTS were written; same frozen logic; full Sep 12 – Nov 19 history never examined before)

The data covers SOL and XRP with 6,459 markets each, WTI with 4,775 and Gold with 4,440.

| Rule logic | Markets | Trades | Win rate | Avg price paid | Net per contract | Net $ (+0¢) | Net $ (+1¢) |
|---|---|---|---|---|---|---|---|
| R1 logic: buy YES, 3–9 min, 20–95¢ | Gold, WTI | 8,113 | 54.4% | 54.6¢ | −1.6¢ | −$6,481 | −$9,630 |
| R2 logic: buy the favourite, 6–14 min, 80–95¢ | SOL, XRP | 9,961 | 83.6% | 84.2¢ | −1.5¢ | −$3,380 | −$5,482 |
| R3: buy NO ≥60¢ at 2 min | all four | 6,601 | 86.8% | 88.2¢ | −2.1¢ | −$3,218 | −$4,446 |

The 95% bootstrap lower bound is negative for every rule. The conclusion holds: in every case the win rate was below the price paid plus the fee.
