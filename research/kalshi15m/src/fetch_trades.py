# Sampled trades for TRAIN+VALIDATION markets only (close < 2026-11-01). One-minute slices.
import sys, os, json, random
sys.path.insert(0, os.path.dirname(__file__)); from kapi import get
from load import ts
from concurrent.futures import ThreadPoolExecutor
S=sys.argv[1]; N=int(sys.argv[2]); out=f"data/tr_{S}.jsonl"
lo=ts("2026-09-19T00:00:00Z"); hi=ts("2026-11-01T00:00:00Z")
m=[x for x in json.load(open(f"data/mk_{S}.json")) if lo<=ts(x["close_time"])<hi and x.get("result") in("yes","no")]
random.seed(1); m=sorted(random.sample(m,min(N,len(m))),key=lambda x:x["close_time"])
def one(x):
    ct=int(ts(x["close_time"])); rows=[]
    for mm in (13,8,3,1):
        cur=None
        while True:
            p={"ticker":x["ticker"],"min_ts":ct-60*mm,"max_ts":ct-60*(mm-1),"limit":1000}
            if cur:p["cursor"]=cur
            try: d=get("/markets/trades",p)
            except Exception: return None
            for t in d["trades"]:
                rows.append((t["created_time"],t["taker_side"],float(t["yes_price_dollars"]),float(t["count_fp"])))
            cur=d.get("cursor")
            if not cur or not d["trades"]: break
    return {"ticker":x["ticker"],"close_ts":ct,"yes":x["result"]=="yes","tr":rows}
with open(out,"w") as f, ThreadPoolExecutor(6) as ex:
    for i,r in enumerate(ex.map(one,m)):
        if r: f.write(json.dumps(r)+"\n")
print("DONE",S,flush=True)
