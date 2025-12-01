const express = require('express');
const router = express.Router();
const { Query } = require('../modules/database');

router.get('/', async (req, res) => {
  let acreditadores = [];
  try {
    const listaAcreditadores = await Query('main', 'SELECT AcreditadorId, Nombre FROM laboratorio.Acreditadores ORDER BY Nombre');
    acreditadores = Array.isArray(listaAcreditadores) ? listaAcreditadores : [];

    // Datos base desde lectura (MES_ensayos)
    const ensayos = await Query('read', `
      SELECT 
        Ensayo,
        Nombre,
        Seccion,
        Tecnica,
        PNT,
        Limite_Deteccion,
        Limite_Cuantificacion
      FROM dbo.MES_ensayos
    `);

    // Catalogo de procedimientos para obtener el método
    const procedimientos = await Query('read', `
      SELECT RTRIM(LTRIM(Procedimiento)) AS Procedimiento, Descripcion
      FROM dbo.LMS_Procedimientos
    `);
    const procMap = new Map(
      (Array.isArray(procedimientos) ? procedimientos : []).map(p => [ (p.Procedimiento || '').toString().trim(), p.Descripcion || '' ])
    );

    // Complementos desde la BD principal
    const complementos = await Query('main', 'SELECT * FROM laboratorio.AnalisisLaboratorio');
    const listaComplementos = Array.isArray(complementos) ? complementos : [];

    // Unir ambos conjuntos
    const analisis = (ensayos || []).map(e => {
      const comp = listaComplementos.find(c => c.Nombre === e.Nombre);
      const pntCode = (e.PNT || '').toString().trim();
      const metodo = procMap.get(pntCode) || e.Tecnica || '';
      return {
        ...e,
        Metodo: metodo,
        AnalisisId: comp ? comp.AnalisisId : null,
        EsExterno: comp ? comp.EsExterno : 0,
        Empresa: comp ? (comp.Subcontratado ? 'Subcontratado' : 'Interno') : 'Interno',
        Precio: comp ? (comp.PrecioBase ?? comp.Precio ?? null) : null,
        Observaciones: comp ? comp.Observaciones : null,
        AcreditadorId: comp ? comp.AcreditadorId : null,
        LDD: e.Limite_Deteccion || null,
        LDC: e.Limite_Cuantificacion || null
      };
    });

    res.render('analisis', { analisis, acreditadores, logged: req.logged });
  } catch (err) {
    console.error('Error al obtener análisis combinados:', err);
    res.status(500).send('Error al obtener análisis');
  }
});

router.post('/guardar', async (req, res) => {
  const { Ensayo, Empresa, Precio, Observaciones, AnalisisId, Nombre } = req.body;
  const acreditadorId = req.body.AcreditadorId ? Number(req.body.AcreditadorId) : null;

  try {
    // Preferir UPDATE por AnalisisId; si no viene, intentar resolver por Nombre; si no existe, INSERT
    let id = AnalisisId;
    if (!id && Nombre) {
      const found = await Query('main', 'SELECT TOP 1 AnalisisId FROM laboratorio.AnalisisLaboratorio WHERE Nombre = @Nombre', { Nombre });
      if (Array.isArray(found) && found.length) id = found[0].AnalisisId;
    }

    if (id) {
      await Query('main', `
        UPDATE laboratorio.AnalisisLaboratorio
        SET PrecioBase = @Precio,
            AcreditadorId = @AcreditadorId
        WHERE AnalisisId = @AnalisisId
      `, { AnalisisId: id, Precio, AcreditadorId: acreditadorId });
    } else if (Nombre) {
      const found2 = await Query('main', 'SELECT TOP 1 AnalisisId FROM laboratorio.AnalisisLaboratorio WHERE Nombre = @Nombre', { Nombre });
      if (Array.isArray(found2) && found2.length) {
        await Query('main', `
          UPDATE laboratorio.AnalisisLaboratorio
          SET PrecioBase = @Precio,
              AcreditadorId = @AcreditadorId
          WHERE AnalisisId = @AnalisisId
        `, { AnalisisId: found2[0].AnalisisId, Precio, AcreditadorId: acreditadorId });
      } else {
        await Query('main', `
          INSERT INTO laboratorio.AnalisisLaboratorio (Nombre, PrecioBase, AcreditadorId)
          VALUES (@Nombre, @Precio, @AcreditadorId)
        `, { Nombre, Precio, AcreditadorId: acreditadorId });
      }
    }

    res.redirect('/analisis');
  } catch (e) {
    console.error('Error al guardar complemento:', e);
    res.status(500).send('Error al guardar');
  }
});

module.exports = router;
