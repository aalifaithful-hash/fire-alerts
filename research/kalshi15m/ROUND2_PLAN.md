# Round 2 — ranked research plan (Kalshi 15-minute crypto / commodity / FX)

Status 2026-11-19. Paper research only. No real orders, no account access, no paid data.

## 1. What data we actually have

| Data | Source | Coverage | Good for | Not good for |
|---|---|---|---|---|
| Settled markets: strike, settlement value, result | Kalshi public API | Sep 12 – Nov 19, 7 series (+11 more listed) | outcomes, ties, exact BRTI 15-min prints | — |
| 1-min candles: **closing** best bid/ask, volume | Kalshi public API | same | taker EV at 1-min resolution, spreads | depth, sub-minute timing, queue |
| Trades: time (µs), price, size, **taker side** | Kalshi public API (live + historical endpoints) | any period; **sampled** here, 1-min slices at T−13/8/3/1 | maker markout (all makers on average), trade-flow | *our* queue position |
| Order book (10 levels, sizes) | Kalshi public API | **live snapshot only, no history**. Recorder started 2026-11-19 ≈14:51 UTC, ~3–5 s cadence | forward queue simulation, imbalance | anything historical |
| Hourly BTC ladder (KXBTCD) candles | Kalshi public API | Sep 19 – Oct 31 hourly closes | cross-market consistency | simultaneity < 1 min |
| Coinbase 1-min OHLC BTC/ETH/SOL/XRP | Coinbase public API | Sep 11 – Nov 19 | proxy for BRTI (basis sd 1.2–2.6 bps) | final-minute / second-level work |

### Missing, and what it blocks
- **Order-book history.** Blocks any historical test of passive execution or imbalance. Fix: forward recording, already running, but it must run on a persistent machine; this cloud container is ephemeral.
- **CF Benchmarks BRTI ticks** (paid). Blocks exact crypto settlement modelling. Kalshi's own settlement values give the 15-min prints for free.
- **Pyth prices**, the settlement source for Gold, WTI and FX. Historical *and* live endpoints now return 401 and need an API key. Blocks the external-reference hypothesis for those markets. Whether a free key tier exists is unverified.
- **Maker-fee status** of these series. The API says `fee_type: quadratic, multiplier 1`. Whether a maker fee applies, and how it rounds, must be read from Kalshi's fee schedule in an account. All maker numbers below show 0-fee and 0.0175·P·(1−P) scenarios.
- **Sub-second timestamps of our own hypothetical orders, and latency.** Can only come from a paper bot running live.

## 2. Execution-cost facts (training data, Sep 19 – Oct 15)
- **Median quoted spread:** 1¢ for BTC, ETH, SOL, XRP, Gold and WTI (BTC is at 1¢ 96–100% of the time); EUR/USD about **4¢**.
- **Taker fee:** ceil(0.07·C·P·(1−P)) to the cent. That is 1.75¢/contract at 50¢, 0.6¢ at 90¢. A 1-lot at 50¢ pays 2¢.
- **Is $20 available at the best ask?** (live sample, 4 min) BTC 98%, WTI 98%, Gold 88%, ETH 73%, SOL 61%, XRP 57%, EUR/USD 36% of snapshots.
- **What a taker must beat:** half-spread + fee ≈ **1.3–2.3¢ per contract**, before slippage.
- **What a maker can earn at most:** half-spread (0.5¢; 2¢ on EUR/USD) minus adverse selection minus any maker fee.

## 3. Results of each hypothesis so far

| # | Hypothesis | What was measured (period) | EV per contract after costs | Verdict |
|---|---|---|---|---|
| H1 | Passive quoting / market making | All-maker markout to settlement, 7 series, ~1,500 markets sampled | Train 4–8 min: **+1.51¢** gross (CI +0.47…+2.56). **Validation: −0.14¢** gross, −0.42¢ after linear fee (CI −1.55…+1.29) | **V1 rule failed validation.** Market making as such remains untested: the true test needs queue position (§4). |
| H2 | Cross-market (15-min vs hourly ladder, same BRTI average) | 632 BTC hourly closes, 21,362 leg-minutes (train) | Locked arbitrage in 13 leg-minutes (0.06%), 0.77¢ avg, on non-simultaneous quotes. Relative value −2.3 to −4.9¢ | **Rejected** (pre-set bar: ≥ 0.5% and ≥ 1¢). The 15-min market is better calibrated than the ladder (Brier 0.169 vs 0.181). |
| H3 | External reference vs settlement | Coinbase vs Kalshi settlement value (train) | Not computable without second-level data | **Not tested.** Coinbase tracks BRTI to 1.2 bps vs a median 15-min move of 7.7 bps. In ~10% of BTC markets the final move is within that noise. FX/commodities are blocked by Pyth auth. |
| H4 | Time-dependent pricing | Ties by hour-of-week; calibration by session (train); V3 rule (val) | V3 Asia-hours favourite: train +0.22¢ → **val −0.95¢ (−1.91¢ at +1¢ slip)** | **V3 rejected.** Ties (0–2.9%) are not clustered in time. |
| H5 | Order-book imbalance / liquidity | — | — | **Not tested:** no historical depth. Forward recording started. |
| R1 | Round-1 directional rules (R1–R3, other bot's rule) | Sealed test + 4 unseen markets | −1.5¢ to −2.6¢ | Rejected (see RESULTS.md) |

## 4. Ranked plan (what is still worth testing)

Ranking = (plausibility of a structural reason) × (can it be tested without paid data) × (works at $1,000 scale).

### #1 — Passive quoting in wide-spread FX/commodity markets (EUR/USD, Gold), mid-window
- **Why it might exist:** EUR/USD has a 4¢ spread and thin, retail-heavy flow. Mid-window takers are less informed than takers in the final minutes. These were the only two series with positive maker markout at 4–8 min in *both* train (+2.51¢, +1.26¢) and validation (+2.38¢, +0.92¢).
  - **Caveat:** this was noticed after validation, so it is a *new* hypothesis. It may only be tested on data recorded from now on.
- **EV model per filled contract:** E = (fair − our bid) − maker fee.
  - Measured all-maker average: ≈ +0.9 to +2.5¢ gross.
  - A back-of-queue order sees worse fills. Unknown size; this is exactly what the forward test measures.
- **Rule to test (frozen):**
  - From 8 to 4 minutes before close, rest 1 bid on YES and 1 bid on NO at the current best bid. Size 10 contracts, ≤ $20 per market.
  - Cancel at 4 minutes. Hold fills to settlement.
  - Skip if the spread is < 2¢ (EUR/USD) or the book is empty.
- **Data needed:**
  - Order-book snapshots at ≤ 5 s (`src/record_books.py`).
  - Public trades fetched afterwards.
  - Kalshi maker-fee schedule.
- **Method:** `src/sim_queue.py`. We join the back of the queue and are filled only after printed volume at or through our price exceeds the displayed size ahead of us. No cancellations ahead are assumed (conservative).
- **Reject if any of these hold:**
  - after ≥ 300 simulated fills (or 3 weeks), net per contract after the maker fee is ≤ 0;
  - the day-bootstrap 95% lower bound is ≤ 0;
  - fewer than 5 fills per day, so it can't scale even to $1k;
  - the result depends on fills during the last 4 minutes.

### #2 — Final-minute settlement-average edge (crypto)
- **Why it might exist:** settlement is the average of 60 one-second BRTI prints before close. Once the averaging window starts, part of the outcome is already fixed. A second-level aggregate of the exchanges BRTI uses (Coinbase, Kraken, Bitstamp …) could know the result before slower participants.
- **Why it might not:**
  - The BTC book already sits at 99/100 in the final minute (median spread 0.2–0.5¢).
  - Professional bots compete on latency.
  - The taker fee at 95¢+ is small, but so is the remaining edge.
- **EV model:** E = P_model(win) − ask − fee, entered only when P_model − ask > fee + 1¢. It is evaluated only on quotes recorded *simultaneously* with the reference feed.
- **Data needed (free):**
  - Coinbase/Kraken/Bitstamp public trade or ticker websockets at 1 s.
  - Kalshi book at ≥ 1 Hz for T−90 s … T.
  - Network access to those exchanges (not yet allowed).
- **Reject if:**
  - in ≥ 500 recorded final minutes, the model's Brier score is not better than the Kalshi mid; or
  - net after fees at a realistic 300 ms latency is ≤ 0; or
  - opportunities are < 1 per day.

### #3 — Order-book imbalance as a quote-skew signal (support for #1, not a taker strategy)
- **Why:** with 1¢ spreads and ~1.75¢ taker fees, imbalance would have to predict a ≥ 3¢ move to be taken profitably, which is unlikely. As a maker tool, skewing or cancelling quotes when the book leans against us may cut adverse selection.
- **Data:** the same forward recording as #1.
- **Test:** on the first 2 weeks of recordings (train) fit one threshold. Freeze it. Evaluate it inside #1's simulator on weeks 3–4.
- **Reject if:** it does not improve #1's net per fill by ≥ 0.3¢, or it cuts fills by > 50%.

### #4 — Scheduled-event windows (FX/commodity macro releases)
- **Why:** 15-min windows that contain a scheduled release (CPI, NFP, EIA crude inventories) have jump risk. Retail quotes may underprice it, making cheap tails underpriced in those windows only.
- **Data:** a public economic calendar (needs a host allowance) plus the existing candles.
- **Test:** train on Sep–Oct releases. One rule. Validate on the sealed Nov period only if train passes.
- **Reject if:** train EV ≤ 0 after fees + 1¢, or fewer than 40 qualifying windows.
- **Prior: low.**

### Dropped (no further work)
- **Cross-market vs the hourly ladder (H2):** rejected for BTC. ETH has the same structure. Untested coin-race and comparison series stay out unless a specific mechanism is identified.
- **Session/hour calibration (V3) and all round-1 directional variants:** rejected.

## 5. Protocol going forward
1. **The sealed historical test (Nov 1–19) stays unopened.** It may be used once, only for #4.
2. **#1–#3 are judged on forward-recorded data only:**
   - weeks 1–2 are used for any parameter that must be estimated;
   - weeks 3–4 are judged with frozen rules;
   - every rule is committed to git before its evaluation data exists.
3. **Paper limits stay in force:** $1,000 simulated, ≤ $20 per market including fees and resting orders, ≤ $100 combined, and fixed size (never increased after wins).
4. **Infrastructure needed:** the recorder must run 24/7 for 4 weeks on a persistent machine. This cloud session is ephemeral and its recorder will stop when the container is reclaimed.

## 6. One-dollar example for #1 (passive bid)
Rest a bid for 10 EUR/USD YES contracts at 48¢ while the market shows 48¢ bid / 52¢ ask. The fee assumed is 0.0175 maker, which rounds to $0.05.
- **Filled, settles YES:** receive $10.00 − paid $4.80 − fee $0.05 = **+$5.15**.
- **Filled, settles NO:** receive $0 − $4.80 − $0.05 = **−$4.85**.
- **Not filled:** $0. The order is cancelled at 4 minutes left.

The edge is not the win rate. It is whether, across many fills, the true probability at the moment we are filled averages above 48¢ + fee. The all-maker average says by roughly 1–2.5¢. The forward test exists to find out whether a back-of-queue order keeps any of that.
