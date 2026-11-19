import sys, json, os, time
sys.path.insert(0, os.path.dirname(__file__)); from kapi import get
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
D=sys.argv[1]; S=sys.argv[2]; W=int(sys.argv[3]) if len(sys.argv)>3 else 6
ts=lambda s: int(datetime.fromisoformat(s.replace("Z","+00:00")).timestamp())
m=[x for x in json.load(open(f"{D}/mk_{S}.json")) if x.get("result") in("yes","no")]
out=f"{D}/cd_{S}.jsonl"; done=set()
if os.path.exists(out):
    for l in open(out): done.add(json.loads(l)["ticker"])
todo=[x for x in m if x["ticker"] not in done]
def one(x):
  try:
    a=ts(x["open_time"])-60; b=ts(x["close_time"])+60
    d=get(f"/series/{S}/markets/{x['ticker']}/candlesticks",{"start_ts":a,"end_ts":b,"period_interval":1})
    c=[(k["end_period_ts"],k["yes_bid"].get("close_dollars"),k["yes_ask"].get("close_dollars"),k.get("volume_fp")) for k in d.get("candlesticks",[])]
    return {"ticker":x["ticker"],"c":c}
  except Exception as e:
    return None
t0=time.time()
with open(out,"a") as f, ThreadPoolExecutor(W) as ex:
    for i,r in enumerate(ex.map(one,todo)):
        if r: f.write(json.dumps(r)+"\n")
        if i%500==0: print(S,i,len(todo),round(time.time()-t0),flush=True)
print("DONE",S,flush=True)
