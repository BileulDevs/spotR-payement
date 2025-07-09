const logger = require("../config/logger");
const stripe = require("../config/stripe");
require("dotenv").config();

// Créer une session de paiement
exports.createCheckoutSession = async (req, res) => {
  const { amount, currency, productName } = req.body;

  logger.info(`💰 Demande de création de session : ${productName}, ${amount} ${currency}`);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'paypal'],
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
      success_url: 'http://localhost:3009/payement/success',
      cancel_url: 'http://localhost:3009/payement/error',
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
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    logger.info(`📩 Webhook Stripe reçu : ${event.type}`);
  } catch (err) {
    logger.error(`❌ Webhook invalide : ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Gestion des événements
  console.log(event)

  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      logger.info(`✅ Paiement complété. Session ID : ${session.id}`);
      // TODO : traitement métier ici


      // SUB USER && AJOUTE A SON PAYMENT HISTORY ET INCREMENTER SUBCOUNT DU PLAN

      break;
  }

  res.json({ received: true });
};
