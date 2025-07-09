const express = require('express');
const payController = require('../controllers/pay.controller');
const router = express.Router();

router.post('/checkout', payController.createCheckoutSession);

module.exports = router;