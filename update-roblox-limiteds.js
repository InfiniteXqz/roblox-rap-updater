// update-roblox-limiteds.js (catalog v2 + Roblox-only + Limited filter)
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

  const CATALOG_V2 = "https://catalog.roblox.com/v2/search/items/details";
  const RESALE     = id => `https://economy.roblox.com/v1/assets/${id}/resale-data`;
  const DS_SET     = (u,ds,k) =>
    `https://apis.roblox.com/datastores/v1/universes/${u}/standard-datastores/datastore/entries/entry?datastoreName=${encodeURIComponent(ds)}&entryKey=${encodeURIComponent(k)}`;

  const sleep = ms => new Promise(r=>setTimeout(r,ms));

  // Pull every item created by Roblox (creator id 1), then keep Limited/LimitedU
  async function getRobloxLimitedIds() {
    let cursor = null;
    const ids = new Set();
    while (true) {
      const qs = new URLSearchParams({
        limit: "120",
        "model.creatorTargetId": "1",   // Roblox account
        "model.creatorType": "User",
        "model.sortType": "0",
        "model.sortAggregation": "5",
        "model.includeNotForSale": "true"
      });
      if (cursor) qs.set("cursor", cursor);

      const res = await fetch(`${CATALOG_V2}?${qs.toString()}`);
      if (res.status === 429) { await sleep(1500); continue; }
      if (!res.ok) throw new Error(`catalog v2 ${res.status}`);

      const j = await res.json();
      for (const it of j.data || []) {
        const r = it.itemRestrictions || [];
        if (r.includes("Limited") || r.includes("LimitedUnique")) ids.add(it.id);
      }
      cursor = j.nextPageCursor || null;
      if (!cursor) break;
      await sleep(250);
    }
    return [...ids];
  }

  async function fetchRap(ids, concurrency = 24) {
    const rap = {}; let i = 0;
    async function worker() {
      while (i < ids.length) {
        const id = ids[i++];
        const r = await fetch(RESALE(id));
        if (r.ok) {
          const d = await r.json();
          if (typeof d.recentAveragePrice === "number") rap[id] = Math.max(0, Math.floor(d.recentAveragePrice));
        }
        await sleep(100);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return rap;
  }

  async function setEntry(value) {
    const body = JSON.stringify(value);
    const md5  = crypto.createHash("md5").update(body).digest("base64");
    const res  = await fetch(DS_SET(UNIVERSE_ID, DS_NAME, ENTRY_KEY), {
      method: "POST",
      headers: { "x-api-key": OC_KEY, "content-type": "application/json", "content-md5": md5 },
      body
    });
    if (!res.ok) throw new Error(`OpenCloud SetEntry ${res.status} ${await res.text()}`);
  }

  try {
    const ids = await getRobloxLimitedIds();
    const rap = await fetchRap(ids);
    const finalIds = ids.filter(id => rap[id]).sort((a,b)=>a-b);
    await setEntry({ updatedAt: new Date().toISOString(), ids: finalIds, rap });
    console.log(`OK: ${finalIds.length} items updated`);
  } catch (e) { console.error(e); process.exit(1); }
})();
