import sys,numpy as np,pandas as pd
sys.path.insert(0,"src"); from load import *; from rules import sim
series=sys.argv[1].split(","); df=load(series); X=df[~df.dev]
R={"R1":(lambda d:d[d.series=="KXEURUSD15M"],lambda b,a:"YES",range(9,2,-1),.20,.95),
   "R2":(lambda d:d[d.series.isin(["KXBTC15M","KXETH15M"])],lambda b,a:"YES" if a>=1-b else "NO",range(14,5,-1),.80,.95),
   "R3":(lambda d:d,lambda b,a:"NO",[2],.60,.99)}
def cap(o):  # $100 combined open exposure: positions open from entry until close
    o=o.assign(entry=o.close_ts-60*o.m).sort_values(["entry","series"]); keep=[]; open_=[]
    for r in o.itertuples():
        open_=[(c,x) for c,x in open_ if c>r.entry]
        if sum(x for _,x in open_)+r.cost<=100: keep.append(r.Index); open_.append((r.close_ts,r.cost))
    return o.loc[keep]
rng=np.random.default_rng(0)
def boot(o):
    g=o.groupby("day").pnl.sum().values; s=[rng.choice(g,len(g)).sum() for _ in range(5000)]
    return np.percentile(s,2.5)
print("TEST markets:",X.series.value_counts().to_dict())
for k,(f,sf,ms,lo,hi) in R.items():
    for slip in (0,.01,.02):
        o=cap(sim(f(X),sf,ms,lo,hi,slip))
        print(f"{k} slip+{int(slip*100)}c trades {len(o):5d} win {o.win.mean():.3f} avg px {o.px.mean():.3f} pnl/contract {o.pnlc.mean():+.4f} net ${o.pnl.sum():+8.2f} fees ${o.fee.sum():7.2f} 95%LB ${boot(o):+8.2f}")
    o.to_csv(f"data/test_{k}_{sys.argv[2]}.csv",index=False)
