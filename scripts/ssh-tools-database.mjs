// ssh-tools-database.mjs — database operations: ssh_db
import { runSshCommand, formatRunResult } from "./ssh-core.mjs";

function shellQuote(v) { return `'${String(v).replace(/'/g, "'\\''")}'`; }
function textResult(text, isError = false) { return { content: [{ type: "text", text }], isError }; }
function dryRunResult(toolName, args, command, target) {
  return textResult(JSON.stringify({ dryRun: true, tool: toolName, target: target || args.target || args.host || "(default)", sudo: Boolean(args.sudo), command: command || null, note: "dryRun:true — nothing executed" }, null, 2));
}
function requireConfirm(toolName, args) {
  const r = args.reason ? ` Stated reason: "${args.reason}".` : "";
  return textResult(`${toolName} requires confirm:true to execute.${r}`, true);
}

const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE|REPLACE|MERGE)\b/i;
const BANNED_CHARS = /[\r\n\x00]/;

function rejectBanned(val, label) {
  if (val !== undefined && val !== null && BANNED_CHARS.test(String(val))) {
    throw new Error(`${label} contains invalid characters (\\r, \\n, or \\x00).`);
  }
}

function validateDbName(val, label) {
  if (val === undefined || val === null || val === "") return;
  if (!/^[a-zA-Z0-9_-]+$/.test(String(val))) {
    throw new Error(`${label} must be alphanumeric + underscore/hyphen only.`);
  }
}

function validateDbUser(val, label) {
  if (val === undefined || val === null || val === "") return;
  if (!/^[a-zA-Z0-9_.-]+$/.test(String(val))) {
    throw new Error(`${label} must match /^[a-zA-Z0-9_.-]+$/.`);
  }
}

function validateDbHost(val, label) {
  if (val === undefined || val === null || val === "") return;
  if (!/^[a-zA-Z0-9._-]+$/.test(String(val))) {
    throw new Error(`${label} must match /^[a-zA-Z0-9._-]+$/.`);
  }
}

function validateDbPort(val, label) {
  if (val === undefined || val === null) return;
  const n = Number(val);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${label} must be an integer 1-65535.`);
  }
}

function validateSqliteFile(val, label) {
  if (val === undefined || val === null || val === "") return;
  const s = String(val);
  if (!s.startsWith("/")) throw new Error(`${label} must be an absolute path.`);
  if (s.includes("..")) throw new Error(`${label} must not contain "..".`);
}

function buildAutoDetect() {
  return `
if command -v mysql >/dev/null 2>&1; then _engine=mysql
elif command -v psql >/dev/null 2>&1; then _engine=postgres
elif command -v redis-cli >/dev/null 2>&1; then _engine=redis
elif command -v mongosh >/dev/null 2>&1 || command -v mongo >/dev/null 2>&1; then _engine=mongodb
elif command -v sqlite3 >/dev/null 2>&1; then _engine=sqlite
else echo "No supported database client found" >&2; exit 1
fi
echo "Detected engine: $_engine"`.trim();
}

function buildMysqlCmd(action, { dbHost, port, dbUser, db }) {
  const h = shellQuote(dbHost);
  const u = dbUser ? `-u ${shellQuote(dbUser)}` : "";
  const p = port ? `-P ${shellQuote(String(port))}` : "";
  const d = db ? shellQuote(db) : "";
  switch (action) {
    case "query":
      return `mysql -h ${h} ${p} ${u} --batch -e "$_DB_QUERY" ${d} 2>&1`;
    case "list-dbs":
      return `mysql -h ${h} ${u} --batch -e "SHOW DATABASES;" 2>&1`;
    case "list-tables":
      return `mysql -h ${h} ${u} --batch -e "SHOW TABLES;" ${d} 2>&1`;
    case "stats":
      return `mysql -h ${h} ${u} --batch -e "SHOW GLOBAL STATUS LIKE 'Threads_connected'; SHOW GLOBAL STATUS LIKE 'Queries'; SELECT VERSION();" 2>&1`;
    case "ping":
      return `mysqladmin -h ${h} ${u} ping 2>&1`;
    case "slow-queries":
      return `mysql -h ${h} ${u} --batch -e "SHOW GLOBAL STATUS LIKE 'Slow_queries'; SELECT * FROM information_schema.PROCESSLIST WHERE TIME > 5;" 2>&1`;
    default:
      throw new Error(`Unknown action for mysql: ${action}`);
  }
}

function buildPostgresCmd(action, { dbHost, port, dbUser, db }) {
  const h = shellQuote(dbHost);
  const u = dbUser ? `-U ${shellQuote(dbUser)}` : "";
  const p = port ? `-p ${shellQuote(String(port))}` : "";
  const d = db ? `-d ${shellQuote(db)}` : "";
  switch (action) {
    case "query":
      return `psql -h ${h} ${p} ${u} ${d} -c "$_DB_QUERY" 2>&1`;
    case "list-dbs":
      return `psql -h ${h} ${u} -l 2>&1`;
    case "list-tables":
      return `psql -h ${h} ${u} ${d} -c "\\dt" 2>&1`;
    case "stats":
      return `psql -h ${h} ${u} ${d} -c "SELECT version(); SELECT count(*) FROM pg_stat_activity;" 2>&1`;
    case "ping":
      return `pg_isready -h ${h} ${p} 2>&1`;
    case "slow-queries":
      return `psql -h ${h} ${u} ${d} -c "SELECT pid,now()-pg_stat_activity.query_start AS duration,query,state FROM pg_stat_activity WHERE now()-pg_stat_activity.query_start > interval '5 seconds';" 2>&1`;
    default:
      throw new Error(`Unknown action for postgres: ${action}`);
  }
}

function buildRedisCmd(action, { dbHost, port }) {
  const h = shellQuote(dbHost);
  const p = port ? shellQuote(String(port)) : shellQuote("6379");
  switch (action) {
    case "query":
      return `redis-cli -h ${h} -p ${p} $_DB_QUERY 2>&1`;
    case "list-dbs":
      return `redis-cli -h ${h} -p ${p} INFO keyspace 2>&1`;
    case "list-tables":
      return `redis-cli -h ${h} -p ${p} INFO keyspace 2>&1`;
    case "stats":
      return `redis-cli -h ${h} -p ${p} INFO server | head -20 && redis-cli -h ${h} -p ${p} INFO stats | grep -E 'connected|commands|hits|misses' 2>&1`;
    case "ping":
      return `redis-cli -h ${h} -p ${p} PING 2>&1`;
    case "slow-queries":
      return `redis-cli -h ${h} -p ${p} SLOWLOG GET 10 2>&1`;
    default:
      throw new Error(`Unknown action for redis: ${action}`);
  }
}

function buildMongoCmd(action, { dbHost, port, db }) {
  const h = shellQuote(dbHost);
  const p = port ? shellQuote(String(port)) : shellQuote("27017");
  const d = db ? shellQuote(db) : shellQuote("admin");
  switch (action) {
    case "query":
      return `mongosh --host ${h} --port ${p} ${d} --eval "$_DB_QUERY" --quiet 2>&1`;
    case "list-dbs":
      return `mongosh --host ${h} --port ${p} --eval "db.adminCommand({listDatabases:1}).databases.map(d=>d.name+' ('+d.sizeOnDisk+' bytes)').join('\\n')" --quiet 2>&1`;
    case "list-tables":
      return `mongosh --host ${h} --port ${p} ${d} --eval "db.getCollectionNames().join('\\n')" --quiet 2>&1`;
    case "stats":
      return `mongosh --host ${h} --port ${p} --eval "JSON.stringify(db.serverStatus().connections); JSON.stringify(db.serverStatus().opcounters)" --quiet 2>&1`;
    case "ping":
      return `mongosh --host ${h} --port ${p} --eval "db.adminCommand({ping:1})" --quiet 2>&1`;
    case "slow-queries":
      return `mongosh --host ${h} --port ${p} --eval "db.adminCommand({currentOp:1,active:true,secs_running:{\\$gte:5}})" --quiet 2>&1`;
    default:
      throw new Error(`Unknown action for mongodb: ${action}`);
  }
}

function buildSqliteCmd(action, { sqliteFile }) {
  const f = shellQuote(sqliteFile);
  switch (action) {
    case "query":
      return `sqlite3 ${f} "$_DB_QUERY" 2>&1`;
    case "list-dbs":
      return `echo "SQLite single-file DB: ${f}" 2>&1`;
    case "list-tables":
      return `sqlite3 ${f} ".tables" 2>&1`;
    case "stats":
      return `sqlite3 ${f} "SELECT COUNT(*) as tables FROM sqlite_master WHERE type='table'; PRAGMA page_count; PRAGMA page_size;" 2>&1`;
    case "ping":
      return `sqlite3 ${f} "SELECT 1;" 2>&1`;
    case "slow-queries":
      return `echo "SQLite does not track slow queries." 2>&1`;
    default:
      throw new Error(`Unknown action for sqlite: ${action}`);
  }
}

function buildScript(engineExpr, action, params, query) {
  const queryExport = query !== undefined && query !== null
    ? `export _DB_QUERY=${JSON.stringify(String(query))}`
    : `export _DB_QUERY=""`;

  // For auto-detect, emit detection block then branch per engine
  if (engineExpr === "auto") {
    const mysql = buildMysqlCmd(action, params);
    const postgres = buildPostgresCmd(action, params);
    const redis = buildRedisCmd(action, params);
    const mongo = buildMongoCmd(action, params);
    const sqlite = buildSqliteCmd(action, params);

    return `set +e
${queryExport}
_dbhost=${shellQuote(params.dbHost)}
_port=${params.port ? shellQuote(String(params.port)) : '""'}
_user=${params.dbUser ? shellQuote(params.dbUser) : '""'}
_db=${params.db ? shellQuote(params.db) : '""'}
_sqlitefile=${params.sqliteFile ? shellQuote(params.sqliteFile) : '""'}
${buildAutoDetect()}
case "$_engine" in
  mysql)    ${mysql} ;;
  postgres) ${postgres} ;;
  redis)    ${redis} ;;
  mongodb)  ${mongo} ;;
  sqlite)   ${sqlite} ;;
  *)        echo "Unsupported engine: $_engine" >&2; exit 1 ;;
esac`;
  }

  let clientCmd;
  switch (engineExpr) {
    case "mysql":    clientCmd = buildMysqlCmd(action, params); break;
    case "postgres": clientCmd = buildPostgresCmd(action, params); break;
    case "redis":    clientCmd = buildRedisCmd(action, params); break;
    case "mongodb":  clientCmd = buildMongoCmd(action, params); break;
    case "sqlite":   clientCmd = buildSqliteCmd(action, params); break;
    default:         throw new Error(`Unknown engine: ${engineExpr}`);
  }

  return `set +e
${queryExport}
_dbhost=${shellQuote(params.dbHost)}
_port=${params.port ? shellQuote(String(params.port)) : '""'}
_user=${params.dbUser ? shellQuote(params.dbUser) : '""'}
_db=${params.db ? shellQuote(params.db) : '""'}
_sqlitefile=${params.sqliteFile ? shellQuote(params.sqliteFile) : '""'}
${clientCmd}`;
}

export const toolDefs = [
  {
    name: "ssh_db",
    title: "SSH Database Operations",
    description: "Run queries or inspect databases on a remote host. Auto-detects MySQL/PostgreSQL/Redis/MongoDB/SQLite. Read-only queries are safe; detected write operations require confirm:true.",
    inputSchema: {
      type: "object",
      properties: {
        target:     { type: "string", description: "SSH target (profile name or user@host)." },
        action:     { type: "string", enum: ["query", "list-dbs", "list-tables", "stats", "ping", "slow-queries"], description: "Operation to perform." },
        engine:     { type: "string", enum: ["auto", "mysql", "postgres", "redis", "mongodb", "sqlite"], description: "Database engine. Default: auto.", default: "auto" },
        query:      { type: "string", description: "SQL or command to run (required for action=query)." },
        database:   { type: "string", description: "Database name to connect to." },
        dbUser:     { type: "string", description: "Database username." },
        dbHost:     { type: "string", description: "Database host. Default: 127.0.0.1." },
        dbPort:     { type: "number", description: "Database port (1-65535)." },
        sqliteFile: { type: "string", description: "Absolute path to SQLite file (required for sqlite engine)." },
        confirm:    { type: "boolean", description: "Required if query contains write keywords." },
        dryRun:     { type: "boolean", description: "Preview command without executing." },
        reason:     { type: "string", description: "Reason for operation (logged)." },
        timeoutMs:  { type: "number", description: "Timeout in milliseconds." },
      },
      required: ["action"],
    },
  },
];

export async function handleTool(name, args) {
  if (name !== "ssh_db") return null;

  // Banned-char checks on all string inputs
  for (const [key, val] of Object.entries(args)) {
    if (typeof val === "string") rejectBanned(val, key);
  }

  const action   = args.action;
  const engine   = args.engine || "auto";
  const query    = args.query;
  const database = args.database;
  const dbUser   = args.dbUser;
  const dbHost   = args.dbHost || "127.0.0.1";
  const dbPort   = args.dbPort;
  const sqliteFile = args.sqliteFile;

  // Validations
  try {
    validateDbName(database, "database");
    validateDbUser(dbUser, "dbUser");
    validateDbHost(dbHost, "dbHost");
    validateDbPort(dbPort, "dbPort");
    validateSqliteFile(sqliteFile, "sqliteFile");
  } catch (e) {
    return textResult(e.message, true);
  }

  // Require query for query action
  if (action === "query" && (!query || !String(query).trim())) {
    return textResult("ssh_db: action=query requires a non-empty query parameter.", true);
  }

  // sqlite engine needs sqliteFile
  if (engine === "sqlite" && (!sqliteFile || !String(sqliteFile).trim())) {
    return textResult("ssh_db: engine=sqlite requires sqliteFile parameter.", true);
  }

  // Write detection
  if (action === "query" && query && WRITE_KEYWORDS.test(query)) {
    if (args.confirm !== true) return requireConfirm("ssh_db (write query detected)", args);
  }

  const params = {
    dbHost,
    port:       dbPort,
    dbUser:     dbUser || null,
    db:         database || null,
    sqliteFile: sqliteFile || null,
  };

  let script;
  try {
    script = buildScript(engine, action, params, query);
  } catch (e) {
    return textResult(`ssh_db build error: ${e.message}`, true);
  }

  if (args.dryRun) return dryRunResult("ssh_db", args, script, args.target);

  try {
    const result = await runSshCommand({
      target:    args.target,
      command:   script,
      mode:      "bash",
      timeoutMs: args.timeoutMs,
    });
    return textResult(formatRunResult(result));
  } catch (e) {
    return textResult(`ssh_db error: ${e.message}`, true);
  }
}
