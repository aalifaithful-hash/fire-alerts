# Round 2 — hypotheses frozen for one validation pass (Oct 16–31)

Written after the train analysis and before any validation numbers were computed.

## V1 — Passive quoting in the middle of the window (from H1, market-making)
- **Training evidence:** all makers' markout to settlement, contract-weighted, at **4–8 minutes before close**: BTC +1.77¢, Gold +1.26¢, WTI +1.26¢, EUR/USD +2.51¢. The 2–3 minute window was negative in 3 of 4 markets.
- **Validation test:** maker markout at 4–8 minutes, pooled across every sampled series and markets with close in Oct 16–31.
  - **Pass** if the pooled gross result is **> +0.5¢/contract** (a buffer above the linear maker fee of 0.0175·P·(1−P) ≤ 0.44¢) **and** the day-bootstrap 95% lower bound is > 0.
  - **Also report:** the 2–3 minute window (expected to be negative).
- **Known limitation:** this is the average of *all* maker fills. A new order joins the back of the queue and usually gets worse fills. Passing validation only earns a forward test with queue-position simulation from recorded order books. It does **not** establish profitability.

## V2 — Cross-market consistency (BTC/ETH 15-min vs hourly ladder, same settlement)
- **Training check (computed after this file is committed):** count of minutes where buying both sides locks in profit after fees, judged on 1-minute closing quotes, plus a relative-value rule (|ladder-implied − 15-min mid| > 4¢, trade the 15-min market toward the ladder as a taker).
- **Reject if:** locked-in arbitrage occurs in < 0.5% of checked minutes or averages < 1¢ after fees, **or** the relative-value rule is ≤ 0 net per contract on train.
- **Only if train passes:** the same rule is checked once on validation.

## V3 — Time of day (thin-session under-reaction)
- **Training evidence:** the calibration slope of the mid at T−5 was > 1 in Asia hours for 6 of 6 weekday series, but taker EV was mixed.
- **Validation test:** buy the favourite side at T−5 when its ask is in [0.65, 0.90], during 00–08 UTC on weekdays, across all seven series.
- **Reject if:** validation net ≤ 0 per contract at +1¢ slippage.

## Outcomes (added after the validation run)
- **V1: FAILED.** Validation 4–8 min pooled gross **−0.14¢** (95% CI −1.55…+1.29); bar was > +0.5¢. The 2–3 min window flipped sign (train −0.70¢ → val +0.95¢). BTC was absent from validation because its trade sample was truncated to the 73 earliest markets; this is noted as a flaw.
- **V2: REJECTED on train** (BTC). Locked arbitrage in 0.06% of leg-minutes, 0.77¢ average; relative value −2.3 to −4.9¢. Validation not run, per rule.
- **V3: FAILED.** Validation −0.95¢ (−1.91¢ at +1¢ slippage).
