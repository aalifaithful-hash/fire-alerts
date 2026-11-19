# H1 on DEVELOPMENT data only: calibration of executable prices vs outcomes.
import sys, numpy as np, pandas as pd
sys.path.insert(0,"src"); from load import *
df=load(sys.argv[1:] or SERIES); df=df[df.dev]
print("dev markets:",len(df), df.series.value_counts().to_dict())
rec=[]
for m in MS:
    b=df[f"b{m}"]; a=df[f"a{m}"]; ok=valid(b,a)
    for side in ("YES","NO"):
        px=np.where(side=="YES",a,1-b); win=df.yes if side=="YES" else 1-df.yes
        t=pd.DataFrame({"series":df.series,"m":m,"side":side,"px":px,"win":win,"day":df.close_ts//86400})[ok]
        rec.append(t)
T=pd.concat(rec)
C=20/T.px.clip(lower=0.01)  # contracts for ~$20 order
T["C"]=np.floor(C).clip(lower=1); T["feec"]=fee(T.C,T.px)/T.C
T["pnl"]=T.win-T.px-T.feec               # per contract, held to settlement
T["roi"]=T.pnl/(T.px+T.feec)
T["bucket"]=pd.cut(T.px,[0,.05,.1,.2,.3,.4,.5,.6,.7,.8,.9,.95,.99],right=False)
T.to_pickle("data/h1_dev_long.pkl")
g=T.groupby(["side","bucket"],observed=True).agg(n=("pnl","size"),px=("px","mean"),win=("win","mean"),fee=("feec","mean"),pnl=("pnl","mean"),roi=("roi","mean"))
print("\nPooled across series & minutes (rows overlap across m; one market contributes up to 14 rows):"); print(g.round(4).to_string())
