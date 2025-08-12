// update-roblox-limiteds.js
// Usage: node update-roblox-limiteds.js
// Env: UNIVERSE_ID (set in workflow), ROBLOX_OPEN_CLOUD_KEY (GitHub Secret),
// optional DATASTORE_NAME, ENTRY_KEY
(async () => {
  const crypto = require("crypto");
  const fetch = globalThis.fetch ?? (await import("node-fetch")).default;

  const UNIVERSE_ID = process.env.UNIVERSE_ID;
  const OC_KEY      = process.env.ROBLOX_OPEN_CLOUD_KEY;
  const DS_NAME     = process.env.DATASTORE_NAME || "RNG_MASTER";
  const ENTRY_KEY   = process.env.ENTRY_KEY || "ROBLOX_LIMITEDS";

  if (!UNIVERSE_ID || !OC_KEY) {
    console.error("Missing UNIVERSE_ID or ROBLOX_OPEN_CLOUD_KEY env vars.");
    process.exit(1);
  }

  const CATALOG_SEARCH = "https://catalog.roblox.com/v1/search/items";
  const ITEM_DETAILS   = id => `https://catalog.roblox.com/v1/catalog/items/${id}/details?itemType=Asset`;
  const RESALE_DATA    = id => `https://economy.roblox.com/v1/assets/${id}/resale-data`;
  const DS_SET = (u,ds,k) =>
    `https://apis.roblox.com/datastores/v1/universes/${u}/standard-datastores/datastore/entries/entry?datastoreName=${encodeURIComponent(ds)}&entryKey=${encodeURIComponent(k)}`;

  const sleep = (ms) => new Promise(r=>setTimeout(r,ms));

  async function getAllCollectiblesIds() {
    let cursor=null, ids=new Set();
    while (true) {
      const res = await fetch(`${CATALOG_SEARCH}?category=Collectibles&limit=120${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`);
      if (res.status===429) { await sleep(1500); continue; }
      if (!res.ok) throw new Error(`catalog search ${res.status}`);
      const j = await res.json();
      for (const it of j.data||[]) ids.add(it.id);
      cursor = j.nextPageCursor;
      if (!cursor) break;
      await sleep(250);
    }
    return [...ids];
  }

  async function filterToRobloxCreated(assetIds, concurrency=24) {
    const out=[]; let i=0;
    async function worker(){
      while (i<assetIds.length){
        const id=assetIds[i++];
        const r=await fetch(ITEM_DETAILS(id));
        if (r.ok){
          const d=await r.json();
          const restr=d.itemRestrictions||[];
          const isRoblox = (d.creatorName==="Roblox" || d.creatorTargetId===1);
          const isLimited = restr.includes("Limited") || restr.includes("LimitedUnique");
          if (isRoblox && isLimited) out.push(id);
        }
        await sleep(100);
      }
    }
    await Promise.all(Array.from({length:concurrency},worker));
    return out;
  }

  async function fetchRapFor(ids, concurrency=24) {
    const rap={}; let i=0;
    async function worker(){
      while (i<ids.length){
        const id=ids[i++];
        const r=await fetch(RESALE_DATA(id));
        if (r.ok){
          const d=await r.json();
          if (typeof d.recentAveragePrice==="number") rap[id]=Math.max(0,Math.floor(d.recentAveragePrice));
        }
        await sleep(100);
      }
    }
    await Promise.all(Array.from({length:concurrency},worker));
    return rap;
  }

  async function setEntry(universeId,ds,key,value){
    const body = JSON.stringify(value);
    const md5 = crypto.createHash("md5").update(body).digest("base64");
    const res = await fetch(DS_SET(universeId,ds,key),{
      method:"POST",
      headers:{ "x-api-key":OC_KEY, "content-type":"application/json", "content-md5":md5 },
      body
    });
    if (!res.ok) throw new Error(`OpenCloud SetEntry ${res.status} ${await res.text()}`);
  }

  try {
    const all = await getAllCollectiblesIds();
    const robloxOnly = await filterToRobloxCreated(all);
    const rap = await fetchRapFor(robloxOnly);
    const ids = robloxOnly.filter(id=>rap[id]).sort((a,b)=>a-b);
    const payload = { updatedAt:new Date().toISOString(), ids, rap };
    await setEntry(UNIVERSE_ID, DS_NAME, ENTRY_KEY, payload);
    console.log(`OK: ${ids.length} items updated`);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();