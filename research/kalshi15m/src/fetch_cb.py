import sys, json, time, urllib.request
from datetime import datetime, timezone
P=sys.argv[1]; out=sys.argv[2]
a=int(datetime(2026,9,11,tzinfo=timezone.utc).timestamp()); end=int(datetime(2026,11,19,1,tzinfo=timezone.utc).timestamp())
rows={}
req=lambda u: urllib.request.Request(u,headers={"User-Agent":"research-script"})
while a<end:
    b=min(a+300*60,end)
    u=f"https://api.exchange.coinbase.com/products/{P}/candles?granularity=60&start={datetime.fromtimestamp(a,timezone.utc).isoformat()}&end={datetime.fromtimestamp(b,timezone.utc).isoformat()}"
    for i in range(6):
        try:
            d=json.load(urllib.request.urlopen(req(u),timeout=30)); break
        except Exception: time.sleep(2*(i+1))
    else: d=[]
    for t,lo,hi,op,cl,v in d: rows[t]=(op,cl)
    a=b; time.sleep(0.12)
json.dump(sorted((t,o,c) for t,(o,c) in rows.items()),open(out,"w"))
print(P,len(rows))
