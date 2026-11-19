# Coinbase spot features. Candle t = start of minute; close is known at t+60.
import json, numpy as np, pandas as pd, os
from scipy.stats import norm
D=os.path.join(os.path.dirname(__file__),"..","data")
CB={"KXBTC15M":"BTC","KXETH15M":"ETH","KXSOL15M":"SOL","KXXRP15M":"XRP"}
_c={}
def series_close(sym):
    if sym not in _c:
        a=np.array(json.load(open(f"{D}/cb_{sym}.json")),dtype=float)
        s=pd.Series(a[:,2],index=(a[:,0]+60).astype(int))  # index = time close becomes known
        s=s.reindex(np.arange(s.index.min(),s.index.max()+60,60)).ffill(limit=3)
        _c[sym]=s
    return _c[sym]
def add_model(df):
    df=df.copy()
    for S,sym in CB.items():
        idx=df.series==S
        if not idx.any(): continue
        s=series_close(sym); lr=np.log(s).diff()
        vol=lr.rolling(60,min_periods=45).std()
        for m in range(1,15):
            t=df.loc[idx,"close_ts"]-60*m
            S_=s.reindex(t).values; v=vol.reindex(t).values; K=df.loc[idx,"strike"].astype(float).values
            tau=max(m-1+1/3,0.34)
            df.loc[idx,f"p{m}"]=norm.cdf(np.log(S_/K)/(v*np.sqrt(tau)))
    return df
