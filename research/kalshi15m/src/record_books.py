# Forward recorder: polls public order books of open 15-min markets. Paper data only.
import sys, os, json, time
sys.path.insert(0, os.path.dirname(__file__)); from kapi import get
S=["KXBTC15M","KXETH15M","KXSOL15M","KXXRP15M","KXGOLD15M","KXWTI15M","KXEURUSD15M"]
out=open(sys.argv[1],"a"); dur=float(sys.argv[2]); t_end=time.time()+dur; tick={}; last=0
while time.time()<t_end:
    if time.time()-last>60:
        for s in S:
            try:
                m=get("/markets",{"series_ticker":s,"status":"open","limit":5})["markets"]
                tick[s]=[(x["ticker"],x["close_time"],x.get("floor_strike")) for x in m]
            except Exception: pass
        last=time.time()
    for s,lst in tick.items():
        for t,ct,k in lst:
            try:
                ob=get(f"/markets/{t}/orderbook",{"depth":10},tries=2)["orderbook_fp"]
                out.write(json.dumps({"ts":time.time(),"s":s,"t":t,"close":ct,"k":k,"yes":ob.get("yes_dollars"),"no":ob.get("no_dollars")})+"\n")
            except Exception: pass
    out.flush(); time.sleep(3)
