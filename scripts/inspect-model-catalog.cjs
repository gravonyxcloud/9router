const D = require("better-sqlite3");
const db = new D("C:/Users/Gabriel/AppData/Roaming/9router/db/data.sqlite", { readonly: true });
console.log("TABLES", db.prepare("select name from sqlite_master where type='table'").all());
for (const t of ["providers", "providerNodes", "models", "combos"]) {
  try {
    console.log("TABLE", t, db.prepare("pragma table_info(" + t + ")").all());
    console.log(JSON.stringify(db.prepare("select * from " + t + " limit 5").all(), null, 2).slice(0, 10000));
  } catch (e) { console.log(t, e.message); }
}
db.close();