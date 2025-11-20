const express = require('express');
const router = express.Router();
const SQL = require('../modules/database');

const asDecimal = (val) => {
  if (val === null || typeof val === 'undefined') return null;
  const clean = String(val).replace(/[^0-9.,-]+/g, '').replace(',', '.').trim();
  if (!clean) return null;
  const num = Number(clean);
  return Number.isFinite(num) ? num : null;
};

const normalizeId = (val) => (val ?? '').toString().trim();
const perfilKey = (val) => {
  const normalized = normalizeId(val);
  if (!normalized) return '';
  const noZeros = normalized.replace(/^0+/, '');
  return noZeros || '0';
};

router.get('/', async (req, res) => {
  let perfiles = [];
  let error = null;
  try {
    const base = await SQL.Query('read', `
      SELECT RTRIM(LTRIM(Perfil)) AS PerfilId, Descripcion AS Nombre, Notas
      FROM dbo.LMS_Perfiles
    `);
    const precios = await SQL.Query('main', `
      SELECT RTRIM(LTRIM(PerfilId)) AS PerfilId, PrecioBase, Nombre
      FROM laboratorio.PerfilesLaboratorio
    `);
    const analisisCounts = await SQL.Query('read', `
      SELECT RTRIM(LTRIM(Perfil)) AS PerfilId, COUNT(*) AS Total
      FROM dbo.LMS_Ensayos_Perfiles
      GROUP BY RTRIM(LTRIM(Perfil))
    `);

    const priceMap = new Map();
    (Array.isArray(precios) ? precios : []).forEach(p => {
      const key = perfilKey(p.PerfilId);
      if (!key) return;
      priceMap.set(key, p);
    });

    const countMap = new Map();
    (Array.isArray(analisisCounts) ? analisisCounts : []).forEach(c => {
      const key = perfilKey(c.PerfilId);
      if (!key) return;
      countMap.set(key, c.Total);
    });

    perfiles = (Array.isArray(base) ? base : []).map(p => {
      const rawId = normalizeId(p.PerfilId);
      const key = perfilKey(rawId);
      const price = priceMap.get(key);
      return {
        PerfilId: rawId || key,
        PerfilKey: key,
        Nombre: p.Nombre || '',
        Descripcion: p.Notas || '',
        AnalisisCount: countMap.get(key) || 0,
        PrecioBase: price ? price.PrecioBase : null
      };
    }).sort((a, b) => a.Nombre.localeCompare(b.Nombre));
  } catch (e) {
    error = e.message;
  }

  return res.render('perfiles', { perfiles, error, logged: req.logged });
});

router.post('/:id/precio', async (req, res) => {
  const PerfilIdRaw = normalizeId(req.params.id);
  const PerfilId = perfilKey(PerfilIdRaw);
  if (!PerfilId) return res.status(400).send('Perfil inválido');
  const PrecioBase = asDecimal(req.body.PrecioBase);
  const Nombre = (req.body.Nombre || '').toString().trim();

  try {
    await SQL.Query('main', `
      MERGE laboratorio.PerfilesLaboratorio AS target
      USING (SELECT @PerfilId AS PerfilId) AS src
      ON RTRIM(LTRIM(target.PerfilId)) = RTRIM(LTRIM(src.PerfilId))
      WHEN MATCHED THEN
        UPDATE SET PrecioBase = @PrecioBase, Nombre = CASE WHEN LEN(@Nombre) > 0 THEN @Nombre ELSE target.Nombre END
      WHEN NOT MATCHED THEN
        INSERT (PerfilId, Nombre, PrecioBase)
        VALUES (@PerfilId, @Nombre, @PrecioBase);
    `, { PerfilId, PrecioBase, Nombre: Nombre || null });
    return res.redirect('/perfiles');
  } catch (e) {
    console.error('Error al guardar perfil:', e);
    return res.status(500).send('Error al guardar el precio del perfil');
  }
});

router.get('/:id/analisis', async (req, res) => {
  const PerfilId = normalizeId(req.params.id);
  if (!PerfilId) return res.json({ ok: false, error: 'Perfil inválido', data: [] });
  try {
    const lista = await SQL.Query('read', `
      SELECT pa.Perfil AS PerfilId, pa.Ensayo AS AnalisisId, ens.Nombre
      FROM dbo.LMS_Ensayos_Perfiles pa
      LEFT JOIN dbo.MES_ensayos ens ON ens.Ensayo = pa.Ensayo
      WHERE RTRIM(LTRIM(pa.Perfil)) = @PerfilId
      ORDER BY ens.Nombre
    `, { PerfilId: PerfilId });
    return res.json({ ok: true, data: Array.isArray(lista) ? lista : [] });
  } catch (e) {
    return res.json({ ok: false, error: e.message, data: [] });
  }
});

module.exports = router;
