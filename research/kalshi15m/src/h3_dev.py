import sys, numpy as np, pandas as pd
sys.path.insert(0,"src"); from load import *
df=load(); df=df[df.dev].sort_values(["series","close_ts"])
df["prev"]=df.groupby("series").yes.shift(); df["gap"]=df.groupby("series").close_ts.diff()
d=df[(df.gap==900)&df.prev.notna()]
print("P(yes|prev):"); print(d.groupby(["series","prev"]).yes.agg(["size","mean"]).round(3).unstack().to_string())
m=14; b,a=d[f"b{m}"],d[f"a{m}"]; ok=valid(b,a); d=d[ok]
for name,buyyes in [("momentum",d.prev==1),("reversal",d.prev==0)]:
    px=np.where(buyyes,d[f"a{m}"],1-d[f"b{m}"]); win=np.where(buyyes,d.yes,1-d.yes)
    C=np.floor(20/px).clip(min=1); fc=fee(C,px)/C; pnl=win-px-fc
    print(name,"n",len(pnl),"avg px %.3f win %.3f pnl/contract %.4f"%(px.mean(),win.mean(),pnl.mean()))
