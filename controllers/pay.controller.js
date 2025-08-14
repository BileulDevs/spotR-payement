const logger = require('../config/logger');
const stripe = require('../config/stripe');
const axios = require('axios');
require('dotenv').config();

/**
 * Calcule le prix final d'un abonnement en tenant compte des abonnements existants
 * @param {string} userId - ID de l'utilisateur
 * @param {string} premiumId - ID du plan premium souhaité
 * @returns {Promise<number>} Prix final à facturer
 */
const getSubscriptionPrice = async (userId, premiumId) => {
  // Récupération des données utilisateur depuis la base de données
  const user = (
    await axios.get(`${process.env.SERVICE_BDD_URL}/api/users/${userId}`)
  ).data;
  // Récupération des données du produit premium
  const product = (
    await axios.get(`${process.env.SERVICE_BDD_URL}/api/premium/${premiumId}`)
  ).data;

  let finalPrice = 0;

  // Si l'utilisateur n'a pas d'abonnement, prix plein
  if (user.subscription == null) {
    finalPrice = product.tarif;
  } else {
    const currentSubscription = user.subscription;
    // Vérification si l'abonnement actuel est encore actif
    const isSubscriptionActive =
      currentSubscription.endDate &&
      new Date(currentSubscription.endDate) > new Date();

    if (isSubscriptionActive) {
      const currentPlan = currentSubscription.planId;
      // Si même plan, prix plein (renouvellement)
      if (currentPlan === premiumId) {
        finalPrice = product.tarif;
      } else {
        // Calcul de la différence de prix pour un upgrade/downgrade
        const currentPlanPrice = currentSubscription.price || 0;
        const priceDifference = product.tarif - currentPlanPrice;
        finalPrice = priceDifference > 0 ? priceDifference : product.tarif;
      }
    } else {
      // Abonnement expiré, prix plein
      finalPrice = product.tarif;
    }
  }

  return finalPrice;
};

/**
 * Crée une session de paiement Stripe Checkout
 * @param {Object} req - Requête Express contenant les données de paiement
 * @param {Object} res - Réponse Express
 */
exports.createCheckoutSession = async (req, res) => {
  const {
    amount,
    currency,
    productName,
    userId,
    premiumId,
    duration,
    userEmail,
  } = req.body;

  logger.info(
    `Création de session de paiement : ${productName}, ${amount} ${currency}`
  );

  // Validation des paramètres obligatoires
  if (!userId || !premiumId) {
    logger.warn('Paramètres manquants pour la création de session');
    return res
      .status(400)
      .json({ success: false, error: 'userId et premiumId sont requis' });
  }

  try {
    // Création de la session Stripe avec support carte et PayPal
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'paypal'],
      line_items: [
        {
          price_data: {
            currency: currency || 'eur',
            product_data: { name: productName || 'Abonnement Premium' },
            unit_amount: amount, // Montant en centimes
          },
          quantity: 1,
        },
      ],
      mode: 'payment', // Paiement unique (non récurrent)
      success_url: 'http://localhost:3009/payement/success',
      cancel_url: 'http://localhost:3009/payement/error',
      // Métadonnées pour le traitement du webhook
      metadata: { userId, premiumId, duration: duration || '30', userEmail },
    });

    logger.info(
      `Session Stripe ${session.id} créée pour utilisateur ${userId}`
    );
    res.json({ success: true, url: session.url, sessionId: session.id });
  } catch (error) {
    logger.error(`Erreur création session Stripe : ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Gère les webhooks Stripe pour traiter les événements de paiement
 * @param {Object} req - Requête Express contenant le webhook Stripe
 * @param {Object} res - Réponse Express
 */
exports.handleWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Vérification de la signature du webhook pour sécurité
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
    logger.info(`Webhook Stripe reçu : ${event.type}`);
  } catch (err) {
    logger.error(`Webhook invalide : ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      // Paiement unique complété avec succès
      case 'checkout.session.completed':
        const session = event.data.object;
        logger.info(`Paiement complété. Session ID : ${session.id}`);

        const { userId, premiumId, duration, userEmail } = session.metadata;
        if (!userId || !premiumId) {
          logger.error('Métadonnées manquantes dans la session Stripe');
          break;
        }

        // Récupération des détails du plan premium
        const premiumResponse = await axios.get(
          `${process.env.SERVICE_BDD_URL}/api/premium/${premiumId}`
        );
        if (!premiumResponse.data) {
          logger.error(`Premium non trouvé : ${premiumId}`);
          break;
        }

        const premium = premiumResponse.data;
        const startDate = new Date();
        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + parseInt(duration || 30));

        // Préparation des données d'abonnement
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
          duration: parseInt(duration || 30),
        };

        // Vérification si l'utilisateur a déjà un abonnement
        const userResponse = await axios.get(
          `${process.env.SERVICE_BDD_URL}/api/users/${userId}`
        );
        const user = userResponse.data;
        let subscriptionResponse;

        // Mise à jour ou création d'abonnement selon le cas
        if (user.subscription != null) {
          subscriptionResponse = await axios.put(
            `${process.env.SERVICE_BDD_URL}/api/subscription/${user.subscription.id}`,
            subscriptionData
          );
        } else {
          subscriptionResponse = await axios.post(
            `${process.env.SERVICE_BDD_URL}/api/subscription`,
            subscriptionData
          );
        }

        // Mise à jour des métadonnées du Payment Intent avec l'ID d'abonnement
        if (session.payment_intent && subscriptionResponse.data?.id) {
          try {
            await stripe.paymentIntents.update(session.payment_intent, {
              metadata: {
                ...session.metadata,
                subscriptionId: subscriptionResponse.data.id.toString(),
                subscriptionStatus: 'active',
              },
            });
            logger.info(
              `Métadonnées Payment Intent ${session.payment_intent} mises à jour avec subscription ID : ${subscriptionResponse.data.id}`
            );
          } catch (metadataError) {
            logger.warn(
              `Erreur mise à jour métadonnées : ${metadataError.message}`
            );
          }
        }

        logger.info(`Subscription créée pour l'utilisateur ${userId}`);
        break;

      // Charge mise à jour (pour génération du reçu)
      case 'charge.updated':
        const charge = event.data.object;
        if (charge.status === 'succeeded' && charge.receipt_url) {
          logger.info(`Receipt URL généré pour charge ${charge.id}`);
          try {
            // Récupération des métadonnées du Payment Intent
            const paymentIntent = await stripe.paymentIntents.retrieve(
              charge.payment_intent
            );
            const { userEmail, premiumId, subscriptionId } =
              paymentIntent.metadata;

            if (userEmail && premiumId && subscriptionId) {
              const premiumResponse = await axios.get(
                `${process.env.SERVICE_BDD_URL}/api/premium/${premiumId}`
              );
              const premium = premiumResponse.data;

              // Envoi de l'email de confirmation avec reçu
              await axios.post(
                `${process.env.SERVICE_MAILER_URL}/api/mailer/subscription`,
                {
                  to: userEmail,
                  receiptUrl: charge.receipt_url,
                  username: '',
                  plan: premium?.title || 'Premium',
                }
              );

              // Sauvegarde de l'URL du reçu dans l'abonnement
              await axios.put(
                `${process.env.SERVICE_BDD_URL}/api/subscription/${subscriptionId}`,
                { factureUrl: charge.receipt_url }
              );
              logger.info(
                `Email envoyé à ${userEmail} et subscription ${subscriptionId} mise à jour`
              );
            } else {
              logger.warn(
                `Métadonnées manquantes dans Payment Intent. userEmail: ${userEmail}, premiumId: ${premiumId}, subscriptionId: ${subscriptionId}`
              );
            }
          } catch (error) {
            logger.error(`Erreur envoi email : ${error.message}`);
          }
        }
        break;

      // Paiement de facture réussi (pour abonnements récurrents)
      case 'invoice.payment_succeeded':
        const invoice = event.data.object;
        logger.info(`Paiement facture réussi. Invoice ID : ${invoice.id}`);
        if (invoice.subscription) await handleSubscriptionRenewal(invoice);
        break;

      // Échec de paiement de facture
      case 'invoice.payment_failed':
        const failedInvoice = event.data.object;
        logger.warn(`Échec paiement facture. Invoice ID : ${failedInvoice.id}`);
        await handlePaymentFailure(failedInvoice);
        break;

      // Abonnement supprimé côté Stripe
      case 'customer.subscription.deleted':
        const deletedSubscription = event.data.object;
        logger.info(`Subscription supprimée : ${deletedSubscription.id}`);
        await handleSubscriptionCancellation(deletedSubscription);
        break;

      // Abonnement mis à jour côté Stripe
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

/**
 * Gère le renouvellement automatique d'un abonnement
 * @param {Object} invoice - Objet facture Stripe
 */
async function handleSubscriptionRenewal(invoice) {
  try {
    // Recherche de l'abonnement par transaction ID
    const searchResponse = await axios.get(
      `${process.env.SERVICE_BDD_URL}/api/subscription/search`,
      {
        params: { transactionId: invoice.subscription },
      }
    );

    if (
      searchResponse.data.success &&
      searchResponse.data.data.subscriptions.length > 0
    ) {
      const subscription = searchResponse.data.data.subscriptions[0];
      // Renouvellement de l'abonnement pour 30 jours
      await axios.patch(
        `${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}/renew`,
        { duration: 30 }
      );
      logger.info(
        `Subscription renouvelée pour utilisateur ${subscription.userId}`
      );
    }
  } catch (error) {
    logger.error(`Erreur renouvellement : ${error.message}`);
  }
}

/**
 * Gère l'échec de paiement d'un abonnement
 * @param {Object} invoice - Objet facture Stripe ayant échoué
 */
async function handlePaymentFailure(invoice) {
  try {
    const searchResponse = await axios.get(
      `${process.env.SERVICE_BDD_URL}/api/subscription/search`,
      {
        params: { transactionId: invoice.subscription },
      }
    );

    if (
      searchResponse.data.success &&
      searchResponse.data.data.subscriptions.length > 0
    ) {
      const subscription = searchResponse.data.data.subscriptions[0];
      // Désactivation de l'abonnement et arrêt du renouvellement auto
      await axios.patch(
        `${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}`,
        { status: 'inactive', autoRenew: false }
      );
      logger.warn(
        `Subscription désactivée pour échec de paiement : ${subscription.userId}`
      );
    }
  } catch (error) {
    logger.error(`Erreur échec paiement : ${error.message}`);
  }
}

/**
 * Gère l'annulation d'un abonnement côté Stripe
 * @param {Object} stripeSubscription - Objet abonnement Stripe supprimé
 */
async function handleSubscriptionCancellation(stripeSubscription) {
  try {
    const searchResponse = await axios.get(
      `${process.env.SERVICE_BDD_URL}/api/subscription/search`,
      {
        params: { transactionId: stripeSubscription.id },
      }
    );

    if (
      searchResponse.data.success &&
      searchResponse.data.data.subscriptions.length > 0
    ) {
      const subscription = searchResponse.data.data.subscriptions[0];
      // Annulation de l'abonnement en base de données
      await axios.patch(
        `${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}/cancel`
      );
      logger.info(
        `Subscription annulée pour utilisateur ${subscription.userId}`
      );
    }
  } catch (error) {
    logger.error(`Erreur annulation : ${error.message}`);
  }
}

/**
 * Gère la mise à jour d'un abonnement côté Stripe
 * @param {Object} stripeSubscription - Objet abonnement Stripe mis à jour
 */
async function handleSubscriptionUpdate(stripeSubscription) {
  try {
    const searchResponse = await axios.get(
      `${process.env.SERVICE_BDD_URL}/api/subscription/search`,
      {
        params: { transactionId: stripeSubscription.id },
      }
    );

    if (
      searchResponse.data.success &&
      searchResponse.data.data.subscriptions.length > 0
    ) {
      const subscription = searchResponse.data.data.subscriptions[0];
      // Mapping des statuts Stripe vers nos statuts internes
      let newStatus = 'active';
      if (stripeSubscription.status === 'canceled') newStatus = 'cancelled';
      else if (stripeSubscription.status === 'past_due') newStatus = 'inactive';

      // Mise à jour du statut de l'abonnement
      await axios.patch(
        `${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}`,
        { status: newStatus }
      );
      logger.info(
        `Subscription mise à jour pour utilisateur ${subscription.userId} - Statut: ${newStatus}`
      );
    }
  } catch (error) {
    logger.error(`Erreur mise à jour subscription : ${error.message}`);
  }
}