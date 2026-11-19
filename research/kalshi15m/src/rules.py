import numpy as np, pandas as pd, sys
sys.path.insert(0,"src"); from load import *
def sim(d,side_fn,mset,lo,hi,slip=0.0):
    out=[]
    for r in d.itertuples():
        for m in mset:
            b,a=getattr(r,f"b{m}"),getattr(r,f"a{m}")
            if not(np.isfinite(b) and np.isfinite(a)) or not valid(np.array([b]),np.array([a]))[0]: continue
            side=side_fn(b,a); px0=a if side=="YES" else 1-b
            if lo<=px0<hi:
                px=min(px0+slip,0.99); C=int(20//(px+0.02)); f=fee(C,px)
                w=r.yes if side=="YES" else 1-r.yes
                out.append(dict(series=r.series,close_ts=r.close_ts,day=r.close_ts//86400,m=m,side=side,px=px,C=C,fee=f,win=w,cost=C*px+f,pnl=C*w-C*px-f,pnlc=w-px-f/C)); break
    return pd.DataFrame(out)
