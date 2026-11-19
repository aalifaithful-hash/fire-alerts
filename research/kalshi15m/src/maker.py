# Maker markout to settlement, TRAIN period only. Contract-weighted.
import sys, json, numpy as np, pandas as pd
sys.path.insert(0,"src"); from r2common import *
def load_tr(S):
    R=[]
    for l in open(f"data/tr_{S}.jsonl"):
        r=json.loads(l)
        for ct,side,p,c in r["tr"]:
            R.append((r["ticker"],r["close_ts"],int(r["yes"]),ct,side,p,c))
    d=pd.DataFrame(R,columns=["ticker","close_ts","yes","t","taker","p","c"])
    d["tsec"]=(pd.to_datetime(d.t,format="ISO8601")-pd.Timestamp("1970-01-01",tz="UTC"))//pd.Timedelta("1s"); d["m_left"]=np.ceil((d.close_ts-d.tsec)/60).astype(int)
    d["per"]=period(d.close_ts)
    # maker side: taker bought YES -> maker bought NO at 1-p
    d["mpx"]=np.where(d.taker=="yes",1-d.p,d.p); d["mwin"]=np.where(d.taker=="yes",1-d.yes,d.yes)
    d["gross"]=d.mwin-d.mpx
    return d
def report(S, per="train"):
    d=load_tr(S); d=d[(d.per==per)&(d.mpx>0.02)&(d.mpx<0.98)]
    if d.empty: print(S,"no trades"); return
    f_lin=0.0175*d.mpx*(1-d.mpx); f_1c=np.ceil(np.round(0.0175*d.mpx*(1-d.mpx)*100,6))/100  # one-contract fills rounded up
    w=d.c
    def wm(x): return (x*w).sum()/w.sum()
    print(f"{S} {per}: markets {d.ticker.nunique()} trades {len(d)} contracts {w.sum():,.0f}")
    print(f"   maker gross {100*wm(d.gross):+.2f}c/contract | net if maker fee 0.0175 linear {100*wm(d.gross-f_lin):+.2f}c | if fee rounded per 1-lot {100*wm(d.gross-f_1c):+.2f}c")
    d["band"]=pd.cut(d.m_left,[0,1,3,8,13],labels=["last1","2-3","4-8","9-13"])
    d["pb"]=pd.cut(d.mpx,[0,.2,.4,.6,.8,1])
    d["gw"]=d.gross*d.c; g=d.groupby("band",observed=True)[["gw","c"]].sum()
    print("   gross c/contract by time-left:",{k:round(100*r.gw/r.c,2) for k,r in g.iterrows()})
    # day-cluster CI on gross
    dd=d.assign(day=d.close_ts//86400,gw=d.gross*d.c).groupby("day")[["gw","c"]].sum()
    rng=np.random.default_rng(0); bs=[]
    for _ in range(2000):
        s=dd.sample(len(dd),replace=True,random_state=rng.integers(1e9)); bs.append(s.gw.sum()/s.c.sum())
    print(f"   gross 95% CI (day bootstrap): [{100*np.percentile(bs,2.5):+.2f}, {100*np.percentile(bs,97.5):+.2f}] c/contract")
if __name__=="__main__":
    for S in sys.argv[1:]: report(S)
