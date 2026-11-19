import json, os, numpy as np, pandas as pd
from datetime import datetime
D=os.path.join(os.path.dirname(__file__),"..","data")
SERIES=["KXBTC15M","KXETH15M","KXSOL15M","KXXRP15M","KXGOLD15M","KXWTI15M","KXEURUSD15M"]
SPLIT=pd.Timestamp("2026-10-24T00:00Z").timestamp()
ts=lambda s: datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()
MS=range(1,15)
def load(series=SERIES):
    rows=[]
    for S in series:
        f=f"{D}/cd_{S}.jsonl"
        if not os.path.exists(f): continue
        mk={x["ticker"]:x for x in json.load(open(f"{D}/mk_{S}.json"))}
        for l in open(f):
            r=json.loads(l); x=mk[r["ticker"]]; ct=int(ts(x["close_time"]))
            c=sorted((int(t),float(b) if b else np.nan,float(a) if a else np.nan,float(v or 0)) for t,b,a,v in r["c"])
            row={"series":S,"ticker":r["ticker"],"close_ts":ct,"yes":1 if x["result"]=="yes" else 0,
                 "strike":x.get("floor_strike"),"vol":float(x.get("volume_fp") or 0)}
            for m in MS:
                cut=ct-60*m; prev=[k for k in c if k[0]<=cut]
                if prev and cut-prev[-1][0]<=180: row[f"b{m}"]=prev[-1][1]; row[f"a{m}"]=prev[-1][2]
                else: row[f"b{m}"]=np.nan; row[f"a{m}"]=np.nan
            rows.append(row)
    df=pd.DataFrame(rows).sort_values(["close_ts","series"]).reset_index(drop=True)
    df["dev"]=df.close_ts<SPLIT
    return df
def fee(C,P): return np.ceil(np.round(0.07*C*P*(1-P)*100,6))/100
def valid(b,a): return (a<0.99)&(b>0.01)&((a-b)<=0.05)&(a>b-1e-9)
