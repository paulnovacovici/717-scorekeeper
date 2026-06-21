const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const dataDir = path.resolve(__dirname, "..", "data");
const databasePath = path.resolve(process.env.DB_PATH || path.join(dataDir, "717.db"));
const backupDir = path.join(dataDir, "backups");
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 14);

fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(backupDir, `717-${stamp}.db`);
const database = new DatabaseSync(databasePath, { readOnly: true });

try {
  database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
} finally {
  database.close();
}

const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
for (const entry of fs.readdirSync(backupDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".db")) continue;
  const filePath = path.join(backupDir, entry.name);
  if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
}

console.log(`SQLite backup created: ${backupPath}`);
