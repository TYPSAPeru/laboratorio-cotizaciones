// modules/database.js
require('dotenv').config();
const sql = require('mssql');

// 🧩 Configuración de bases de datos
const mainConfig = {
  server: process.env.DB_HOST,
  database: process.env.DB_DATA,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  options: { encrypt: false, enableArithAbort: true }
};

const readConfig = {
  server: process.env.DI_HOST,
  database: process.env.DI_DATA,
  user: process.env.DI_USER,
  password: process.env.DI_PASS,
  options: { encrypt: false, enableArithAbort: true }
};

let mainPool = null;
let readPool = null;

// 📦 Función genérica para obtener conexiones
async function getPool(config, poolName) {
  try {
    if (poolName === 'main' && mainPool) return mainPool;
    if (poolName === 'read' && readPool) return readPool;

    const pool = await new sql.ConnectionPool(config).connect();
    console.log(`✅ SQL Connected [${poolName}] - ${config.database}`);

    if (poolName === 'main') mainPool = pool;
    else readPool = pool;

    return pool;
  } catch (err) {
    console.error(`❌ connect error: ${poolName}:`, err.message);
    return { error: err.message };
  }
}

// 🧮 Ejecutar consultas directas (SELECT)
async function Query(poolName, query, params = {}) {
  try {
    const pool = await getPool(poolName === 'read' ? readConfig : mainConfig, poolName);
    if (pool.error) return pool;

    const request = pool.request();
    for (const [key, value] of Object.entries(params))
      request.input(key, value);

    const result = await request.query(query);
    return result.recordset || [];
  } catch (err) {
    console.error(`💥 SQL ${poolName} Query Error:`, err);
    return { error: err.message };
  }
}

// ⚙️ Ejecutar procedimientos almacenados
async function Execute(poolName, procedure, params = {}) {
  try {
    const pool = await getPool(poolName === 'read' ? readConfig : mainConfig, poolName);
    if (pool.error) return pool;

    const request = pool.request();
    for (const [key, value] of Object.entries(params))
      request.input(key, value);

    const result = await request.execute(procedure);
    return result.recordset || [];
  } catch (err) {
    console.error(`💥 SQL ${poolName} Execute Error:`, err);
    return { error: err.message };
  }
}

module.exports = { Query, Execute };

