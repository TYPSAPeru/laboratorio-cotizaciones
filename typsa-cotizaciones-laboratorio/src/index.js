require('dotenv').config();
require('./modules/logger');
const SQL = require('./modules/database');
process.permisos = require('./modules/permisos.json');


const express = require('express');
const app = express();

const cookieParser = require("cookie-parser");
app.use(cookieParser());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.static(__dirname + '/assets'));

const LOGIN_URL = process.env.LOGIN_URL || 'https://login.typsa.pe/';

app.use(async function (req, res, next) {
	res.locals.permisos = process.permisos || {};
	res.locals.logged = null;
	res.locals.hasPermiso = () => false;

	const attachLogged = (logged) => {
		req.logged = logged;
		res.locals.logged = logged;
		res.locals.hasPermiso = (permisoRequerido) => {
			if (!logged || typeof logged.TienePermiso !== 'function') return false;
			return logged.TienePermiso(permisoRequerido);
		};
	};

	if (process.env.NODE_ENV === 'development') {
		const granted = Object.values(process.permisos || {});
		const logged = {
			EmpleadoId: 1,
			Nombre: 'Desarrollador Local',
			Permisos: granted.map(p => (p || '').toString().trim().toUpperCase()),
			TienePermiso(requerido = []) {
				const lista = Array.isArray(requerido) ? requerido : [requerido];
				if (!lista.length) return true;
				return lista.every(perm => {
					if (!perm) return true;
					return this.Permisos.includes(perm.toString().trim().toUpperCase());
				});
			}
		};
		attachLogged(logged);
		return next();
	}

	let UUID = process.env.UUID || (req.cookies ? req.cookies.UUID : null);
	if (!UUID) return res.redirect(LOGIN_URL);

	const sesiones = await SQL.Query('main', `
      SELECT TOP 1 UUID, EmpleadoId, Expiracion
      FROM dbo.Sesiones
      WHERE UUID = @UUID
      ORDER BY Expiracion DESC
    `, { UUID });
	if (sesiones && sesiones.error) {
		console.error('Error obteniendo la sesión:', sesiones.error);
		return res.render('error', { logged: null, error: 'I3K77R', msg: 'No se pudo validar la sesión.' });
	}
	if (!Array.isArray(sesiones) || !sesiones.length) return res.redirect(LOGIN_URL);
	const sesion = sesiones[0];
	if (sesion.Expiracion && Date.now() > new Date(sesion.Expiracion).getTime()) return res.redirect(LOGIN_URL);

	const logged = {
		UUID,
		EmpleadoId: sesion.EmpleadoId,
		Nombre: sesion.Nombre || '',
		Permisos: [],
		PermisoIds: []
	};

	const permisosRows = await SQL.Query('main', `
      SELECT ep.PermisoId, p.Nombre
      FROM dbo.EmpleadosPermisos ep
      LEFT JOIN dbo.Permisos p ON p.PermisoId = ep.PermisoId
      WHERE ep.EmpleadoId = @EmpleadoId
    `, { EmpleadoId: logged.EmpleadoId });
	if (permisosRows && permisosRows.error) {
		console.error('Error obteniendo permisos:', permisosRows.error);
		return res.render('error', { logged: null, error: 'U3J77C', msg: 'No se pudieron obtener los permisos.' });
	}
	const nombres = new Set();
	const ids = new Set();
	(permisosRows || []).forEach(row => {
		if (row.PermisoId !== null && typeof row.PermisoId !== 'undefined') {
			ids.add(row.PermisoId);
		}
		const nombre = (row.Nombre || row.PermisoId || '').toString().trim();
		if (nombre) nombres.add(nombre.toUpperCase());
	});
	logged.Permisos = Array.from(nombres);
	logged.PermisoIds = Array.from(ids);

	logged.TienePermiso = function (requerido = []) {
		if (!requerido || (Array.isArray(requerido) && requerido.length === 0)) return true;
		const lista = Array.isArray(requerido) ? requerido : [requerido];
		if (!lista.length) return true;
		return lista.every(perm => {
			if (!perm) return true;
			const normalizado = perm.toString().trim().toUpperCase();
			if (!normalizado) return true;
			return this.Permisos.includes(normalizado);
		});
	};

	attachLogged(logged);
	return next();
});

app.use('/', require('./routes/general'));
app.use('/analisis', require('./routes/analisis'));
app.use('/cotizaciones', require('./routes/cotizacion'));
app.use('/analisisInternos', require('./routes/analisis'));
app.use('/matrices', require('./routes/matriz'));
app.use('/perfiles', require('./routes/perfiles'));

app.listen(process.env.PORT, async function () {
	console.log("========== Servidor Iniciado ==========");
	console.log("Zona Horaria:", process.env.TZ);
	console.log("Entorno:", process.env.NODE_ENV);
	console.log("Host:", process.env.HOST);
	console.log("Puerto:", process.env.PORT);
	console.log("Datos:", process.env.DB_DATA);
	console.log("=======================================");
});
