# Cross-market consistency: 15m market vs hourly ladder settling on the same BRTI 60s average. TRAIN only unless argv says val.
import sys, json, numpy as np, pandas as pd
sys.path.insert(0,"src"); from r2common import *
PER=sys.argv[2] if len(sys.argv)>2 else "train"
def q(c,cut):
    prev=[k for k in c if k[0]<=cut]
    if not prev or cut-prev[-1][0]>180 or prev[-1][1] is None or prev[-1][2] is None: return None
    return float(prev[-1][1]),float(prev[-1][2])
def fee1(p,C=10): return np.ceil(np.round(0.07*C*p*(1-p)*100,6))/100/C   # per-contract taker fee at 10-lot
S=sys.argv[1]; base=load([S]).set_index("ticker")
arbs=[]; rv=[]; n=0
for l in open(f"data/lad_{S}.jsonl"):
    r=json.loads(l)
    if "legs" not in r or r["ticker"] not in base.index: continue
    if period(np.array([r["close_ts"]]))[0]!=PER: continue
    x=base.loc[r["ticker"]]; K=r["K"]; legs=sorted(r["legs"],key=lambda z:z["strike"]); n+=1
    for m in range(1,15):
        b15,a15=x[f"b{m}"],x[f"a{m}"]
        if not(np.isfinite(b15) and np.isfinite(a15)) or a15>=.99 or b15<=.01: continue
        cut=r["close_ts"]-60*m; Q=[(z["strike"],q(z["c"],cut),z["result"]) for z in legs]
        for s_,qq,res in Q:
            if qq is None: continue
            bh,ah=qq
            if s_<K and ah<0.99 and ah>0:   # buy 15m NO + buy lower-strike hourly YES -> payout >=1
                cost=(1-b15)+ah; net=1-cost-fee1(1-b15)-fee1(ah)
                pay=(1-x.yes)+(1 if res=="yes" else 0)
                arbs.append(dict(m=m,kind="lo",gap=K-s_,cost=cost,net_locked=net,realised=pay-cost-fee1(1-b15)-fee1(ah)))
            if s_>=K and bh>0.01:          # buy 15m YES + buy higher-strike hourly NO -> payout >=1
                cost=a15+(1-bh); net=1-cost-fee1(a15)-fee1(1-bh)
                pay=x.yes+(1 if res=="no" else 0)
                arbs.append(dict(m=m,kind="hi",gap=s_-K,cost=cost,net_locked=net,realised=pay-cost-fee1(a15)-fee1(1-bh)))
        # relative value: interpolate P(A>=K) between nearest lower & upper strike mids
        lo=[(s_,qq) for s_,qq,_ in Q if s_<K and qq]; hi=[(s_,qq) for s_,qq,_ in Q if s_>=K and qq]
        if lo and hi:
            (s1,q1),(s2,q2)=lo[-1],hi[0]; m1=sum(q1)/2; m2=sum(q2)/2; w=(K-s1)/(s2-s1)
            pl=m1+(m2-m1)*w; rv.append(dict(m=m,ladder=pl,mid15=(a15+b15)/2,a15=a15,b15=b15,yes=x.yes,spread_l=(q1[1]-q1[0]+q2[1]-q2[0])/2))
A=pd.DataFrame(arbs); R=pd.DataFrame(rv)
print(f"{S} {PER}: 15m hourly-close markets {n}; leg-minute pairs checked {len(A)}")
pos=A[A.net_locked>0]
print(f"  locked-in arbitrage after taker fees (1-min candle closes, NOT simultaneous): {len(pos)} pair-minutes in {pos.m.nunique() if len(pos) else 0} distinct m; mean locked edge {100*pos.net_locked.mean() if len(pos) else 0:.2f}c; realised mean {100*pos.realised.mean() if len(pos) else 0:.2f}c")
if len(pos): print(pos.groupby("m").net_locked.agg(["size","mean"]).round(4).T.to_string())
print("  closest-to-arb distribution (net_locked percentiles, c):",np.percentile(100*A.net_locked,[50,90,99,99.9]).round(2))
R["dev"]=R.ladder-R.mid15
print(f"  relative value: corr(ladder-implied, outcome) vs corr(15m mid, outcome)  Brier ladder {((R.ladder-R.yes)**2).mean():.4f} vs 15m {((R.mid15-R.yes)**2).mean():.4f}  n {len(R)}")
for th in (0.02,0.04,0.06):
    b=R[R.dev>th]; s=R[R.dev<-th]
    pb=(b.yes-b.a15-[fee1(p) for p in b.a15]).mean() if len(b) else np.nan
    ps=((1-s.yes)-(1-s.b15)-[fee1(1-p) for p in s.b15]).mean() if len(s) else np.nan
    print(f"   |ladder-15m mid|>{th}: buy-YES n {len(b)} pnl {100*pb:+.2f}c | buy-NO n {len(s)} pnl {100*ps:+.2f}c")
