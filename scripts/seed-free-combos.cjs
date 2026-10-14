const Database = require('better-sqlite3');
const db = new Database('C:/Users/Gabriel/AppData/Roaming/9router/db/data.sqlite');
const fallbacks = ['oc/union-alpha','oc/big-pickle','oc/mimo-v2.6-flash-free','oc/deepseek-v4-flash-free','oc/nemotron-3-ultra-free','oc/ling-3.0-flash-fin-free'];
const now = new Date().toISOString();
const get = db.prepare('SELECT * FROM combos WHERE name = ?');
const update = db.prepare('UPDATE combos SET models = ?, updatedAt = ? WHERE name = ?');
const insert = db.prepare('INSERT INTO combos(id,name,kind,models,createdAt,updatedAt) VALUES(?,?,?,?,?,?)');
const crypto = require('crypto');
const tx = db.transaction(() => {
  for (const name of ['gpt-6-astra','claude-opus-5-5']) {
    const old = get.get(name);
    const models = old ? JSON.parse(old.models || '[]') : [];
    const merged = [...new Set([...models, ...fallbacks])];
    if (old) update.run(JSON.stringify(merged), now, name);
    else insert.run(crypto.randomUUID(), name, null, JSON.stringify(fallbacks), now, now);
  }
  for (const name of ['gpt-6-astra-free','claude-opus-5-5-free']) {
    if (!get.get(name)) insert.run(crypto.randomUUID(), name, null, JSON.stringify(fallbacks), now, now);
  }
});
tx();
console.log(JSON.stringify(db.prepare('SELECT name, models FROM combos ORDER BY name').all().map(x=>({name:x.name,models:JSON.parse(x.models)})),null,2));
db.close();
