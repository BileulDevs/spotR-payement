const logger = require("../config/logger");
const stripe = require("../config/stripe");
const axios = require('axios');
require("dotenv").config();

const getSubscriptionPrice = async (userId, premiumId) => {
  const user = (await axios.get(`${process.env.SERVICE_BDD_URL}/api/users/${userId}`)).data;
  const product = (await axios.get(`${process.env.SERVICE_BDD_URL}/api/premium/${premiumId}`)).data;

  let finalPrice = 0;

  if (user.subscription == null) {
    finalPrice = product.tarif;
  } else {
    const currentSubscription = user.subscription;
    const isSubscriptionActive = currentSubscription.endDate && new Date(currentSubscription.endDate) > new Date();

    if (isSubscriptionActive) {
      const currentPlan = currentSubscription.planId;
      if (currentPlan === premiumId) {
        finalPrice = product.tarif;
      } else {
        const currentPlanPrice = currentSubscription.price || 0;
        const priceDifference = product.tarif - currentPlanPrice;
        finalPrice = priceDifference > 0 ? priceDifference : product.tarif;
      }
    } else {
      finalPrice = product.tarif;
    }
  }

  return finalPrice;
}

exports.createCheckoutSession = async (req, res) => {
  const { amount, currency, productName, userId, premiumId, duration, userEmail } = req.body;

  logger.info(`Création de session de paiement : ${productName}, ${amount} ${currency}`);

  if (!userId || !premiumId) {
    logger.warn("Paramètres manquants pour la création de session");
    return res.status(400).json({ success: false, error: 'userId et premiumId sont requis' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'paypal'],
      line_items: [{
        price_data: {
          currency: currency || 'eur',
          product_data: { name: productName || 'Abonnement Premium' },
          unit_amount: amount,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: 'http://localhost:3009/payement/success',
      cancel_url: 'http://localhost:3009/payement/error',
      metadata: { userId, premiumId, duration: duration || '30', userEmail }
    });

    logger.info(`Session Stripe ${session.id} créée pour utilisateur ${userId}`);
    res.json({ success: true, url: session.url, sessionId: session.id });
  } catch (error) {
    logger.error(`Erreur création session Stripe : ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.handleWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    logger.info(`Webhook Stripe reçu : ${event.type}`);
  } catch (err) {
    logger.error(`Webhook invalide : ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        logger.info(`Paiement complété. Session ID : ${session.id}`);

        const { userId, premiumId, duration, userEmail } = session.metadata;
        if (!userId || !premiumId) {
          logger.error('Métadonnées manquantes dans la session Stripe');
          break;
        }

        const premiumResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/premium/${premiumId}`);
        if (!premiumResponse.data) {
          logger.error(`Premium non trouvé : ${premiumId}`);
          break;
        }

        const premium = premiumResponse.data;
        const startDate = new Date();
        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + parseInt(duration || 30));

        const subscriptionData = {
          userId,
          premium: premium.id,
          premiumId,
          status: 'active',
          startDate,
          endDate,
          autoRenew: true,
          paymentMethod: 'credit_card',
          transactionId: session.payment_intent || session.id,
          amount: session.amount_total,
          duration: parseInt(duration || 30)
        };

        const userResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/users/${userId}`);
        const user = userResponse.data;
        let subscriptionResponse;

        if (user.subscription != null) {
          subscriptionResponse = await axios.put(`${process.env.SERVICE_BDD_URL}/api/subscription/${user.subscription.id}`, subscriptionData);
        } else {
          subscriptionResponse = await axios.post(`${process.env.SERVICE_BDD_URL}/api/subscription`, subscriptionData);
        }

        if (session.payment_intent && subscriptionResponse.data?.id) {
          try {
            await stripe.paymentIntents.update(session.payment_intent, {
              metadata: { ...session.metadata, subscriptionId: subscriptionResponse.data.id.toString(), subscriptionStatus: 'active' }
            });
            logger.info(`Métadonnées Payment Intent ${session.payment_intent} mises à jour avec subscription ID : ${subscriptionResponse.data.id}`);
          } catch (metadataError) {
            logger.warn(`Erreur mise à jour métadonnées : ${metadataError.message}`);
          }
        }

        logger.info(`Subscription créée pour l'utilisateur ${userId}`);
        break;

      case 'charge.updated':
        const charge = event.data.object;
        if (charge.status === 'succeeded' && charge.receipt_url) {
          logger.info(`Receipt URL généré pour charge ${charge.id}`);
          try {
            const paymentIntent = await stripe.paymentIntents.retrieve(charge.payment_intent);
            const { userEmail, premiumId, subscriptionId } = paymentIntent.metadata;

            if (userEmail && premiumId && subscriptionId) {
              const premiumResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/premium/${premiumId}`);
              const premium = premiumResponse.data;

              await axios.post(`${process.env.SERVICE_MAILER_URL}/api/mailer/subscription`, {
                to: userEmail,
                receiptUrl: charge.receipt_url,
                username: '',
                plan: premium?.title || 'Premium'
              });

              await axios.put(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscriptionId}`, { factureUrl: charge.receipt_url });
              logger.info(`Email envoyé à ${userEmail} et subscription ${subscriptionId} mise à jour`);
            } else {
              logger.warn(`Métadonnées manquantes dans Payment Intent. userEmail: ${userEmail}, premiumId: ${premiumId}, subscriptionId: ${subscriptionId}`);
            }
          } catch (error) {
            logger.error(`Erreur envoi email : ${error.message}`);
          }
        }
        break;

      case 'invoice.payment_succeeded':
        const invoice = event.data.object;
        logger.info(`Paiement facture réussi. Invoice ID : ${invoice.id}`);
        if (invoice.subscription) await handleSubscriptionRenewal(invoice);
        break;

      case 'invoice.payment_failed':
        const failedInvoice = event.data.object;
        logger.warn(`Échec paiement facture. Invoice ID : ${failedInvoice.id}`);
        await handlePaymentFailure(failedInvoice);
        break;

      case 'customer.subscription.deleted':
        const deletedSubscription = event.data.object;
        logger.info(`Subscription supprimée : ${deletedSubscription.id}`);
        await handleSubscriptionCancellation(deletedSubscription);
        break;

      case 'customer.subscription.updated':
        const updatedSubscription = event.data.object;
        logger.info(`Subscription mise à jour : ${updatedSubscription.id}`);
        await handleSubscriptionUpdate(updatedSubscription);
        break;

      default:
        logger.info(`Événement non géré : ${event.type}`);
    }
  } catch (error) {
    logger.error(`Erreur traitement webhook : ${error.message}`);
    return res.status(500).json({ error: 'Erreur interne serveur' });
  }

  res.json({ received: true });
};

async function handleSubscriptionRenewal(invoice) {
  try {
    const searchResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/subscription/search`, {
      params: { transactionId: invoice.subscription }
    });

    if (searchResponse.data.success && searchResponse.data.data.subscriptions.length > 0) {
      const subscription = searchResponse.data.data.subscriptions[0];
      await axios.patch(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}/renew`, { duration: 30 });
      logger.info(`Subscription renouvelée pour utilisateur ${subscription.userId}`);
    }
  } catch (error) {
    logger.error(`Erreur renouvellement : ${error.message}`);
  }
}

async function handlePaymentFailure(invoice) {
  try {
    const searchResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/subscription/search`, {
      params: { transactionId: invoice.subscription }
    });

    if (searchResponse.data.success && searchResponse.data.data.subscriptions.length > 0) {
      const subscription = searchResponse.data.data.subscriptions[0];
      await axios.patch(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}`, { status: 'inactive', autoRenew: false });
      logger.warn(`Subscription désactivée pour échec de paiement : ${subscription.userId}`);
    }
  } catch (error) {
    logger.error(`Erreur échec paiement : ${error.message}`);
  }
}

async function handleSubscriptionCancellation(stripeSubscription) {
  try {
    const searchResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/subscription/search`, {
      params: { transactionId: stripeSubscription.id }
    });

    if (searchResponse.data.success && searchResponse.data.data.subscriptions.length > 0) {
      const subscription = searchResponse.data.data.subscriptions[0];
      await axios.patch(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}/cancel`);
      logger.info(`Subscription annulée pour utilisateur ${subscription.userId}`);
    }
  } catch (error) {
    logger.error(`Erreur annulation : ${error.message}`);
  }
}

async function handleSubscriptionUpdate(stripeSubscription) {
  try {
    const searchResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/subscription/search`, {
      params: { transactionId: stripeSubscription.id }
    });

    if (searchResponse.data.success && searchResponse.data.data.subscriptions.length > 0) {
      const subscription = searchResponse.data.data.subscriptions[0];
      let newStatus = 'active';
      if (stripeSubscription.status === 'canceled') newStatus = 'cancelled';
      else if (stripeSubscription.status === 'past_due') newStatus = 'inactive';

      await axios.patch(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}`, { status: newStatus });
      logger.info(`Subscription mise à jour pour utilisateur ${subscription.userId} - Statut: ${newStatus}`);
    }
  } catch (error) {
    logger.error(`Erreur mise à jour subscription : ${error.message}`);
  }
}
