const express = require('express');
const router = express.Router();
const SQL = require('../modules/database');

const asDecimal = (val) => {
  if (typeof val === 'number') return val;
  const cleaned = (val ?? '').toString().replace(/,/g, '').trim();
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  return isNaN(parsed) ? 0 : parsed;
};

const isInterno = (empresa) => (empresa || '').toString().trim().toLowerCase() === 'interno';
const trimValue = (val) => (val ?? '').toString().trim();
const perfilKey = (val) => {
  const trimmed = trimValue(val);
  if (!trimmed) return '';
  const noZeros = trimmed.replace(/^0+/, '');
  return noZeros || '0';
};

const currencyCatalog = {
  PEN: { symbol: 'S/', label: 'Soles (PEN)' },
  USD: { symbol: 'US$', label: 'Dólares (USD)' },
  EUR: { symbol: 'â?¬', label: 'Euros (EUR)' }
};

const buildCurrencyInfo = (codeRaw, tipoCambioRaw) => {
  const code = (codeRaw || 'PEN').toString().trim().toUpperCase();
  const base = currencyCatalog[code] || { symbol: code, label: code };
  let tipoCambio = Number(tipoCambioRaw);
  if (!Number.isFinite(tipoCambio) || tipoCambio <= 0) tipoCambio = 1;
  const factor = code === 'PEN' ? 1 : (1 / tipoCambio);
  return {
    code,
    symbol: base.symbol,
    label: base.label,
    tipoCambio,
    factor
  };
};
const unique = (arr = []) => Array.from(new Set(arr));
const loadMatrizNames = async (items = [], perfiles = []) => {
  const all = [...(items || []), ...(perfiles || [])];
  const ids = Array.from(new Set(all.map(x => String(x.MatrizId ?? '').trim()).filter(Boolean)));
  if (!ids.length) return { items, perfiles };
  const pm = {};
  const inMs = ids.map((v, i) => { pm['m' + i] = v; return '@m' + i; }).join(',');
  let mats = await SQL.Query('read', `
    SELECT Material AS MatrizId, Descripcion AS Nombre
    FROM dbo.MES_Materiales
    WHERE LTRIM(RTRIM(CAST(Material AS NVARCHAR(50)))) IN (${inMs})
  `, pm);
  if (!Array.isArray(mats) || !mats.length) {
    mats = await SQL.Query('read', `
      SELECT Material AS MatrizId, Descripcion AS Nombre
      FROM dbo.MES_Materiales
    `);
  }
  const byMid = new Map();
  (Array.isArray(mats) ? mats : []).forEach(r => {
    const raw = String(r.MatrizId ?? '').trim();
    const name = r.Nombre;
    const noZero = raw.replace(/^0+/, '');
    const padLen = Math.max(raw.length, 6);
    const pad = noZero.padStart(padLen, '0');
    byMid.set(raw, name);
    if (noZero) byMid.set(noZero, name);
    if (pad) byMid.set(pad, name);
  });
  const mapMatriz = obj => {
    const midRaw = String(obj.MatrizId ?? '').trim();
    const midNoZero = midRaw.replace(/^0+/, '');
    const padLen = Math.max(midRaw.length, 6);
    const pad = midNoZero.padStart(padLen, '0');
    const nombre = byMid.get(midRaw) || byMid.get(midNoZero) || byMid.get(pad) || obj.MatrizNombre || '';
    return { ...obj, MatrizNombre: nombre };
  };
  return {
    items: (items || []).map(mapMatriz),
    perfiles: (perfiles || []).map(mapMatriz)
  };
};

let cotizacionPerfilesSchema = null;
const getCotizacionPerfilesSchema = async () => {
  if (cotizacionPerfilesSchema && cotizacionPerfilesSchema.length) return cotizacionPerfilesSchema;
  try {
    const rows = await SQL.Query('main', `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'laboratorio' AND TABLE_NAME = 'CotizacionPerfiles'
    `);
    cotizacionPerfilesSchema = Array.isArray(rows) ? rows.map(r => (r.COLUMN_NAME || '').toLowerCase()) : [];
  } catch (_) {
    cotizacionPerfilesSchema = [];
  }
  return cotizacionPerfilesSchema;
};

const loadCotizacionPerfiles = async (CotizacionId) => {
  const schema = await getCotizacionPerfilesSchema();
  if (!schema.length) return [];
  const hasPrecioBaseCol = schema.includes('preciobase');
  const hasPrecioCol = schema.includes('precio');
  const hasPrecioUnitarioCol = schema.includes('preciounitario');
  const hasMatrizCol = schema.includes('matrizid');

  let precioExpr = '0 AS PrecioBase';
  if (hasPrecioBaseCol) precioExpr = 'PrecioBase';
  else if (hasPrecioCol) precioExpr = 'Precio AS PrecioBase';
  else if (hasPrecioUnitarioCol) precioExpr = 'PrecioUnitario AS PrecioBase';
  const matrizExpr = hasMatrizCol ? 'MatrizId' : 'NULL AS MatrizId';

  let rows = [];
  try {
    rows = await SQL.Query('main', `
      SELECT PerfilId, Nombre, ${precioExpr}, Cantidad, ${matrizExpr}
      FROM laboratorio.CotizacionPerfiles
      WHERE CotizacionId = @CotizacionId
      ORDER BY PerfilId
    `, { CotizacionId });
  } catch (err) {
    const msg = (err && err.message) ? err.message.toLowerCase() : '';
    if (msg.includes('cotizacionperfiles')) {
      return [];
    }
    throw err;
  }

  let perfiles = Array.isArray(rows)
    ? rows.map(r => ({
        PerfilId: trimValue(r.PerfilId != null ? r.PerfilId : ''),
        Nombre: trimValue(r.Nombre) || '',
        PrecioBase: Number(r.PrecioBase || 0),
        Cantidad: Number(r.Cantidad || 0),
        MatrizId: typeof r.MatrizId !== 'undefined' && r.MatrizId !== null ? r.MatrizId : null,
        MatrizNombre: ''
      }))
    : [];

  const faltantes = unique(perfiles.filter(p => !p.Nombre).map(p => p.PerfilId).filter(Boolean));
  if (faltantes.length) {
    const params = {};
    const inIds = faltantes.map((v, i) => { params['p' + i] = v; return '@p' + i; }).join(',');
    const nombres = await SQL.Query('read', `
      SELECT RTRIM(LTRIM(Perfil)) AS PerfilId, Descripcion
      FROM dbo.LMS_Perfiles
      WHERE RTRIM(LTRIM(Perfil)) IN (${inIds})
    `, params);
    const map = new Map((Array.isArray(nombres) ? nombres : []).map(n => [trimValue(n.PerfilId), n.Descripcion || '']));
    perfiles = perfiles.map(p => ({ ...p, Nombre: p.Nombre || map.get(p.PerfilId) || '' }));
  }

  try {
    const matIds = unique(perfiles.map(p => p.MatrizId).filter(v => v !== null && v !== undefined && v !== ''));
    if (matIds.length) {
      const pm = {};
      const inMs = matIds.map((v,i)=>{ pm['m'+i]=v; return '@m'+i; }).join(',');
      const mats = await SQL.Query('read', `
        SELECT Material AS MatrizId, Descripcion AS Nombre
        FROM dbo.MES_Materiales
        WHERE Material IN (${inMs})
      `, pm);
      const byMid = new Map((Array.isArray(mats) ? mats : []).map(r => [String(r.MatrizId).trim(), r.Nombre]));
      perfiles = perfiles.map(p => ({
        ...p,
        MatrizNombre: byMid.get(String(p.MatrizId).trim()) || ''
      }));
    } else {
      perfiles = perfiles.map(p => ({ ...p, MatrizNombre: '' }));
    }
  } catch (_) {
    perfiles = perfiles.map(p => ({ ...p, MatrizNombre: '' }));
  }

  return perfiles;
};


router.get('/', async (req, res) => {
  let clientes = [];
  let empleados = [];
  let cotizaciones = [];
  let error = null;

  try {
    const rClientes = await SQL.Query('read', 'SELECT * FROM dbo.Ges_Clientes');
    clientes = Array.isArray(rClientes)
      ? rClientes.map(c => ({
          // Campos de Ges_Clientes
          Codigo: c.Codigo ?? null,
          Nombre: c.Nombre ?? null,
          NombreComercial: c.Nombre ?? null,
          Nif: c.Nif ?? null,
          Direccion: c.Direccion ?? null,
          // Conveniencia para mostrar
          Display: ( c.Nombre) ?? ''
        }))
      : [];
    if (rClientes && rClientes.error) error = rClientes.error;
  } catch (e) {
    error = e.message;
  }

  try {
    const rEmpleados = await SQL.Query(
      'main',
      "SELECT EmpleadoId, Nombre = LTRIM(RTRIM(COALESCE(Nombres,'') + ' ' + COALESCE(Apellidos,''))) FROM dbo.Empleados WHERE DepartamentoId IN (16,17,18,19,20)"
    );
    empleados = Array.isArray(rEmpleados) ? rEmpleados : [];
    if (rEmpleados && rEmpleados.error) error = rEmpleados.error;
  } catch (e) {
    error = e.message;
  }

  try {
    const rCoti = await SQL.Query('main', `
      SELECT 
        c.CotizacionId,
        c.Fecha,
        c.Descripcion,
        c.Descuento,
        c.ClienteId,
        c.Aprobada,
        c.Moneda,
        c.TipoCambio,
        e.Nombres + ' ' + e.Apellidos AS Empleado
      FROM laboratorio.Cotizacion c
      LEFT JOIN dbo.Empleados e ON c.EmpleadoId = e.EmpleadoId
      ORDER BY c.CotizacionId DESC
    `);
    cotizaciones = Array.isArray(rCoti) ? rCoti : [];
    if (rCoti && rCoti.error) error = rCoti.error;
  } catch (e) {
    error = e.message;
  }

  // Enriquecer con nombre de cliente desde la BD de solo lectura
  try {
    if (Array.isArray(cotizaciones) && Array.isArray(clientes)) {
      const byCodigo = new Map((clientes||[]).filter(x=>x.Codigo).map(x=>[String(x.Codigo).trim(), x.Display]));
      const byDisplay = new Map((clientes||[]).filter(x=>x.Display).map(x=>[String(x.Display).trim().toUpperCase(), x.Display]));
      cotizaciones = cotizaciones.map(c => {
        const raw = (c.ClienteId||'').toString().trim();
        const code = raw.split(/\s+/)[0];
        const nameOnly = raw.replace(/^\S+\s+/, '').trim();
        const key = (nameOnly || raw).toUpperCase();
        let display = byCodigo.get(code) || byDisplay.get(key) || null;
        if (!display) display = nameOnly || raw;
        return { ...c, Cliente: display };
      });
    }
  } catch (_) {}

  return res.render('cotizaciones', { clientes, empleados, cotizaciones, logged: req.logged, error });
});

// Nueva cotizaciÃ³n (UI con mÃºltiples anÃ¡lisis)
router.get('/nueva', async (req, res) => {
  let clientes = [];
  let empleados = [];
  let matrices = [];
  let perfiles = [];
  let error = null;

  try {
    const rClientes = await SQL.Query('read', 'SELECT * FROM dbo.Ges_Clientes');
    clientes = Array.isArray(rClientes)
      ? rClientes.map(c => ({
          Codigo: c.Codigo ?? c.codigo ?? null,
          Nombre: c.Nombre ?? null,
          NombreComercial: c.Nombre_Comercial ?? null,
          Nif: c.Nif ?? null,
          Direccion: c.Direccion ?? c.direccion ?? null,
          Display: (c.Nombre_Comercial ?? c.Nombre) ?? ''
        }))
      : [];
  } catch (e) { error = e.message; }

  // Matrices para selección (solo lectura)
  try {
    const rMatrices = await SQL.Query('read', `
      SELECT Material AS MatrizId, Descripcion AS Nombre
      FROM dbo.MES_Materiales
      ORDER BY Descripcion
    `);
    matrices = Array.isArray(rMatrices) ? rMatrices : [];
  } catch (e) { error = e.message; }

  // Perfiles disponibles
  try {
    const base = await SQL.Query('read', `
      SELECT RTRIM(LTRIM(Perfil)) AS PerfilId, Descripcion
      FROM dbo.LMS_Perfiles
      ORDER BY Descripcion
    `);
    const precios = await SQL.Query('main', `
      SELECT RTRIM(LTRIM(PerfilId)) AS PerfilId, PrecioBase
      FROM laboratorio.PerfilesLaboratorio
    `);
    const priceMap = new Map((Array.isArray(precios) ? precios : []).map(p => [perfilKey(p.PerfilId), Number(p.PrecioBase || 0)]));
    perfiles = (Array.isArray(base) ? base : []).map(p => {
      const id = trimValue(p.PerfilId);
      const key = perfilKey(id);
      return {
        PerfilId: id,
        Nombre: p.Descripcion || '',
        PrecioBase: priceMap.has(key) ? priceMap.get(key) : null
      };
    }).filter(p => p.PerfilId);
  } catch (e) {
    error = error || e.message;
  }

  return res.render('cotizacion-nueva', { clientes, matrices, perfiles, logged: req.logged, error, coti: null, itemsData: [], perfilesData: [] });
});

// Editar cotización (formulario)
router.get('/:id/editar', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).send('Id inválido');
  let error = null;
  try {
    const header = await SQL.Query('main', `
      SELECT TOP 1
        CotizacionId, Fecha, Descripcion, Descuento, ClienteId, ContactoId,
        Personal, PersonalPrecio, Operativos, OperativosPrecio,
        Consideraciones, ConsideracionesPrecio, Informe, InformePrecio,
        Otros, OtrosPrecio,
        Moneda, TipoCambio, Aprobada
      FROM laboratorio.Cotizacion
      WHERE CotizacionId = @id
    `, { id });
    if (!Array.isArray(header) || !header.length) return res.status(404).send('Cotización no encontrada');
    const h = header[0];
    if (h.Aprobada) return res.status(400).send('No se puede editar una cotización aprobada');

    const rClientes = await SQL.Query('read', 'SELECT * FROM dbo.Ges_Clientes');
    const clientes = Array.isArray(rClientes)
      ? rClientes.map(c => ({
          Codigo: c.Codigo ?? c.codigo ?? null,
          Nombre: c.Nombre ?? null,
          NombreComercial: c.Nombre_Comercial ?? null,
          Nif: c.Nif ?? null,
          Direccion: c.Direccion ?? c.direccion ?? null,
          Display: (c.Nombre_Comercial ?? c.Nombre) ?? ''
        }))
      : [];

    const rMatrices = await SQL.Query('read', `
      SELECT Material AS MatrizId, Descripcion AS Nombre
      FROM dbo.MES_Materiales
      ORDER BY Descripcion
    `);
    const matrices = Array.isArray(rMatrices) ? rMatrices : [];

    const basePerfiles = await SQL.Query('read', `
      SELECT RTRIM(LTRIM(Perfil)) AS PerfilId, Descripcion
      FROM dbo.LMS_Perfiles
      ORDER BY Descripcion
    `);
    const precios = await SQL.Query('main', `
      SELECT RTRIM(LTRIM(PerfilId)) AS PerfilId, PrecioBase
      FROM laboratorio.PerfilesLaboratorio
    `);
    const priceMap = new Map((Array.isArray(precios) ? precios : []).map(p => [perfilKey(p.PerfilId), Number(p.PrecioBase || 0)]));
    const perfiles = (Array.isArray(basePerfiles) ? basePerfiles : []).map(p => {
      const idPf = trimValue(p.PerfilId);
      const key = perfilKey(idPf);
      return {
        PerfilId: idPf,
        Nombre: p.Descripcion || '',
        PrecioBase: priceMap.has(key) ? priceMap.get(key) : null
      };
    }).filter(p => p.PerfilId);

    const detalle = await SQL.Query('main', `
      SELECT ca.AnalisisId AS Ensayo, ca.Empresa, ca.MatrizId, ca.PrecioBase AS Precio, ca.Cantidad, al.Nombre
      FROM laboratorio.CotizacionAnalisis ca
      LEFT JOIN laboratorio.AnalisisLaboratorio al ON al.AnalisisId = ca.AnalisisId
      WHERE ca.CotizacionId = @id
      ORDER BY ca.AnalisisId
    `, { id });
    const itemsData = Array.isArray(detalle) ? detalle.map(d => ({
      AnalisisId: d.Ensayo,
      Ensayo: d.Ensayo,
      Nombre: d.Nombre || '',
      Empresa: d.Empresa || '',
      MatrizId: d.MatrizId || '',
      Precio: Number(d.Precio || 0),
      Cantidad: Number(d.Cantidad || 1),
      Observaciones: ''
    })) : [];

    const perfilesData = await loadCotizacionPerfiles(id);

    // Enriquecer nombres de matriz en items y perfiles
    try {
      const matIds = new Set();
      (itemsData || []).forEach(it => {
        const mid = String(it.MatrizId || '').trim();
        if (mid) matIds.add(mid);
      });
      (perfilesData || []).forEach(pf => {
        const mid = String(pf.MatrizId || '').trim();
        if (mid) matIds.add(mid);
      });
      if (matIds.size) {
        const pm = {};
        const inMs = Array.from(matIds).map((v,i)=>{ pm['m'+i]=v; return '@m'+i; }).join(',');
        const mats = await SQL.Query('read', `
          SELECT Material AS MatrizId, Descripcion AS Nombre
          FROM dbo.MES_Materiales
          WHERE Material IN (${inMs})
        `, pm);
        const byMid = new Map((Array.isArray(mats) ? mats : []).map(r => [String(r.MatrizId).trim(), r.Nombre]));
        itemsData = (itemsData || []).map(it => ({ ...it, MatrizNombre: byMid.get(String(it.MatrizId).trim()) || it.MatrizNombre || '' }));
        perfilesData = (perfilesData || []).map(pf => ({ ...pf, MatrizNombre: byMid.get(String(pf.MatrizId).trim()) || pf.MatrizNombre || '' }));
      }
    } catch (_) {}

    let contactoNombre = '';
    if (h.ContactoId) {
      const contact = await SQL.Query('read', 'SELECT TOP 1 * FROM dbo.Ges_Clientes_Contactos WHERE Codigo = @Codigo', { Codigo: h.ContactoId });
      if (Array.isArray(contact) && contact.length)
        contactoNombre = contact[0].Nombre || '';
    }

    const coti = {
      CotizacionId: h.CotizacionId,
      FechaValue: (h.Fecha && h.Fecha.toISOString) ? h.Fecha.toISOString().split('T')[0] : (h.Fecha || ''),
      Descripcion: h.Descripcion || '',
      Descuento: h.Descuento || 0,
      ClienteId: h.ClienteId || '',
      ContactoId: h.ContactoId || '',
      contactoNombre,
      Personal: h.Personal || '',
      PersonalPrecio: h.PersonalPrecio || 0,
      Operativos: h.Operativos || '',
      OperativosPrecio: h.OperativosPrecio || 0,
      Consideraciones: h.Consideraciones || '',
      ConsideracionesPrecio: h.ConsideracionesPrecio || 0,
      Informe: h.Informe || '',
      InformePrecio: h.InformePrecio || 0,
      Otros: h.Otros || '',
      OtrosPrecio: h.OtrosPrecio || 0,
      Moneda: (h.Moneda || 'PEN').toUpperCase(),
      TipoCambio: h.TipoCambio || 1
    };

    return res.render('cotizacion-nueva', {
      clientes,
      matrices,
      perfiles,
      logged: req.logged,
      error,
      coti,
      itemsData,
      perfilesData
    });
  } catch (e) {
    console.error('Error al cargar edición de cotización:', e);
    return res.status(500).send('Error al cargar la cotización para editar');
  }
});

// API de bÃºsqueda de anÃ¡lisis para autocomplete
router.get('/api/analisis', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  try {
    const ensayos = await SQL.Query('read', `
      SELECT 
        Ensayo,
        Nombre,
        Seccion,
        Metodo_Analitico,
        Limite_Deteccion,
        Limite_Cuantificacion
      FROM dbo.MES_ensayos
      WHERE ISNULL(Baja,0) = 0
    `);
    const complementos = await SQL.Query('main', 'SELECT * FROM laboratorio.AnalisisLaboratorio');
    const compList = Array.isArray(complementos) ? complementos : [];
    const data = (ensayos || []).map(e => {
      const comp = compList.find(c => c.Nombre === e.Nombre) || {};
      return { AnalisisId: comp?.AnalisisId || null, Ensayo: e.Ensayo, Nombre: e.Nombre, Seccion: e.Seccion, Metodo_Analitico: e.Metodo_Analitico, Empresa: (comp?.Subcontratado ? 'Subcontratado' : 'Interno'), Precio: (comp?.PrecioBase ?? comp?.Precio ?? null), LDD: e.Limite_Deteccion || null, LDC: e.Limite_Cuantificacion || null };
    }).filter(x => !q || (`${x.Ensayo} ${x.Nombre} ${x.Empresa || ''}`).toLowerCase().includes(q.toLowerCase()))
      .slice(0, 50);
    return res.json({ ok: true, data });
  } catch (e) {
    return res.json({ ok: false, error: e.message, data: [] });
  }
});

// API: contactos por cliente (por codigo de cliente)
router.get('/api/clientes/:codigo/contactos', async (req, res) => {
  try {
    const codigo = req.params.codigo;
    if (!codigo) return res.json({ ok: true, data: [] });
    const contactos = await SQL.Query('read', `
      SELECT * FROM dbo.Ges_Clientes_Contactos WHERE Cliente = @codigo ORDER BY Nombre
    `, { codigo });
    const data = Array.isArray(contactos) ? contactos.map(c => ({
      Codigo: c.Codigo ?? c.codigo ?? c.CODIGO ?? null,
      Nombre: c.Nombre ?? '',
      Puesto: c.Puesto ?? '',
      Email1: c.Email1 ?? '',
      Telefono_1: c.Telefono_1 ?? ''
    })) : [];
    return res.json({ ok: true, data });
  } catch (e) {
    return res.json({ ok: false, error: e.message, data: [] });
  }
});

// API: obtener analisis por lista de Ensayo (CSV)
router.get('/api/analisis/by-ids', async (req, res) => {
  try {
    const raw = (req.query.ensayos || '').toString();
    const list = raw.split(',').map(x => x.trim()).filter(x => x);
    if (!list.length) return res.json({ ok: true, data: [] });

    const paramsRead = {};
    const inRead = list.map((v, i) => { paramsRead['e' + i] = v; return '@e' + i; }).join(',');
    const ensayos = await SQL.Query('read', `
      SELECT Ensayo, Nombre, Seccion, Metodo_Analitico, Limite_Deteccion, Limite_Cuantificacion
      FROM dbo.MES_ensayos
      WHERE ISNULL(Baja,0) = 0 AND Ensayo IN (${inRead})
    `, paramsRead);

    // Obtener complementos por Nombre (no existe columna 'Ensayo' en AnalisisLaboratorio)
    let complementos = [];
    try {
      const nombres = (Array.isArray(ensayos) ? ensayos : []).map(e => e.Nombre).filter(Boolean);
      if (nombres.length) {
        const paramsMain = {};
        const inMain = nombres.map((v, i) => { paramsMain['n' + i] = v; return '@n' + i; }).join(',');
        complementos = await SQL.Query('main', `
          SELECT *
          FROM laboratorio.AnalisisLaboratorio
          WHERE Nombre IN (${inMain})
        `, paramsMain);
      }
    } catch (_) { complementos = []; }

    const compList = Array.isArray(complementos) ? complementos : [];
    const data = (Array.isArray(ensayos) ? ensayos : []).map(e => {
      const comp = compList.find(c => c.Nombre === e.Nombre) || {};
      return {
        AnalisisId: comp?.AnalisisId || null,
        Ensayo: e.Ensayo,
        Nombre: e.Nombre,
        Seccion: e.Seccion,
        Metodo_Analitico: e.Metodo_Analitico,
        Empresa: (comp?.Subcontratado ? 'Subcontratado' : 'Interno'),
        Precio: (comp?.PrecioBase ?? comp?.Precio ?? null),
        LDD: e.Limite_Deteccion || null,
        LDC: e.Limite_Cuantificacion || null
      };
    });
    return res.json({ ok: true, data });
  } catch (e) {
    return res.json({ ok: false, error: e.message, data: [] });
  }
});

router.get('/api/matrices', async (req, res) => {
  const ensayo = (req.query.ensayo || '').toString().trim();
  if (!ensayo) return res.json({ ok: true, data: [] });
  try {
    const rows = await SQL.Query('read', `
      SELECT em.Material AS MatrizId, m.Descripcion AS Nombre
      FROM dbo.MES_Ensayo_Material em
      LEFT JOIN dbo.MES_Materiales m ON m.Material = em.Material
      WHERE em.Ensayo = @ensayo
      ORDER BY m.Descripcion
    `, { ensayo });
    return res.json({ ok: true, data: Array.isArray(rows) ? rows : [] });
  } catch (e) {
    return res.json({ ok: false, error: e.message, data: [] });
  }
});

// Detalle de una cotizaciÃ³n
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send('Id invÃ¡lido');
  let error = null;
  try {
    const header = await SQL.Query('main', `
      SELECT c.CotizacionId, c.Fecha, c.Descripcion, c.Descuento, c.ClienteId, c.EmpleadoId, c.ContactoId,
             c.Personal, c.PersonalPrecio, c.Operativos, c.OperativosPrecio,
             c.Consideraciones, c.ConsideracionesPrecio, c.Informe, c.InformePrecio,
             c.Otros, c.OtrosPrecio,
             c.Moneda, c.TipoCambio,
             c.Aprobada,
             Emp.Nombre AS EmpleadoNombre
      FROM laboratorio.Cotizacion c
      LEFT JOIN (
        SELECT EmpleadoId, Nombre = LTRIM(RTRIM(COALESCE(Nombres,'') + ' ' + COALESCE(Apellidos,''))) FROM dbo.Empleados
      ) Emp ON Emp.EmpleadoId = c.EmpleadoId
      WHERE c.CotizacionId = @id
    `, { id });

    if (!Array.isArray(header) || !header.length) return res.status(404).send('CotizaciÃ³n no encontrada');
    const h = header[0];
    const currency = buildCurrencyInfo(h.Moneda, h.TipoCambio);

    // Detalle
    const detalle = await SQL.Query('main', `
      SELECT AnalisisId AS Ensayo, Empresa, MatrizId, PrecioBase AS PrecioBase, Cantidad, NULL AS Observaciones
      FROM laboratorio.CotizacionAnalisis
      WHERE CotizacionId = @id
      ORDER BY AnalisisId
    `, { id });

    // Datos de cliente desde lectura (Ges_Clientes) mapeando por cÃ³digo o nombre
    let clienteNombre = '', clienteCodigo = '', clienteRuc = '', clienteDireccion = '';
    {
      const raw = (h.ClienteId || '').toString().trim();
      const code = raw.split(/\s+/)[0];
      let cli = await SQL.Query( 'read' , 'SELECT TOP 1 * FROM dbo.Ges_Clientes WHERE Codigo = @codigo',  {codigo: parseInt(code) });
      
      
      if (Array.isArray(cli) && cli.length) {
        const m = cli[0];
        clienteNombre = (m.Nombre_Comercial ?? m.Nombre) ?? (clienteNombre || raw);
        clienteCodigo = m.Codigo ?? code;
        clienteRuc = m.Nif ?? '';
        clienteDireccion = m.Direccion ?? '';
      }
      if (!clienteNombre) clienteNombre = raw;
    }
    
    // Contacto (Dirigido a)
    let contactoNombre = '';
    if (h.ContactoId) {
      const contact = await SQL.Query('read', 'SELECT TOP 1 * FROM dbo.Ges_Clientes_Contactos WHERE Codigo = @Codigo', { Codigo: h.ContactoId });
      if (Array.isArray(contact) && contact.length)
        contactoNombre = contact[0].Nombre || '';
    }

    // Enriquecer items con Nombre (AnalisisLaboratorio) y LDD/LDC (MES_ensayos)
    let items = Array.isArray(detalle) ? detalle : [];
    try {
      const idList = items.map(x => x.Ensayo).filter(Boolean);
      if (idList.length) {
        const p = {};
        const inIds = idList.map((v,i)=>{ p['a'+i]=v; return '@a'+i; }).join(',');
        const alabs = await SQL.Query('main', `SELECT AnalisisId, Nombre, AcreditadorId FROM laboratorio.AnalisisLaboratorio WHERE AnalisisId IN (${inIds})`, p);
        const byIdMeta = new Map((alabs||[]).map(r => [r.AnalisisId, r]));
        const names = Array.from(new Set((alabs||[]).map(r => r.Nombre).filter(Boolean)));
        let acreditadoresMap = new Map();
        const acreditadorIds = Array.from(new Set((alabs||[]).map(r => r.AcreditadorId).filter(Boolean)));
        if (acreditadorIds.length) {
          const pa = {};
          const inAcc = acreditadorIds.map((v,i)=>{ pa['acc'+i]=v; return '@acc'+i; }).join(',');
          const accRows = await SQL.Query('main', `SELECT AcreditadorId, Nombre FROM laboratorio.Acreditadores WHERE AcreditadorId IN (${inAcc})`, pa);
          acreditadoresMap = new Map((accRows||[]).map(r => [r.AcreditadorId, r.Nombre]));
        }
        if (names.length) {
          const pr = {};
          const inNames = names.map((v,i)=>{ pr['n'+i]=v; return '@n'+i; }).join(',');
          const ens = await SQL.Query('read', `
            SELECT Nombre, Limite_Deteccion, Limite_Cuantificacion, PNT
            FROM dbo.MES_ensayos
            WHERE ISNULL(Baja,0) = 0 AND Nombre IN (${inNames})
          `, pr);
          const byName = new Map((ens||[]).map(r => [r.Nombre, r]));
          let pntMap = new Map();
          const pntCodes = Array.from(new Set((ens||[]).map(r => r.PNT).filter(Boolean)));
          if (pntCodes.length) {
            const procParams = {};
            const inPnt = pntCodes.map((v,i)=>{ procParams['pnt'+i]=v; return '@pnt'+i; }).join(',');
            const pRows = await SQL.Query('read', `
              SELECT Procedimiento, Descripcion
              FROM dbo.LMS_Procedimientos
              WHERE Procedimiento IN (${inPnt})
            `, procParams);
            pntMap = new Map((pRows||[]).map(r => [String(r.Procedimiento).trim(), r.Descripcion || '']));
          }
          items = items.map(it => {
            const meta = byIdMeta.get(it.Ensayo);
            const nm = meta ? meta.Nombre : null;
            const row = nm ? byName.get(nm) : null;
            const acreditadorNombre = meta && meta.AcreditadorId ? acreditadoresMap.get(meta.AcreditadorId) : null;
            const metodoCodigo = row ? row.PNT : null;
            const metodoNombre = metodoCodigo ? (pntMap.get(String(metodoCodigo).trim()) || metodoCodigo) : null;
            return {
              ...it,
              Nombre: nm || '',
              LDD: row ? row.Limite_Deteccion : null,
              LDC: row ? row.Limite_Cuantificacion : null,
              Metodo: metodoNombre || null,
              Acreditador: acreditadorNombre || null
            };
          });
        }
      }
    } catch(_) {}

    // Enriquecer con nombre de Matriz
    try {
      const matIds = Array.from(new Set((items||[]).map(x => String(x.MatrizId || '').trim()).filter(v => v)));
      if (matIds.length) {
        const pm = {};
        const inMs = matIds.map((v,i)=>{ pm['m'+i]=v; return '@m'+i; }).join(',');
        const mats = await SQL.Query('read', `
        SELECT Material AS MatrizId, Descripcion AS Nombre
        FROM dbo.MES_Materiales
        WHERE Material IN (${inMs})
      `, pm);
        const byMid = new Map((mats||[]).map(r => [String(r.MatrizId).trim(), r.Nombre]));
        items = items.map(it => ({ ...it, MatrizNombre: byMid.get(String(it.MatrizId).trim()) || '' }));
      }
    } catch(_) {}

    let perfiles = await loadCotizacionPerfiles(id);

    // Nombre de matriz para items y perfiles
    try {
      const enriched = await loadMatrizNames(items, perfiles);
      items = enriched.items;
      perfiles = enriched.perfiles;
    } catch (_) {}

    // Totales (items + perfiles + extras)
    const subtotalAnalisis = items.reduce((a, x) => a + Number(x.PrecioBase || 0) * Number(x.Cantidad || 0), 0);
    const subtotalItemsInternos = items
      .filter(it => isInterno(it.Empresa))
      .reduce((a, x) => a + Number(x.PrecioBase || 0) * Number(x.Cantidad || 0), 0);
    const subtotalPerfiles = (perfiles || []).reduce((a, p) => a + Number(p.PrecioBase || 0) * Number(p.Cantidad || 0), 0);
    const subtotalItems = subtotalAnalisis + subtotalPerfiles;
    const extras = [
      { key: 'Personal', desc: h.Personal, monto: Number(h.PersonalPrecio || 0) },
      { key: 'Gastos Operativos', desc: h.Operativos, monto: Number(h.OperativosPrecio || 0) },
      { key: 'Consideraciones', desc: h.Consideraciones, monto: Number(h.ConsideracionesPrecio || 0) },
      { key: 'Informe', desc: h.Informe, monto: Number(h.InformePrecio || 0) },
      { key: 'Otros generales', desc: h.Otros, monto: Number(h.OtrosPrecio || 0) }
    ].filter(e => (e.desc && e.desc.toString().trim()) || e.monto);
    const subtotalExtras = extras.reduce((a,e)=> a + Number(e.monto||0), 0);
    const subtotal = subtotalItems + subtotalExtras;
    const descuentoBase = subtotalItemsInternos + subtotalPerfiles;
    const descuentoAplicado = descuentoBase * (Number(h.Descuento || 0) / 100);
    const total = subtotal - descuentoAplicado;
    const igv = total * 0.18;
    const totalConIgv = total + igv;
    
    return res.render('cotizacion-detalle', {
      logged: req.logged,
      header: h,
      clienteNombre,
      clienteRuc,
      clienteDireccion,
      clienteCodigo,
      contactoNombre,
      items,
      perfiles,
      currency,
      extras,
      totales: { subtotalAnalisis, subtotalPerfiles, subtotalItems, subtotalExtras, subtotal, descuentoAplicado, total, igv, totalConIgv }
    });
  } catch (e) {
    error = e.message;
    return res.status(500).send('Error al cargar la cotizaciÃ³n');
  }
});

// Vista imprimible (para PDF via navegador)
router.get('/:id/imprimir', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send('Id invÃ¡lido');
  try {
    const header = await SQL.Query('main', `
      SELECT c.CotizacionId, c.Fecha, c.Descripcion, c.Descuento, c.ClienteId, c.EmpleadoId, c.ContactoId,
             c.Personal, c.PersonalPrecio, c.Operativos, c.OperativosPrecio,
             c.Consideraciones, c.ConsideracionesPrecio, c.Informe, c.InformePrecio,
             c.Otros, c.OtrosPrecio,
             c.Moneda, c.TipoCambio,
             c.Aprobada,
             Emp.Nombre AS EmpleadoNombre
      FROM laboratorio.Cotizacion c
      LEFT JOIN (
        SELECT EmpleadoId, Nombre = LTRIM(RTRIM(COALESCE(Nombres,'') + ' ' + COALESCE(Apellidos,''))) FROM dbo.Empleados
      ) Emp ON Emp.EmpleadoId = c.EmpleadoId
      WHERE c.CotizacionId = @id
    `, { id });
    if (!Array.isArray(header) || !header.length) return res.status(404).send('CotizaciÃ³n no encontrada');
    const h = header[0];
    const currency = buildCurrencyInfo(h.Moneda, h.TipoCambio);

    const detalle = await SQL.Query('main', `
      SELECT AnalisisId AS Ensayo, Empresa, MatrizId, PrecioBase AS PrecioBase, Cantidad, NULL AS Observaciones
      FROM laboratorio.CotizacionAnalisis
      WHERE CotizacionId = @id
      ORDER BY AnalisisId
    `, { id });

    let clienteNombre = '', clienteCodigo = '', clienteRuc = '', clienteDireccion = '';
    {
      const raw = (h.ClienteId || '').toString().trim();
      const code = raw.split(/\s+/)[0];
      
      
      let cli = await SQL.Query('read', 'SELECT TOP 1 * FROM dbo.Ges_Clientes WHERE Codigo = @codigo', { codigo: parseInt(code) });
      if (Array.isArray(cli) && cli.length) {
        const m = cli[0];
        clienteNombre = (m.Nombre_Comercial ?? m.Nombre) ?? (clienteNombre || raw);
        clienteCodigo = m.Codigo ?? code;
        clienteRuc = m.Nif ?? '';
        clienteDireccion = m.Direccion ?? '';
      }
      if (!clienteNombre) clienteNombre = raw;
    }

    // Contacto (Dirigido a)
    let contactoNombre = '';
    if (h.ContactoId) {
      const contact = await SQL.Query('read', 'SELECT TOP 1 * FROM dbo.Ges_Clientes_Contactos WHERE Codigo = @Codigo', { Codigo: h.ContactoId });
      if (Array.isArray(contact) && contact.length)
        contactoNombre = contact[0].Nombre || '';
    }

    let items = Array.isArray(detalle) ? detalle : [];
    // Enriquecer con Nombre (desde AnalisisLaboratorio) y LDD/LDC (desde MES_ensayos)
    try {
      const idList = items.map(x => x.Ensayo).filter(Boolean);
      if (idList.length) {
        const p = {};
        const inIds = idList.map((v,i)=>{ p['a'+i]=v; return '@a'+i; }).join(',');
        const alabs = await SQL.Query('main', `SELECT AnalisisId, Nombre, AcreditadorId FROM laboratorio.AnalisisLaboratorio WHERE AnalisisId IN (${inIds})`, p);
        const byIdMeta = new Map((alabs||[]).map(r => [r.AnalisisId, r]));
        const names = Array.from(new Set((alabs||[]).map(r => r.Nombre).filter(Boolean)));
        let acreditadoresMap = new Map();
        const acreditadorIds = Array.from(new Set((alabs||[]).map(r => r.AcreditadorId).filter(Boolean)));
        if (acreditadorIds.length) {
          const pa = {};
          const inAcc = acreditadorIds.map((v,i)=>{ pa['acc'+i]=v; return '@acc'+i; }).join(',');
          const accRows = await SQL.Query('main', `SELECT AcreditadorId, Nombre FROM laboratorio.Acreditadores WHERE AcreditadorId IN (${inAcc})`, pa);
          acreditadoresMap = new Map((accRows||[]).map(r => [r.AcreditadorId, r.Nombre]));
        }
        if (names.length) {
          const pr = {};
          const inNames = names.map((v,i)=>{ pr['n'+i]=v; return '@n'+i; }).join(',');
          const ens = await SQL.Query('read', `
            SELECT Nombre, Limite_Deteccion, Limite_Cuantificacion, PNT
            FROM dbo.MES_ensayos
            WHERE ISNULL(Baja,0) = 0 AND Nombre IN (${inNames})
          `, pr);
          const byName = new Map((ens||[]).map(r => [r.Nombre, r]));
          let pntMap = new Map();
          const pntCodes = Array.from(new Set((ens||[]).map(r => r.PNT).filter(Boolean)));
          if (pntCodes.length) {
            const procParams = {};
            const inPnt = pntCodes.map((v,i)=>{ procParams['pnt'+i]=v; return '@pnt'+i; }).join(',');
            const procs = await SQL.Query('read', `
              SELECT Procedimiento, Descripcion
              FROM dbo.LMS_Procedimientos
              WHERE Procedimiento IN (${inPnt})
            `, procParams);
            pntMap = new Map((procs||[]).map(r => [String(r.Procedimiento).trim(), r.Descripcion || '']));
          }
          items = items.map(it => {
            const meta = byIdMeta.get(it.Ensayo);
            const nm = meta ? meta.Nombre : null;
            const row = nm ? byName.get(nm) : null;
            const acreditadorNombre = meta && meta.AcreditadorId ? acreditadoresMap.get(meta.AcreditadorId) : null;
            const metodoCodigo = row ? row.PNT : null;
            const metodoNombre = metodoCodigo ? (pntMap.get(String(metodoCodigo).trim()) || metodoCodigo) : null;
            return {
              ...it,
              Nombre: nm || '',
              LDD: row ? row.Limite_Deteccion : null,
              LDC: row ? row.Limite_Cuantificacion : null,
              Metodo: metodoNombre || null,
              Acreditador: acreditadorNombre || null
            };
          });
        }
      }
    } catch(_) {}
    // Enriquecer con nombre de Matriz
    try {
      const matIds = Array.from(new Set((items||[]).map(x => String(x.MatrizId || '').trim()).filter(v => v)));
      if (matIds.length) {
        const pm = {};
        const inMs = matIds.map((v,i)=>{ pm['m'+i]=v; return '@m'+i; }).join(',');
        const mats = await SQL.Query('read', `
        SELECT Material AS MatrizId, Descripcion AS Nombre
        FROM dbo.MES_Materiales
        WHERE Material IN (${inMs})
      `, pm);
        const byMid = new Map((mats||[]).map(r => [String(r.MatrizId).trim(), r.Nombre]));
        items = items.map(it => ({ ...it, MatrizNombre: byMid.get(String(it.MatrizId).trim()) || '' }));
      }
    } catch(_) {}
    let perfiles = await loadCotizacionPerfiles(id);

    // Nombre de matriz para items y perfiles
    try {
      const enriched = await loadMatrizNames(items, perfiles);
      items = enriched.items;
      perfiles = enriched.perfiles;
    } catch (_) {}

    const subtotalAnalisis = items.reduce((a, x) => a + Number(x.PrecioBase || 0) * Number(x.Cantidad || 0), 0);
    const subtotalItemsInternos = items
      .filter(it => isInterno(it.Empresa))
      .reduce((a, x) => a + Number(x.PrecioBase || 0) * Number(x.Cantidad || 0), 0);
    const subtotalPerfiles = (perfiles || []).reduce((a, p) => a + Number(p.PrecioBase || 0) * Number(p.Cantidad || 0), 0);
    const subtotalItems = subtotalAnalisis + subtotalPerfiles;
    const extras = [
      { key: 'Personal', desc: h.Personal, monto: Number(h.PersonalPrecio || 0) },
      { key: 'Gastos Operativos', desc: h.Operativos, monto: Number(h.OperativosPrecio || 0) },
      { key: 'Consideraciones', desc: h.Consideraciones, monto: Number(h.ConsideracionesPrecio || 0) },
      { key: 'Informe', desc: h.Informe, monto: Number(h.InformePrecio || 0) },
      { key: 'Otros generales', desc: h.Otros, monto: Number(h.OtrosPrecio || 0) }
    ].filter(e => (e.desc && e.desc.toString().trim()) || e.monto);
    const subtotalExtras = extras.reduce((a,e)=> a + Number(e.monto||0), 0);
    const subtotal = subtotalItems + subtotalExtras;
    const descuentoBase = subtotalItemsInternos + subtotalPerfiles;
    const descuentoAplicado = descuentoBase * (Number(h.Descuento || 0) / 100);
    const total = subtotal - descuentoAplicado;
    const igv = total * 0.18;
    const totalConIgv = total + igv;

    return res.render('cotizacion-pdf', {
      header: h,
      clienteNombre,
      clienteRuc,
      clienteDireccion,
      clienteCodigo,
      contactoNombre,
      items,
      perfiles,
      currency,
      extras,
      totales: { subtotalAnalisis, subtotalPerfiles, subtotalItems, subtotalExtras, subtotal, descuentoAplicado, total, igv, totalConIgv }
    });
  } catch (e) {
    return res.status(500).send('Error al imprimir');
  }
});

// Solicitud de servicios (PDF sin precios)
router.get('/:id/solicitud', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send('Id invalido');
  try {
    const header = await SQL.Query('main', `
      SELECT c.CotizacionId, c.Fecha, c.Descripcion, c.Descuento, c.ClienteId, c.EmpleadoId, c.ContactoId,
             c.Personal, c.PersonalPrecio, c.Operativos, c.OperativosPrecio,
             c.Consideraciones, c.ConsideracionesPrecio, c.Informe, c.InformePrecio,
             c.Otros, c.OtrosPrecio,
             c.Moneda, c.TipoCambio,
             c.Aprobada,
             Emp.Nombre AS EmpleadoNombre
      FROM laboratorio.Cotizacion c
      LEFT JOIN (
        SELECT EmpleadoId, Nombre = LTRIM(RTRIM(COALESCE(Nombres,'') + ' ' + COALESCE(Apellidos,''))) FROM dbo.Empleados
      ) Emp ON Emp.EmpleadoId = c.EmpleadoId
      WHERE c.CotizacionId = @id
    `, { id });
    if (!Array.isArray(header) || !header.length) return res.status(404).send('Cotizacion no encontrada');
    const h = header[0];
    const currency = buildCurrencyInfo(h.Moneda, h.TipoCambio);

    const detalle = await SQL.Query('main', `
      SELECT AnalisisId AS Ensayo, Empresa, MatrizId, PrecioBase AS PrecioBase, Cantidad, NULL AS Observaciones
      FROM laboratorio.CotizacionAnalisis
      WHERE CotizacionId = @id
      ORDER BY AnalisisId
    `, { id });

    // Cliente (por Codigo exacto)
    let clienteNombre = '', clienteCodigo = '', clienteRuc = '', clienteDireccion = '';
    {
      const raw = (h.ClienteId || '').toString().trim();
      const code = raw.split(/\s+/)[0];
      
      
      let cli = await SQL.Query('read', 'SELECT TOP 1 * FROM dbo.Ges_Clientes WHERE Codigo = @codigo', { codigo: parseInt(code) });
      if (Array.isArray(cli) && cli.length) {
        const m = cli[0];
        clienteNombre = (m.Nombre_Comercial ?? m.Nombre) ?? (clienteNombre || raw);
        clienteCodigo = m.Codigo ?? code;
        clienteRuc = m.Nif ?? '';
        clienteDireccion = m.Direccion ?? '';
      }
      if (!clienteNombre) clienteNombre = raw;
    }
    

    // Contacto (Dirigido a)
    let contactoNombre = '';
    if (h.ContactoId) {
      const contact = await SQL.Query('read', 'SELECT TOP 1 * FROM dbo.Ges_Clientes_Contactos WHERE Codigo = @Codigo', { Codigo: h.ContactoId });
      if (Array.isArray(contact) && contact.length)
        contactoNombre = contact[0].Nombre || '';
    }

    // Enriquecer items con Nombre y LDD/LDC
    let items = Array.isArray(detalle) ? detalle : [];
    try {
      const idList = items.map(x => x.Ensayo).filter(Boolean);
      if (idList.length) {
        const p = {};
        const inIds = idList.map((v,i)=>{ p['a'+i]=v; return '@a'+i; }).join(',');
        const alabs = await SQL.Query('main', `SELECT AnalisisId, Nombre, AcreditadorId FROM laboratorio.AnalisisLaboratorio WHERE AnalisisId IN (${inIds})`, p);
        const byIdMeta = new Map((alabs||[]).map(r => [r.AnalisisId, r]));
        const names = Array.from(new Set((alabs||[]).map(r => r.Nombre).filter(Boolean)));
        let acreditadoresMap = new Map();
        const acreditadorIds = Array.from(new Set((alabs||[]).map(r => r.AcreditadorId).filter(Boolean)));
        if (acreditadorIds.length) {
          const pa = {};
          const inAcc = acreditadorIds.map((v,i)=>{ pa['acc'+i]=v; return '@acc'+i; }).join(',');
          const accRows = await SQL.Query('main', `SELECT AcreditadorId, Nombre FROM laboratorio.Acreditadores WHERE AcreditadorId IN (${inAcc})`, pa);
          acreditadoresMap = new Map((accRows||[]).map(r => [r.AcreditadorId, r.Nombre]));
        }
        if (names.length) {
          const pr = {};
          const inNames = names.map((v,i)=>{ pr['n'+i]=v; return '@n'+i; }).join(',');
          const ens = await SQL.Query('read', `
            SELECT Nombre, Limite_Deteccion, Limite_Cuantificacion, PNT
            FROM dbo.MES_ensayos
            WHERE ISNULL(Baja,0) = 0 AND Nombre IN (${inNames})
          `, pr);
          const byName = new Map((ens||[]).map(r => [r.Nombre, r]));
          let pntMap = new Map();
          const pntCodes = Array.from(new Set((ens||[]).map(r => r.PNT).filter(Boolean)));
          if (pntCodes.length) {
            const procParams = {};
            const inPnt = pntCodes.map((v,i)=>{ procParams['pnt'+i]=v; return '@pnt'+i; }).join(',');
            const procs = await SQL.Query('read', `
              SELECT Procedimiento, Descripcion
              FROM dbo.LMS_Procedimientos
              WHERE Procedimiento IN (${inPnt})
            `, procParams);
            pntMap = new Map((procs||[]).map(r => [String(r.Procedimiento).trim(), r.Descripcion || '']));
          }
          items = items.map(it => {
            const meta = byIdMeta.get(it.Ensayo);
            const nm = meta ? meta.Nombre : null;
            const row = nm ? byName.get(nm) : null;
            const acreditadorNombre = meta && meta.AcreditadorId ? acreditadoresMap.get(meta.AcreditadorId) : null;
            const metodoCodigo = row ? row.PNT : null;
            const metodoNombre = metodoCodigo ? (pntMap.get(String(metodoCodigo).trim()) || metodoCodigo) : null;
            return {
              ...it,
              Nombre: nm || '',
              LDD: row ? row.Limite_Deteccion : null,
              LDC: row ? row.Limite_Cuantificacion : null,
              Metodo: metodoNombre || null,
              Acreditador: acreditadorNombre || null
            };
          });
        }
      }
    } catch(_) {}

    // Enriquecer matriz
    try {
      const matIds = Array.from(new Set((items||[]).map(x => String(x.MatrizId || '').trim()).filter(v => v)));
      if (matIds.length) {
        const pm = {};
        const inMs = matIds.map((v,i)=>{ pm['m'+i]=v; return '@m'+i; }).join(',');
        const mats = await SQL.Query('read', `
        SELECT Material AS MatrizId, Descripcion AS Nombre
        FROM dbo.MES_Materiales
        WHERE Material IN (${inMs})
      `, pm);
        const byMid = new Map((mats||[]).map(r => [String(r.MatrizId).trim(), r.Nombre]));
        items = items.map(it => ({ ...it, MatrizNombre: byMid.get(String(it.MatrizId).trim()) || '' }));
      }
    } catch(_) {}

    let perfiles = await loadCotizacionPerfiles(id);

    // Enriquecer nombre de matriz para items y perfiles
    try {
      const enriched = await loadMatrizNames(items, perfiles);
      items = enriched.items;
      perfiles = enriched.perfiles;
    } catch (_) {}

    // Extras sin montos (solo descripciones)
    const extras = [
      { key: 'Personal', desc: h.Personal },
      { key: 'Gastos Operativos', desc: h.Operativos },
      { key: 'Consideraciones', desc: h.Consideraciones },
      { key: 'Informe', desc: h.Informe },
      { key: 'Otros generales', desc: h.Otros }
    ].filter(e => e.desc && e.desc.toString().trim());

    return res.render('cotizacion-solicitud', {
      header: h,
      clienteNombre,
      clienteRuc,
      clienteDireccion,
      clienteCodigo,
      contactoNombre,
      items,
      currency,
      perfiles,
      extras
    });
  } catch (e) {
    return res.status(500).send('Error al imprimir solicitud');
  }
});
// Crear cotizaciÃ³n con mÃºltiples anÃ¡lisis
router.post('/crear', async (req, res) => {
  try {
    const { Fecha, Descripcion, Descuento = 0 } = req.body;
    let { ClienteId, ContactoId } = req.body;
    const EmpleadoId = req.logged && req.logged.EmpleadoId ? req.logged.EmpleadoId : null;
    if (!EmpleadoId) {
      return res.status(400).send('Empleado no encontrado en la sesión');
    }

    // Extras
    const Personal = (req.body.Personal || '').toString();
    const Operativos = (req.body.Operativos || '').toString();
    const Consideraciones = (req.body.Consideraciones || '').toString();
    const Informe = (req.body.Informe || '').toString();
    const Otros = (req.body.Otros || '').toString();
    const PersonalPrecio = asDecimal(req.body.PersonalPrecio);
    const OperativosPrecio = asDecimal(req.body.OperativosPrecio);
    const ConsideracionesPrecio = asDecimal(req.body.ConsideracionesPrecio);
    const InformePrecio = asDecimal(req.body.InformePrecio);
    const OtrosPrecio = asDecimal(req.body.OtrosPrecio);
    const descuentoNum = asDecimal(Descuento);
    let Moneda = (req.body.Moneda || 'PEN').toString().trim().toUpperCase();
    if (!Moneda) Moneda = 'PEN';
    let TipoCambio = asDecimal(req.body.TipoCambio);
    if (!Number.isFinite(TipoCambio) || TipoCambio <= 0) TipoCambio = 1;
    if (Moneda === 'PEN') TipoCambio = 1;
    let items = [];
    let perfilesSeleccionados = [];
    try {
      items = JSON.parse(req.body.items || '[]');
    } catch (_) { items = []; }
    try {
      perfilesSeleccionados = JSON.parse(req.body.perfiles || '[]');
    } catch (_) { perfilesSeleccionados = []; }

    // Resolver ClienteId si viene como Nombre (desde Ges_Clientes en lectura)
    // No usar laboratorio.ClientesLaboratorio: guardar el cÃ³digo o nombre (de Ges_Clientes) tal cual como ClienteId
    const rawCliente = (ClienteId||'').toString().trim();
    const clienteKey = rawCliente; // ahora el selector envÃ­a solo Codigo

    // Insertar cabecera y obtener id
    const header = await SQL.Query('main', `
      INSERT INTO laboratorio.Cotizacion (
        Fecha, Descripcion, EmpleadoId, Descuento, ClienteId, ContactoId,
        Personal, PersonalPrecio, Operativos, OperativosPrecio,
        Consideraciones, ConsideracionesPrecio, Informe, InformePrecio,
        Otros, OtrosPrecio,
        Moneda, TipoCambio
      )
      OUTPUT INSERTED.CotizacionId AS CotizacionId
      VALUES (
        @Fecha, @Descripcion, @EmpleadoId, @Descuento, @ClienteId, @ContactoId,
        @Personal, @PersonalPrecio, @Operativos, @OperativosPrecio,
        @Consideraciones, @ConsideracionesPrecio, @Informe, @InformePrecio,
        @Otros, @OtrosPrecio,
        @Moneda, @TipoCambio
      )
    `, { Fecha, Descripcion, EmpleadoId, Descuento: descuentoNum, ClienteId: clienteKey, ContactoId,
          Personal, PersonalPrecio, Operativos, OperativosPrecio,
          Consideraciones, ConsideracionesPrecio, Informe, InformePrecio,
          Otros, OtrosPrecio,
          Moneda, TipoCambio });

    if (!Array.isArray(header) || header.length === 0) throw new Error('No se pudo crear la cotizaciÃ³n');
    const CotizacionId = header[0].CotizacionId;

    // Insertar lÃ­neas (detalle)
    for (const it of items) {
      const AnalisisId = it.AnalisisId || it.Ensayo; // fallback a Ensayo si no viene id
      const Cantidad = Number(it.Cantidad || 1);
      const PrecioBase = asDecimal(it.Precio);
      const Empresa = it.Empresa || null;
      let MatrizId = null;
      if (it.MatrizId !== undefined && it.MatrizId !== null) {
        const mid = String(it.MatrizId).trim();
        MatrizId = mid === '' ? null : mid;
      }
      await SQL.Query('main', `
        INSERT INTO laboratorio.CotizacionAnalisis (CotizacionId, AnalisisId, Cantidad, PrecioBase, Empresa, MatrizId)
        VALUES (@CotizacionId, @AnalisisId, @Cantidad, @PrecioBase, @Empresa, @MatrizId)
      `, { CotizacionId, AnalisisId, Cantidad, PrecioBase, Empresa, MatrizId });
    }
    const schemaCols = await getCotizacionPerfilesSchema();
    const hasPrecioBaseCol = schemaCols.includes('preciobase');
    const hasPrecioCol = schemaCols.includes('precio');
    const hasPrecioUnitarioCol = schemaCols.includes('preciounitario');
    const hasMatrizCol = schemaCols.includes('matrizid');
    const precioColumn = hasPrecioBaseCol ? 'PrecioBase' : (hasPrecioCol ? 'Precio' : (hasPrecioUnitarioCol ? 'PrecioUnitario' : null));

    for (const pf of perfilesSeleccionados) {
      const rawPerfilId = trimValue(pf.PerfilId || pf.id);
      if (!rawPerfilId) continue;
      const perfilNumeric = Number(perfilKey(rawPerfilId));
      const PerfilId = Number.isFinite(perfilNumeric) ? perfilNumeric : rawPerfilId;
      const Cantidad = Number(pf.Cantidad || 1);
      const PrecioBase = asDecimal(pf.Precio);
      const NombrePerfil = trimValue(pf.Nombre || pf.Descripcion || '');
      let MatrizId = null;
      if (pf.MatrizId !== undefined && pf.MatrizId !== null) {
        const mid = String(pf.MatrizId).trim();
        MatrizId = mid === '' ? null : mid;
      }

      if (precioColumn) {
        const columns = ['CotizacionId', 'PerfilId', 'Nombre', precioColumn, 'Cantidad'];
        const values = ['@CotizacionId', '@PerfilId', '@Nombre', '@PrecioBase', '@Cantidad'];
        if (hasMatrizCol) {
          columns.push('MatrizId');
          values.push('@MatrizId');
        }
        const sqlInsert = `
          INSERT INTO laboratorio.CotizacionPerfiles (${columns.join(', ')})
          VALUES (${values.join(', ')})
        `;
        await SQL.Query('main', sqlInsert, {
          CotizacionId,
          PerfilId,
          Nombre: NombrePerfil || null,
          PrecioBase,
          Cantidad,
          MatrizId
        });
      } else {
        const columns = ['CotizacionId', 'PerfilId', 'Nombre', 'Cantidad'];
        const values = ['@CotizacionId', '@PerfilId', '@Nombre', '@Cantidad'];
        if (hasMatrizCol) {
          columns.push('MatrizId');
          values.push('@MatrizId');
        }
        const sqlInsert = `
          INSERT INTO laboratorio.CotizacionPerfiles (${columns.join(', ')})
          VALUES (${values.join(', ')})
        `;
        await SQL.Query('main', sqlInsert, {
          CotizacionId,
          PerfilId,
          Nombre: NombrePerfil || null,
          Cantidad,
          MatrizId
        });
      }
    }

    return res.redirect(`/cotizaciones/${CotizacionId}`);
  } catch (err) {
    console.error('Error al crear cotizaciÃ³n con anÃ¡lisis:', err);
    return res.status(500).send('Error al crear la cotizaciÃ³n');
  }
});

// ð??© Crear nueva cotizaciÃ³n
router.post('/agregar', async (req, res) => {
  try {
    const { Fecha, Descripcion, EmpleadoId, Descuento } = req.body;
    let { ClienteId, ContactoId } = req.body;
    // Extras (compatibilidad)
    const Personal = (req.body.Personal || '').toString();
    const Operativos = (req.body.Operativos || '').toString();
    const Consideraciones = (req.body.Consideraciones || '').toString();
    const Informe = (req.body.Informe || '').toString();
    const Otros = (req.body.Otros || '').toString();
    const PersonalPrecio = asDecimal(req.body.PersonalPrecio);
    const OperativosPrecio = asDecimal(req.body.OperativosPrecio);
    const ConsideracionesPrecio = asDecimal(req.body.ConsideracionesPrecio);
    const InformePrecio = asDecimal(req.body.InformePrecio);
    const OtrosPrecio = asDecimal(req.body.OtrosPrecio);
    const descuentoNum = asDecimal(Descuento);

    // No usar laboratorio.ClientesLaboratorio: guardar el cÃ³digo o nombre (de Ges_Clientes) tal cual como ClienteId
    const rawCliente = (ClienteId||'').toString().trim();
    const clienteKey = rawCliente; // ahora el selector envÃ­a solo Codigo

    await SQL.Query('main', `
      INSERT INTO laboratorio.Cotizacion (
        Fecha, Descripcion, EmpleadoId, Descuento, ClienteId, ContactoId,
        Personal, PersonalPrecio, Operativos, OperativosPrecio,
        Consideraciones, ConsideracionesPrecio, Informe, InformePrecio,
        Otros, OtrosPrecio,
        Moneda, TipoCambio
      )
      VALUES (
        @Fecha, @Descripcion, @EmpleadoId, @Descuento, @ClienteId, @ContactoId,
        @Personal, @PersonalPrecio, @Operativos, @OperativosPrecio,
        @Consideraciones, @ConsideracionesPrecio, @Informe, @InformePrecio,
        @Otros, @OtrosPrecio,
        @Moneda, @TipoCambio
      )
    `, { Fecha, Descripcion, EmpleadoId, Descuento: descuentoNum, ClienteId: clienteKey, ContactoId,
          Personal, PersonalPrecio, Operativos, OperativosPrecio,
          Consideraciones, ConsideracionesPrecio, Informe, InformePrecio,
          Otros, OtrosPrecio,
          Moneda, TipoCambio });

    res.redirect('/cotizaciones');
  } catch (err) {
    console.error('Error al crear cotizaciÃ³n:', err);
    res.status(500).send('Error al crear la cotizaciÃ³n');
  }
});

// Eliminar cotizaciÃ³n y su detalle
router.post('/:id/eliminar', async (req, res) => {

  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) return res.status(400).send('Id inv?lido');

  try {

    await SQL.Query('main', 'DELETE FROM laboratorio.CotizacionPerfiles WHERE CotizacionId = @id', { id });

    await SQL.Query('main', 'DELETE FROM laboratorio.CotizacionAnalisis WHERE CotizacionId = @id', { id });

    await SQL.Query('main', 'DELETE FROM laboratorio.Cotizacion WHERE CotizacionId = @id', { id });

    return res.redirect('/cotizaciones');

  } catch (e) {

    console.error('Error al eliminar cotizaci?n:', e);

    return res.status(500).send('Error al eliminar la cotizaci?n');

  }

});



// Soporta GET para entornos donde el formulario no env?a POST correctamente

router.get('/:id/eliminar', async (req, res) => {

  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) return res.status(400).send('Id inv?lido');

  try {

    await SQL.Query('main', 'DELETE FROM laboratorio.CotizacionPerfiles WHERE CotizacionId = @id', { id });

    await SQL.Query('main', 'DELETE FROM laboratorio.CotizacionAnalisis WHERE CotizacionId = @id', { id });

    await SQL.Query('main', 'DELETE FROM laboratorio.Cotizacion WHERE CotizacionId = @id', { id });

    return res.redirect('/cotizaciones');

  } catch (e) {

    console.error('Error al eliminar cotizaci?n (GET):', e);

    return res.status(500).send('Error al eliminar la cotizaci?n');

  }

});



// Duplicar una cotizacion (crea nueva con fecha actual y Aprobada=0)
router.post('/:id/duplicar', async (req, res) => {
  const srcId = parseInt(req.params.id, 10);
  if (isNaN(srcId)) return res.status(400).send('Id invalido');
  try {
    const headerRows = await SQL.Query('main', `
      SELECT TOP 1 *
      FROM laboratorio.Cotizacion
      WHERE CotizacionId = @id
    `, { id: srcId });
    if (!Array.isArray(headerRows) || !headerRows.length) return res.status(404).send('Cotizacion no encontrada');
    const h = headerRows[0];
    const EmpleadoId = (req.logged && req.logged.EmpleadoId) ? req.logged.EmpleadoId : (h.EmpleadoId || null);
    if (!EmpleadoId) return res.status(400).send('Empleado no encontrado en la sesion');
    const Fecha = new Date().toISOString().slice(0, 10);

    const inserted = await SQL.Query('main', `
      INSERT INTO laboratorio.Cotizacion (
        Fecha, Descripcion, EmpleadoId, Descuento, ClienteId, ContactoId,
        Personal, PersonalPrecio, Operativos, OperativosPrecio,
        Consideraciones, ConsideracionesPrecio, Informe, InformePrecio,
        Otros, OtrosPrecio,
        Moneda, TipoCambio,
        Aprobada
      )
      OUTPUT INSERTED.CotizacionId AS CotizacionId
      VALUES (
        @Fecha, @Descripcion, @EmpleadoId, @Descuento, @ClienteId, @ContactoId,
        @Personal, @PersonalPrecio, @Operativos, @OperativosPrecio,
        @Consideraciones, @ConsideracionesPrecio, @Informe, @InformePrecio,
        @Otros, @OtrosPrecio,
        @Moneda, @TipoCambio,
        0
      )
    `, {
      Fecha,
      Descripcion: h.Descripcion || '',
      EmpleadoId,
      Descuento: h.Descuento || 0,
      ClienteId: h.ClienteId,
      ContactoId: h.ContactoId,
      Personal: h.Personal || '',
      PersonalPrecio: h.PersonalPrecio || 0,
      Operativos: h.Operativos || '',
      OperativosPrecio: h.OperativosPrecio || 0,
      Consideraciones: h.Consideraciones || '',
      ConsideracionesPrecio: h.ConsideracionesPrecio || 0,
      Informe: h.Informe || '',
      InformePrecio: h.InformePrecio || 0,
      Otros: h.Otros || '',
      OtrosPrecio: h.OtrosPrecio || 0,
      Moneda: (h.Moneda || 'PEN').toUpperCase(),
      TipoCambio: h.TipoCambio || 1
    });
    if (!Array.isArray(inserted) || !inserted.length) throw new Error('No se pudo duplicar la cotizacion');
    const newId = inserted[0].CotizacionId;

    const itemsSrc = await SQL.Query('main', `
      SELECT AnalisisId, Empresa, MatrizId, PrecioBase, Cantidad
      FROM laboratorio.CotizacionAnalisis
      WHERE CotizacionId = @id
    `, { id: srcId });
    if (Array.isArray(itemsSrc) && itemsSrc.length) {
      for (const it of itemsSrc) {
        await SQL.Query('main', `
          INSERT INTO laboratorio.CotizacionAnalisis (CotizacionId, AnalisisId, Cantidad, PrecioBase, Empresa, MatrizId)
          VALUES (@CotizacionId, @AnalisisId, @Cantidad, @PrecioBase, @Empresa, @MatrizId)
        `, {
          CotizacionId: newId,
          AnalisisId: it.AnalisisId,
          Cantidad: it.Cantidad,
          PrecioBase: it.PrecioBase,
          Empresa: it.Empresa,
          MatrizId: it.MatrizId
        });
      }
    }

    const perfilesSrc = await loadCotizacionPerfiles(srcId);
    const schemaCols = await getCotizacionPerfilesSchema();
    const hasPrecioBaseCol = schemaCols.includes('preciobase');
    const hasPrecioCol = schemaCols.includes('precio');
    const hasPrecioUnitarioCol = schemaCols.includes('preciounitario');
    const hasMatrizCol = schemaCols.includes('matrizid');
    const precioColumn = hasPrecioBaseCol ? 'PrecioBase' : (hasPrecioCol ? 'Precio' : (hasPrecioUnitarioCol ? 'PrecioUnitario' : null));
    for (const pf of (perfilesSrc || [])) {
      const columns = ['CotizacionId', 'PerfilId', 'Nombre', 'Cantidad'];
      const values = ['@CotizacionId', '@PerfilId', '@Nombre', '@Cantidad'];
      if (precioColumn) { columns.push(precioColumn); values.push('@PrecioBase'); }
      if (hasMatrizCol) { columns.push('MatrizId'); values.push('@MatrizId'); }
      const sqlInsert = `
        INSERT INTO laboratorio.CotizacionPerfiles (${columns.join(', ')})
        VALUES (${values.join(', ')})
      `;
      await SQL.Query('main', sqlInsert, {
        CotizacionId: newId,
        PerfilId: pf.PerfilId,
        Nombre: pf.Nombre || null,
        Cantidad: pf.Cantidad || 1,
        PrecioBase: pf.PrecioBase || 0,
        MatrizId: pf.MatrizId ?? null
      });
    }

    return res.redirect(`/cotizaciones/${newId}`);
  } catch (e) {
    console.error('Error al duplicar cotizacion:', e);
    return res.status(500).send('Error al duplicar la cotizacion');
  }
});
// Aprobar cotizacion (POST y GET fallback)
router.post('/:id/aprobar', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send('Id invalido');
  try {
    await SQL.Query('main', 'UPDATE laboratorio.Cotizacion SET Aprobada = 1 WHERE CotizacionId = @id', { id });
    return res.redirect('/cotizaciones/' + id);
  } catch (e) {
    console.error('Error al aprobar cotizacion:', e);
    return res.status(500).send('Error al aprobar la cotizacion');
  }
});

// Editar cotización con múltiples análisis
router.post('/:id/editar', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).send('Id inválido');
  try {
    const hdr = await SQL.Query('main', 'SELECT TOP 1 Aprobada FROM laboratorio.Cotizacion WHERE CotizacionId = @id', { id });
    if (!Array.isArray(hdr) || !hdr.length) return res.status(404).send('Cotización no encontrada');
    if (hdr[0].Aprobada) return res.status(400).send('No se puede editar una cotización aprobada');

    const { Fecha, Descripcion, Descuento = 0 } = req.body;
    let { ClienteId, ContactoId } = req.body;
    const EmpleadoId = req.logged && req.logged.EmpleadoId ? req.logged.EmpleadoId : null;
    if (!EmpleadoId) return res.status(400).send('Empleado no encontrado en la sesión');

    const Personal = (req.body.Personal || '').toString();
    const Operativos = (req.body.Operativos || '').toString();
    const Consideraciones = (req.body.Consideraciones || '').toString();
    const Informe = (req.body.Informe || '').toString();
    const Otros = (req.body.Otros || '').toString();
    const PersonalPrecio = asDecimal(req.body.PersonalPrecio);
    const OperativosPrecio = asDecimal(req.body.OperativosPrecio);
    const ConsideracionesPrecio = asDecimal(req.body.ConsideracionesPrecio);
    const InformePrecio = asDecimal(req.body.InformePrecio);
    const OtrosPrecio = asDecimal(req.body.OtrosPrecio);
    const descuentoNum = asDecimal(Descuento);
    let Moneda = (req.body.Moneda || 'PEN').toString().trim().toUpperCase();
    if (!Moneda) Moneda = 'PEN';
    let TipoCambio = asDecimal(req.body.TipoCambio);
    if (!Number.isFinite(TipoCambio) || TipoCambio <= 0) TipoCambio = 1;
    if (Moneda === 'PEN') TipoCambio = 1;

    let items = [];
    let perfilesSeleccionados = [];
    try { items = JSON.parse(req.body.items || '[]'); } catch (_) { items = []; }
    try { perfilesSeleccionados = JSON.parse(req.body.perfiles || '[]'); } catch (_) { perfilesSeleccionados = []; }

    const rawCliente = (ClienteId||'').toString().trim();
    const clienteKey = rawCliente;

    // Catálogo de matrices desde lectura para validar ids
    let materialSet = new Set();
    try {
      const matsRead = await SQL.Query('read', 'SELECT Material FROM dbo.MES_Materiales');
      if (Array.isArray(matsRead)) {
        matsRead.forEach(m => {
          if (m && typeof m.Material !== 'undefined' && m.Material !== null) materialSet.add(String(m.Material));
        });
      }
    } catch (_) { materialSet = new Set(); }

    await SQL.Query('main', `
      UPDATE laboratorio.Cotizacion SET
        Fecha = @Fecha,
        Descripcion = @Descripcion,
        EmpleadoId = @EmpleadoId,
        Descuento = @Descuento,
        ClienteId = @ClienteId,
        ContactoId = @ContactoId,
        Personal = @Personal,
        PersonalPrecio = @PersonalPrecio,
        Operativos = @Operativos,
        OperativosPrecio = @OperativosPrecio,
        Consideraciones = @Consideraciones,
        ConsideracionesPrecio = @ConsideracionesPrecio,
        Informe = @Informe,
        InformePrecio = @InformePrecio,
        Otros = @Otros,
        OtrosPrecio = @OtrosPrecio,
        Moneda = @Moneda,
        TipoCambio = @TipoCambio
      WHERE CotizacionId = @CotizacionId
    `, {
      CotizacionId: id,
      Fecha,
      Descripcion,
      EmpleadoId,
      Descuento: descuentoNum,
      ClienteId: clienteKey,
      ContactoId,
      Personal, PersonalPrecio, Operativos, OperativosPrecio,
      Consideraciones, ConsideracionesPrecio, Informe, InformePrecio,
      Otros, OtrosPrecio,
      Moneda, TipoCambio
    });

    await SQL.Query('main', 'DELETE FROM laboratorio.CotizacionAnalisis WHERE CotizacionId = @id', { id });
    for (const it of items) {
      const AnalisisId = it.AnalisisId || it.Ensayo;
      const Cantidad = Number(it.Cantidad || 1);
      const PrecioBase = asDecimal(it.Precio);
      const Empresa = it.Empresa || null;
      let MatrizId = null;
      if (it.MatrizId !== undefined && it.MatrizId !== null) {
        const mid = String(it.MatrizId).trim();
        MatrizId = mid === '' ? null : mid;
      }
      await SQL.Query('main', `
        INSERT INTO laboratorio.CotizacionAnalisis (CotizacionId, AnalisisId, Cantidad, PrecioBase, Empresa, MatrizId)
        VALUES (@CotizacionId, @AnalisisId, @Cantidad, @PrecioBase, @Empresa, @MatrizId)
      `, { CotizacionId: id, AnalisisId, Cantidad, PrecioBase, Empresa, MatrizId });
    }

    await SQL.Query('main', 'DELETE FROM laboratorio.CotizacionPerfiles WHERE CotizacionId = @id', { id });
    const schemaCols = await getCotizacionPerfilesSchema();
    const hasPrecioBaseCol = schemaCols.includes('preciobase');
    const hasPrecioCol = schemaCols.includes('precio');
    const hasPrecioUnitarioCol = schemaCols.includes('preciounitario');
    const hasMatrizCol = schemaCols.includes('matrizid');
    const precioColumn = hasPrecioBaseCol ? 'PrecioBase' : (hasPrecioCol ? 'Precio' : (hasPrecioUnitarioCol ? 'PrecioUnitario' : null));

    for (const pf of perfilesSeleccionados) {
      const rawPerfilId = trimValue(pf.PerfilId || pf.id);
      if (!rawPerfilId) continue;
      const perfilNumeric = Number(perfilKey(rawPerfilId));
      const PerfilId = Number.isFinite(perfilNumeric) ? perfilNumeric : rawPerfilId;
      const Cantidad = Number(pf.Cantidad || 1);
      const PrecioBase = asDecimal(pf.Precio);
      const NombrePerfil = trimValue(pf.Nombre || pf.Descripcion || '');
      let MatrizId = null;
      if (pf.MatrizId !== undefined && pf.MatrizId !== null) {
        const mid = String(pf.MatrizId).trim();
        MatrizId = mid === '' ? null : mid;
      }

      if (precioColumn) {
        const columns = ['CotizacionId', 'PerfilId', 'Nombre', precioColumn, 'Cantidad'];
        const values = ['@CotizacionId', '@PerfilId', '@Nombre', '@PrecioBase', '@Cantidad'];
        if (hasMatrizCol) {
          columns.push('MatrizId');
          values.push('@MatrizId');
        }
        const sqlInsert = `
          INSERT INTO laboratorio.CotizacionPerfiles (${columns.join(', ')})
          VALUES (${values.join(', ')})
        `;
        await SQL.Query('main', sqlInsert, {
          CotizacionId: id,
          PerfilId,
          Nombre: NombrePerfil || null,
          PrecioBase,
          Cantidad,
          MatrizId
        });
      } else {
        const columns = ['CotizacionId', 'PerfilId', 'Nombre', 'Cantidad'];
        const values = ['@CotizacionId', '@PerfilId', '@Nombre', '@Cantidad'];
        if (hasMatrizCol) {
          columns.push('MatrizId');
          values.push('@MatrizId');
        }
        const sqlInsert = `
          INSERT INTO laboratorio.CotizacionPerfiles (${columns.join(', ')})
          VALUES (${values.join(', ')})
        `;
        await SQL.Query('main', sqlInsert, {
          CotizacionId: id,
          PerfilId,
          Nombre: NombrePerfil || null,
          Cantidad,
          MatrizId
        });
      }
    }

    return res.redirect(`/cotizaciones/${id}`);
  } catch (err) {
    console.error('Error al editar cotización:', err);
    return res.status(500).send('Error al editar la cotización');
  }
});

router.get('/:id/aprobar', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).send('Id invalido');
  try {
    await SQL.Query('main', 'UPDATE laboratorio.Cotizacion SET Aprobada = 1 WHERE CotizacionId = @id', { id });
    return res.redirect('/cotizaciones/' + id);
  } catch (e) {
    console.error('Error al aprobar cotizacion (GET):', e);
    return res.status(500).send('Error al aprobar la cotizacion');
  }
});

module.exports = router;






