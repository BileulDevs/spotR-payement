const express = require('express');
const payController = require('../controllers/pay.controller');
const router = express.Router();

router.post('/checkout', payController.createCheckoutSession);
router.post('/webhook', express.raw({ type: 'application/json' }), payController.handleWebhook);

module.exports = router;