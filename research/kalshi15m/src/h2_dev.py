import sys, numpy as np, pandas as pd
sys.path.insert(0,"src"); from load import *; from spot import *
df=load(sys.argv[1:] or list(CB)); df=df[df.dev]; df=add_model(df)
print("dev crypto markets",len(df))
print("\nCalibration/Brier: model p vs market mid, by minutes-left")
for m in [1,2,3,5,8,12]:
    b,a,p=df[f"b{m}"],df[f"a{m}"],df[f"p{m}"]; ok=valid(b,a)&p.notna(); mid=(a+b)/2
    y=df.yes[ok]
    print(m,"n",ok.sum(),"brier model %.4f market %.4f blend %.4f"%(((p[ok]-y)**2).mean(),((mid[ok]-y)**2).mean(),(((p[ok]+mid[ok])/2-y)**2).mean()))
rec=[]
for m in MS:
    b,a,p=df[f"b{m}"],df[f"a{m}"],df[f"p{m}"]; ok=valid(b,a)&p.notna()
    for side in ("YES","NO"):
        px=a if side=="YES" else 1-b; q=p if side=="YES" else 1-p; win=df.yes if side=="YES" else 1-df.yes
        C=np.floor(20/px.clip(lower=.01)).clip(lower=1); fc=fee(C,px)/C
        rec.append(pd.DataFrame({"series":df.series,"m":m,"side":side,"px":px,"edge":q-px-fc,"pnl":win-px-fc,"day":df.close_ts//86400,"ticker":df.ticker})[ok])
T=pd.concat(rec); T.to_pickle("data/h2_dev_long.pkl")
T["eb"]=pd.cut(T.edge,[-1,-.1,-.05,-.02,0,.02,.05,.1,.2,1])
print("\nRealised pnl/contract by model edge bucket (all m, both sides):")
print(T.groupby("eb",observed=True).pnl.agg(["size","mean"]).round(4).to_string())
print("\nedge>0.05 by m:"); print(T[T.edge>.05].groupby("m").pnl.agg(["size","mean"]).round(4).T.to_string())
print("\nedge>0.05 by series:"); print(T[T.edge>.05].groupby("series").pnl.agg(["size","mean"]).round(4).to_string())
