const SQL = require('../modules/database');

const express = require('express');
const router = express.Router();

router.use('*', async function (req, res, next) {
    if (!req.logged.TienePermiso(process.permisos.administrador))
        return res.status(500).render('error', { logged: req.logged, id: 'LDF98G', texto: 'Usted no tiene permiso de acceder a este recurso' });
    next();
});

async function Report  (FechaInicio, FechaFin, filtro, area, colaborador) {

    var empleados = await SQL.Execute('Asistencia_Leer_Rango', { FechaInicio, FechaFin });

    if (filtro == 'asistentes') empleados = empleados.filter(x => x.Ingreso != null && x.Ingreso.toISOString() != x.Salida.toISOString());
    if (filtro == 'ausentes') empleados = empleados.filter(x => x.Ingreso == null);
    if (filtro == 'incompleto') empleados = empleados.filter(x => x.Ingreso != null && x.Ingreso.toISOString() == x.Salida.toISOString());
    if (filtro == 'rectificados') empleados = empleados.filter(x => x.TipoIngreso != null && (x.TipoIngreso != 1 || x.TipoSalida != 1));

    if (!isNaN(area) && area < 100) empleados = empleados.filter(x => x.DepartamentoId == area);
    if (!isNaN(area) && area > 100) empleados = empleados.filter(x => x.DireccionId == (area - 100));

    empleados = empleados.filter(x => x.Nombres.indexOf(colaborador.toUpperCase()) != -1 || x.Apellidos.indexOf(colaborador.toUpperCase()) != -1);

    var vacaciones = await SQL.Execute('Vacaciones_Leer_RangoDeVacaciones', { FechaInicio, FechaFin });
    vacaciones = vacaciones.reduce((acumulador, elemento) => {
        const fechaStr = elemento.Fecha.toISOString().split('T')[0];
        if (!acumulador[fechaStr]) acumulador[fechaStr] = [];
        acumulador[fechaStr].push(elemento.EmpleadoId);
        return acumulador;
    }, {});

    var licencias = await SQL.Execute('Licencias_Leer_RangoDeLicencia', { FechaInicio, FechaFin });
    licencias = licencias.reduce((acumulador, elemento) => {
        const fechaStr = elemento.Fecha.toISOString().split('T')[0];
        if (!acumulador[fechaStr]) acumulador[fechaStr] = [];
        acumulador[fechaStr].push(elemento.EmpleadoId);
        return acumulador;
    }, {});

    var feriados = require('../modules/feriados.json');

    var departamentos = await SQL.Execute('Departamentos_Leer');
    var direcciones = await SQL.Execute('Direccion_Leer');

    var registros = [];
    for (var empleado of empleados) {
        var row = {}
        row.id = empleado.EmpleadoId;
        row.area = (direcciones.find(x => x.DireccionId == empleado.DireccionId) || { NombreDireccion: '' }).NombreDireccion + (departamentos.find(x => x.DepartamentoId == empleado.DepartamentoId) || { NombreDepartamento: '' }).NombreDepartamento;
        row.colaborador = empleado.Apellidos + ' ' + empleado.Nombres;
        row.dia = ['D', 'L', 'M', 'X', 'J', 'V', 'S'][empleado.Fecha.getDay()];
        row.fecha = empleado.Fecha.toISOString().substring(0, 10);

        row.ingreso = {};
        if (empleado.Ingreso) {
            row.ingreso.id = empleado.IngresoId;
            row.ingreso.tipo = empleado.TipoIngreso;
            row.ingreso.hora = empleado.Ingreso.toISOString().substring(11, 16);
            row.ingreso.comentario = empleado.ComentarioIngreso;
        }
        row.salida = {};
        if (empleado.Salida && empleado.IngresoId != empleado.SalidaId) {
            row.salida.id = empleado.SalidaId;
            row.salida.tipo = empleado.TipoSalida;
            row.salida.hora = empleado.Salida.toISOString().substring(11, 16);
            row.salida.comentario = empleado.ComentarioSalida;
        }

        row.justificacion = null;
        if (feriados[row.fecha])
            row.justificacion = "FERIADO";
        else if ((vacaciones[row.fecha] || []).includes(empleado.EmpleadoId))
            row.justificacion = "VACACIONES";
        else if ((licencias[row.fecha] || []).includes(empleado.EmpleadoId))
            row.justificacion = "LICENCIA";
        else if (row.ingreso.tipo != 1)
            row.justificacion = empleado.ComentarioIngreso;

        registros.push(row);
    }

    return registros;
}
router.get('/pruebas', async function (req, res) {
    var filtro = req.query.filtro || 'todos';
    var area = req.query.area || 'todos';
    var colaborador = req.query.colaborador || '';

    var departamentos = await SQL.Execute('Departamentos_Leer');
    var direcciones = await SQL.Execute('Direccion_Leer');

    return res.render('admin-pruebas', { logged: req.logged, registros, departamentos, direcciones, filtro, area, colaborador, FechaInicio, FechaFin })
});