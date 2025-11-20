const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID);

async function EnviarCorreo(to, subject, html, cc = []) {
	try {
		if (process.env.NODE_ENV !== 'production') {
			console.log("DEV", "Correo de desarrollo asignado");
			console.log("DEV", to);

			to = process.env.CORREO_DEV;
			cc = bcc = [];
		}

		var result = await sgMail.send({ to, from: 'TYPSA Perú <no-reply@typsa.pe>', subject, html, cc });
		return result[0].statusCode === 202;
	} catch (error) {
		console.error(error);
		return false;
	}
}

const ejs = require('ejs');
const path = require('path');

async function PlantillaCorreo(nombre, data) {
    const file = path.join(__dirname, '..', 'views', 'correos', nombre + '.ejs');
    return new Promise((resolve, reject) => {
        ejs.renderFile(file, data, function (error, html) {
            if (error) return resolve({ error: true });
            return resolve(html);
        });
    });
}

module.exports = { EnviarCorreo, PlantillaCorreo }