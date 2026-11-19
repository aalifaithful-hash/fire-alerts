import sys, json, numpy as np, pandas as pd
sys.path.insert(0,"src"); from load import *
TR0=ts("2026-09-19T00:00:00Z"); TR1=ts("2026-10-16T00:00:00Z"); VA1=ts("2026-11-01T00:00:00Z")
def period(ct): return np.where(ct<TR0,"pre",np.where(ct<TR1,"train",np.where(ct<VA1,"val","SEALED")))
def meta(S):
    m=pd.DataFrame([x for x in json.load(open(f"data/mk_{S}.json")) if x.get("result") in("yes","no") and "floor_strike" in x])
    m["close_ts"]=m.close_time.map(ts).astype(int); m["series"]=S
    m["ev"]=pd.to_numeric(m.expiration_value,errors="coerce"); m["K"]=m.floor_strike.astype(float)
    m["tie"]=(m.ev-m.K).abs()<1e-9; m["yes"]=(m.result=="yes").astype(int); m["per"]=period(m.close_ts)
    return m
