import json, time, urllib.request, urllib.parse
B="https://api.elections.kalshi.com/trade-api/v2"
def get(path, params=None, tries=8):
    url=B+path+("?"+urllib.parse.urlencode(params) if params else "")
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=40) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code==429 or e.code>=500: time.sleep(1.5*(i+1)); continue
            raise
        except Exception: time.sleep(1.5*(i+1))
    raise RuntimeError("fail "+url)
def markets(series, status="settled", extra=None):
    out=[];cur=None
    while True:
        p={"series_ticker":series,"status":status,"limit":1000}
        if extra: p.update(extra)
        if cur: p["cursor"]=cur
        d=get("/markets",p); out+=d.get("markets",[]); cur=d.get("cursor")
        if not cur or not d.get("markets"): break
    return out
