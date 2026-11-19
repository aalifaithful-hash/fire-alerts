cd "$(dirname "$0")/.."
for p in 1 2; do for s in KXEURUSD15M KXBTC15M KXETH15M KXGOLD15M KXWTI15M KXSOL15M KXXRP15M; do python3 -I src/fetch_candles.py data $s 10; done; done
