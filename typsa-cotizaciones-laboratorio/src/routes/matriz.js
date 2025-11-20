const express = require('express');
const router = express.Router();
const SQL = require('../modules/database');

// Lista de matrices (UI)
const READ_QUERY = `
  SELECT Material AS MatrizId, Descripcion AS Nombre
  FROM dbo.MES_Materiales
  ORDER BY Descripcion
`;

router.get('/', async (req, res) => {
  try {
    const matrices = await SQL.Query('read', READ_QUERY);
    return res.render('matrices', {
      logged: req.logged,
      matrices: Array.isArray(matrices) ? matrices : [],
      error: matrices && matrices.error
    });
  } catch (e) {
    return res.render('matrices', { logged: req.logged, matrices: [], error: e.message });
  }
});

router.get('/api', async (req, res) => {
  try {
    const matrices = await SQL.Query('read', READ_QUERY);
    return res.json({ ok: true, data: Array.isArray(matrices) ? matrices : [] });
  } catch (e) {
    return res.json({ ok: false, error: e.message, data: [] });
  }
});

module.exports = router;
