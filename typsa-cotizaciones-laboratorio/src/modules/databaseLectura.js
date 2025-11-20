const sql = require('mssql');

const config = {
  server: process.env.DI_HOST,     // base de solo lectura
  database: process.env.DI_DATA,
  user: process.env.DI_USER,
  password: process.env.DI_PASS,
  options: {
    encrypt: false,
    enableArithAbort: true
  }
};

let pool = null;

async function GetDB() {
  try {
    if (pool) return pool;
    pool = await sql.connect(config);
    console.log('SQL Server Lectura', 'Connected to LABO_COTI');
    return pool;
  } catch (e) {
    console.log('SQL Server Lectura', 'GetDB Error', e);
    return { error: e.message };
  }
}

async function Query(query, params = {}) {
  try {
    const pool = await GetDB();
    if (pool.error) return pool;

    const request = pool.request();
    for (const [key, value] of Object.entries(params)) request.input(key, value);

    const result = await request.query(query);
    return result.recordset || [];
  } catch (e) {
    console.log('SQL Server Lectura', 'Query Error', e);
    return { error: e.message };
  }
}

module.exports = { Query };
