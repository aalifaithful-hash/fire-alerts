# Forward paper test for V1: back-of-queue passive bids, from recorded books + public trades. No real orders.
# Rule (frozen in ROUND2_VALIDATION_PREREG / FORWARD_TEST.md): at the first snapshot with 8 >= minutes-left > 4,
# post 1 bid on each side at the current best bid (YES bid and NO bid), size Q contracts. Queue ahead = displayed size.
# Fill when cumulative taker volume printed AT OR THROUGH our price since placement exceeds queue ahead.
# Cancel any unfilled remainder at 4 minutes left. Hold fills to settlement. Maker fee scenarios: 0, linear 0.0175, rounded.
import sys, os, json, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__)); from kapi import get
from datetime import datetime
Q=int(sys.argv[2]) if len(sys.argv)>2 else 10
iso=lambda s: datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
snaps={}
for l in open(sys.argv[1]):
    r=json.loads(l); snaps.setdefault(r["t"],[]).append(r)
out=[]
for t,S in snaps.items():
    ct=iso(S[0]["close"]); S=sorted(S,key=lambda r:r["ts"])
    first=[r for r in S if 4*60<ct-r["ts"]<=8*60 and r["yes"] and r["no"]]
    if not first: continue
    r0=first[0]; m=get(f"/markets/{t}")["market"]
    if m.get("result") not in ("yes","no"): continue   # not settled yet
    yes=m["result"]=="yes"
    tr=[]; cur=None
    while True:
        p={"ticker":t,"min_ts":int(r0["ts"]),"max_ts":int(ct-240),"limit":1000}
        if cur:p["cursor"]=cur
        d=get("/markets/trades",p); tr+=d["trades"]; cur=d.get("cursor")
        if not cur or not d["trades"]: break
    for side in ("yes","no"):
        px=float(r0[side][-1][0]); ahead=float(r0[side][-1][1])
        # our YES bid is hit by takers selling YES = taker_side "no" at yes_price <= px
        hit=sum(float(x["count_fp"]) for x in tr if iso(x["created_time"])>=r0["ts"] and
                ((side=="yes" and x["taker_side"]=="no" and float(x["yes_price_dollars"])<=px+1e-9) or
                 (side=="no" and x["taker_side"]=="yes" and float(x["no_price_dollars"])<=px+1e-9)))
        filled=max(0.0,min(Q,hit-ahead))
        if filled<=0: out.append(dict(t=t,side=side,px=px,filled=0,gross=0)); continue
        win=(yes if side=="yes" else not yes)
        out.append(dict(t=t,side=side,px=px,filled=filled,gross=filled*((1 if win else 0)-px),
                        fee_lin=filled*0.0175*px*(1-px),fee_rnd=np.ceil(round(0.0175*filled*px*(1-px)*100,6))/100))
d=pd.DataFrame(out); print(d.to_string() if len(d)<40 else d.describe())
if len(d) and d.filled.sum()>0:
    f=d[d.filled>0]; print(f"markets {d.t.nunique()} fills {len(f)} contracts {f.filled.sum():.0f} gross ${f.gross.sum():+.2f} net(lin fee) ${f.gross.sum()-f.fee_lin.sum():+.2f} net(rounded) ${f.gross.sum()-f.fee_rnd.sum():+.2f}")
