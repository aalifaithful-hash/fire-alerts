# For each 15m market closing on the hour (TRAIN+VAL only), fetch hourly ladder strikes around its strike + candles.
import sys, os, json
sys.path.insert(0, os.path.dirname(__file__)); from kapi import get
from load import ts
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
S15,SH=sys.argv[1],sys.argv[2]; out=f"data/lad_{S15}.jsonl"
lo=ts("2026-09-19T00:00:00Z"); hi=ts("2026-11-01T00:00:00Z")
m=[x for x in json.load(open(f"data/mk_{S15}.json")) if lo<=ts(x["close_time"])<hi and x["close_time"].endswith(":00:00Z") and "floor_strike" in x]
def evt(ct):  # event ticker uses US/Eastern hour label e.g. KXBTCD-26NOV1909
    t=datetime.fromtimestamp(ct,timezone.utc)
    off=4 if t<datetime(2026,11,1,6,tzinfo=timezone.utc) else 5
    e=t-timedelta(hours=off); return f"{SH}-{e.strftime('%y%b%d%H').upper()}"
def one(x):
    try:
        ct=int(ts(x["close_time"])); K=float(x["floor_strike"])
        L=get("/markets",{"event_ticker":evt(ct),"limit":1000}).get("markets",[])
        L=[y for y in L if y.get("floor_strike") and y.get("close_time")==x["close_time"]]
        if not L: return {"ticker":x["ticker"],"miss":True}
        below=sorted([y for y in L if y["floor_strike"]<K],key=lambda y:-y["floor_strike"])[:2]
        above=sorted([y for y in L if y["floor_strike"]>=K],key=lambda y:y["floor_strike"])[:2]
        legs=[]
        for y in below+above:
            d=get(f"/series/{SH}/markets/{y['ticker']}/candlesticks",{"start_ts":ct-16*60,"end_ts":ct+60,"period_interval":1})
            c=[(k["end_period_ts"],k["yes_bid"].get("close_dollars"),k["yes_ask"].get("close_dollars")) for k in d.get("candlesticks",[])]
            legs.append({"ticker":y["ticker"],"strike":y["floor_strike"],"type":y.get("strike_type"),"result":y.get("result"),"c":c})
        return {"ticker":x["ticker"],"K":K,"close_ts":ct,"legs":legs}
    except Exception as e: return {"ticker":x["ticker"],"err":str(e)[:80]}
with open(out,"w") as f, ThreadPoolExecutor(4) as ex:
    for r in ex.map(one,m): f.write(json.dumps(r)+"\n")
print("DONE",S15,len(m),flush=True)
