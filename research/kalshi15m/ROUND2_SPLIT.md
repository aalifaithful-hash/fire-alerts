# Round 2 — split fixed before any round-2 analysis (2026-11-19)

| Period | Close-time range | Used for |
|---|---|---|
| **Train** | 2026-09-19 → 2026-10-15 | feature discovery and EV estimates |
| **Validation** | 2026-10-16 → 2026-10-31 | one confirmation pass per hypothesis; rules are frozen afterwards |
| **Sealed historical test** | 2026-11-01 → 2026-11-19 | not opened in round 2 |
| **Forward test** | data recorded after 2026-11-19 (order books + trades) | final judge; paper only |

Round-1 directional rules saw outcomes from 24 Oct onward. Round-2 hypotheses are different mechanisms, but this overlap is a known contamination risk. The forward test is therefore the final judge.
