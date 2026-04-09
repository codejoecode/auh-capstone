const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const dbFile = path.join(__dirname, "..", "db", "database.sqlite");
const schemaFile = path.join(__dirname, "..", "db", "schema.sql");
const seedFile = path.join(__dirname, "..", "db", "seed.sql");

if (fs.existsSync(dbFile)) {
  fs.unlinkSync(dbFile);
}

const db = new sqlite3.Database(dbFile);

function execSqlFile(filePath) {
  const sql = fs.readFileSync(filePath, "utf8");
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

(async () => {
  try {
    await execSqlFile(schemaFile);

    await execSqlFile(seedFile);

    console.log("✅ Database created + seeded at:", dbFile);
  } catch (err) {
    console.error("❌ DB reset failed:", err);
    process.exitCode = 1;
  } finally {
    db.close();
  }
})();