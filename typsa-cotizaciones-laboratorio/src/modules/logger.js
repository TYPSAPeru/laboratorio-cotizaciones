const fs = require('fs');
const path = require('path');
const folder = path.join(__dirname, '..', '..', 'logs');

console.logger = console.log;
console.log = function () {
	if (!fs.existsSync(folder))
		fs.mkdirSync(folder)

	var datetime = new Date();
	datetime.setHours(datetime.getHours() - 5);
	var month = datetime.toISOString().substring(0, 7);
	var date = datetime.toISOString().substring(0, 10);
	var time = datetime.toISOString().substring(11, 19);

	var file = path.join(folder, month + ".log");

	var data = date + ' ' + time + " | ";
	for (var arg of arguments) {
		if (typeof arg !== 'string')
			arg = JSON.stringify(arg);
		data += arg + " ";
	}
	data = data.substring(0, data.length - 1) + "\n";

	fs.appendFileSync(file, data);
	console.logger(date, time, "|", ...arguments);
}