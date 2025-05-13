const logger = require("../config/logger");
const stripe = require("../config/stripe");
require("dotenv").config();

// Créer une session de paiement
exports.createCheckoutSession = async (req, res) => {
  const { amount, currency, productName } = req.body;

  logger.info(`💰 Demande de création de session : ${productName}, ${amount} ${currency}`);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: currency || 'eur',
          product_data: {
            name: productName || 'Produit',
          },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: 'https://example.com/success',
      cancel_url: 'https://example.com/cancel',
    });

    logger.info(`✅ Session Stripe créée : ${session.id}`);
    res.json({ url: session.url });
  } catch (error) {
    logger.error(`❌ Erreur création session Stripe : ${error.message}`);
    res.status(500).json({ error: error.message });
  }
};

// Gérer les webhooks Stripe
exports.handleWebhook = (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    logger.info(`📩 Webhook Stripe reçu : ${event.type}`);
  } catch (err) {
    logger.error(`❌ Webhook invalide : ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Gestion des événements
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      logger.info(`✅ Paiement complété. Session ID : ${session.id}`);
      // TODO : traitement métier ici
      break;

    default:
      logger.warn(`⚠️ Événement non géré : ${event.type}`);
  }

  res.json({ received: true });
};
