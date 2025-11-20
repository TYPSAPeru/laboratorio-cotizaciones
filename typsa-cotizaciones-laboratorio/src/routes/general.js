const express = require('express');
const router = express.Router();

router.get('/', async function (req, res) {
	return res.render('inicio', { logged: req.logged })
});

module.exports = router;