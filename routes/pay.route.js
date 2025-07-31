const express = require('express');
const payController = require('../controllers/pay.controller');
const router = express.Router();

/**
 * @swagger
 * tags:
 *   - name: Payment
 *     description: Gestion des paiements (Stripe, etc.)
 */

/**
 * @swagger
 * /api/pay/checkout:
 *   post:
 *     tags:
 *       - Payment
 *     summary: Créer une session de paiement
 *     description: Démarre une session de paiement via Stripe ou un autre prestataire.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userId:
 *                 type: string
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     priceId:
 *                       type: string
 *                     quantity:
 *                       type: integer
 *             required:
 *               - userId
 *               - items
 *     responses:
 *       200:
 *         description: Session de paiement créée avec succès
 *       400:
 *         description: Données de paiement invalides
 */
router.post('/checkout', payController.createCheckoutSession);

module.exports = router;
