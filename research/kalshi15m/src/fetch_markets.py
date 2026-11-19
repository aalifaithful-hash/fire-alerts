import sys, json, os
sys.path.insert(0, os.path.dirname(__file__)); from kapi import markets
from concurrent.futures import ThreadPoolExecutor
D=sys.argv[1]; S=sys.argv[2:]
def one(s):
    m=markets(s); json.dump(m,open(f"{D}/mk_{s}.json","w"))
    vol=sum(float(x.get("volume_fp") or 0) for x in m)
    ts=sorted(x["close_time"] for x in m)
    return s,len(m),vol,(ts[0] if ts else None),(ts[-1] if ts else None)
with ThreadPoolExecutor(6) as ex:
    for r in ex.map(one,S): print(*r)
