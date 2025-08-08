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
            
            if (priceDifference > 0) {
                finalPrice = priceDifference;
            } else {
                finalPrice = product.tarif;
            }
        }
    } else {
        finalPrice = product.tarif;
    }
  }

  return finalPrice;
}

// Créer une session de paiement
exports.createCheckoutSession = async (req, res) => {
  const { amount, currency, productName, userId, premiumId, duration, userEmail } = req.body;

  logger.info(`💰 Demande de création de session : ${productName}, ${amount} ${currency}`);

  // Validation des paramètres requis
  if (!userId || !premiumId) {
    return res.status(400).json({
      success: false,
      error: 'userId et premiumId sont requis pour créer une session de paiement'
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'paypal'],
      line_items: [{
        price_data: {
          currency: currency || 'eur',
          product_data: {
            name: productName || 'Abonnement Premium',
          },
          unit_amount: await getSubscriptionPrice(userId, premiumId),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: 'http://localhost:3009/payement/success',
      cancel_url: 'http://localhost:3009/payement/error',
      metadata: {
        userId: userId,
        premiumId: premiumId,
        duration: duration || '30',
        userEmail: userEmail
      }
    });

    logger.info(`✅ Session Stripe créée : ${session.id} pour utilisateur ${userId}`);
    res.json({ 
      success: true,
      url: session.url,
      sessionId: session.id
    });
  } catch (error) {
    logger.error(`❌ Erreur création session Stripe : ${error.message}`);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
};

// Gérer les webhooks Stripe
exports.handleWebhook = async (req, res) => {
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
  try {
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      logger.info(`✅ Paiement complété. Session ID : ${session.id}`);
      
      // Récupérer les métadonnées de la session
      const { userId, premiumId, duration, userEmail } = session.metadata;
      
      if (!userId || !premiumId) {
        logger.error('❌ Métadonnées manquantes dans la session Stripe');
        break;
      }

      // Vérifier si le premium existe via le service BDD
      const premiumResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/premium/${premiumId}`);
      if (!premiumResponse.data) {
        logger.error(`❌ Premium non trouvé : ${premiumId}`);
        break;
      }

      const premium = premiumResponse.data;

      // Calculer les dates de subscription
      const startDate = new Date();
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + parseInt(duration || 30));

      // Créer la subscription via le service BDD
      const subscriptionData = {
        userId,
        premiumId,
        status: 'active',
        startDate,
        endDate,
        autoRenew: true,
        paymentMethod: 'credit_card',
        transactionId: session.payment_intent || session.id,
        amount: session.amount_total / 100,
        duration: parseInt(duration || 30)
      };

      const subscriptionResponse = await axios.post(`${process.env.SERVICE_BDD_URL}/api/subscription`, subscriptionData);
      
      // ✨ NOUVELLE PARTIE : Mettre à jour les métadonnées du Payment Intent avec l'ID de subscription
      if (session.payment_intent && subscriptionResponse.data?.id) {
        try {
          await stripe.paymentIntents.update(session.payment_intent, {
            metadata: {
              ...session.metadata, // Conserver les métadonnées existantes
              subscriptionId: subscriptionResponse.data.id.toString(),
              subscriptionStatus: 'active'
            }
          });
          
          logger.info(`✅ Métadonnées du Payment Intent ${session.payment_intent} mises à jour avec subscription ID : ${subscriptionResponse.data.id}`);
        } catch (metadataError) {
          logger.error(`❌ Erreur lors de la mise à jour des métadonnées : ${metadataError.message}`);
        }
      }
      
      logger.info(`✅ Subscription créée avec succès pour l'utilisateur ${userId}`);
      
      break;

    case 'charge.updated':
      const charge = event.data.object;
      
      // Vérifier si le charge est complété et qu'il y a un receipt_url
      if (charge.status === 'succeeded' && charge.receipt_url) {
        logger.info(`📧 Receipt URL généré pour le charge : ${charge.id}`);
        
        try {
          // Récupérer le Payment Intent pour obtenir les métadonnées mises à jour
          const paymentIntent = await stripe.paymentIntents.retrieve(charge.payment_intent);
          const { userEmail, premiumId, subscriptionId } = paymentIntent.metadata;
          
          if (userEmail && premiumId && subscriptionId) {
            // Récupérer les infos du premium
            const premiumResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/premium/${premiumId}`);
            const premium = premiumResponse.data;
            
            // Envoyer l'email de confirmation avec le reçu
            await axios.post(`${process.env.SERVICE_MAILER_URL}/api/mailer/subscription`, {
              to: userEmail,
              receiptUrl: charge.receipt_url,
              username: '',
              plan: premium?.title || 'Premium'
            });

            console.log("subscription ID:", subscriptionId);

            // ✅ CORRECTION : Utiliser la subscription ID des métadonnées
            await axios.put(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscriptionId}`, {
              factureUrl: charge.receipt_url // ✅ Correction du typo "fatcureUrl"
            });
            
            logger.info(`✅ Email d'abonnement envoyé à ${userEmail} avec le reçu. Subscription ${subscriptionId} mise à jour.`);
          } else {
            logger.warn(`⚠️ Métadonnées manquantes dans le Payment Intent. userEmail: ${userEmail}, premiumId: ${premiumId}, subscriptionId: ${subscriptionId}`);
            
            // Fallback : essayer avec l'ancienne méthode si les nouvelles métadonnées ne sont pas disponibles
            const sessions = await stripe.checkout.sessions.list({
              payment_intent: charge.payment_intent,
              limit: 1
            });
            
            if (sessions.data.length > 0) {
              const relatedSession = sessions.data[0];
              const { userEmail: sessionEmail, premiumId: sessionPremiumId } = relatedSession.metadata;
              
              if (sessionEmail && sessionPremiumId) {
                // Récupérer la subscription via userId et status
                const userResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/users/email/${sessionEmail}`);
                if (userResponse.data) {
                  const subscriptions = await axios.get(`${process.env.SERVICE_BDD_URL}/api/subscription/user/${userResponse.data.id}?status=active`);
                  const activeSubscription = subscriptions.data?.[0];
                  
                  if (activeSubscription) {
                    await axios.put(`${process.env.SERVICE_BDD_URL}/api/subscription/${activeSubscription.id}`, {
                      factureUrl: charge.receipt_url
                    });
                    logger.info(`✅ Subscription ${activeSubscription.id} mise à jour via fallback`);
                  }
                }
              }
            }
          }
        } catch (error) {
          logger.error(`❌ Erreur lors de l'envoi de l'email : ${error.message}`);
        }
      }
      
      break;
      case 'invoice.payment_succeeded':
        const invoice = event.data.object;
        logger.info(`✅ Paiement de facture réussi. Invoice ID : ${invoice.id}`);
        
        // Traiter le renouvellement automatique
        if (invoice.subscription) {
          await handleSubscriptionRenewal(invoice);
        }
        
        break;

      case 'invoice.payment_failed':
        const failedInvoice = event.data.object;
        logger.warn(`⚠️ Échec du paiement de facture. Invoice ID : ${failedInvoice.id}`);
        
        // Traiter l'échec de paiement
        await handlePaymentFailure(failedInvoice);
        
        break;

      case 'customer.subscription.deleted':
        const deletedSubscription = event.data.object;
        logger.info(`🗑️ Subscription Stripe supprimée : ${deletedSubscription.id}`);
        
        // Marquer la subscription comme annulée
        await handleSubscriptionCancellation(deletedSubscription);
        
        break;

      case 'customer.subscription.updated':
        const updatedSubscription = event.data.object;
        logger.info(`🔄 Subscription Stripe mise à jour : ${updatedSubscription.id}`);
        
        // Mettre à jour le statut de la subscription
        await handleSubscriptionUpdate(updatedSubscription);
        
        break;

      default:
        logger.info(`🔍 Événement non traité : ${event.type}`);
    
    }
  } catch (error) {
    logger.error(`❌ Erreur lors du traitement du webhook : ${error.message}`);
    return res.status(500).json({ error: 'Erreur interne du serveur' });
  }

  res.json({ received: true });
};

// Fonction pour gérer le renouvellement automatique
async function handleSubscriptionRenewal(invoice) {
  try {
    // Rechercher la subscription par transaction ID via le service BDD
    const searchResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/subscription/search`, {
      params: { transactionId: invoice.subscription }
    });

    if (searchResponse.data.success && searchResponse.data.data.subscriptions.length > 0) {
      const subscription = searchResponse.data.data.subscriptions[0];
      
      // Renouveler la subscription via le service BDD
      await axios.patch(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}/renew`, {
        duration: 30
      });

      logger.info(`✅ Subscription renouvelée pour l'utilisateur ${subscription.userId}`);
    }
  } catch (error) {
    logger.error(`❌ Erreur lors du renouvellement : ${error.message}`);
  }
}

// Fonction pour gérer l'échec de paiement
async function handlePaymentFailure(invoice) {
  try {
    const searchResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/subscription/search`, {
      params: { transactionId: invoice.subscription }
    });

    if (searchResponse.data.success && searchResponse.data.data.subscriptions.length > 0) {
      const subscription = searchResponse.data.data.subscriptions[0];
      
      // Marquer comme inactive via le service BDD
      await axios.patch(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}`, {
        status: 'inactive',
        autoRenew: false
      });

      logger.warn(`⚠️ Subscription désactivée pour échec de paiement : ${subscription.userId}`);
      
      // TODO: Envoyer un email d'alerte à l'utilisateur
    }
  } catch (error) {
    logger.error(`❌ Erreur lors du traitement de l'échec : ${error.message}`);
  }
}

// Fonction pour gérer l'annulation de subscription
async function handleSubscriptionCancellation(stripeSubscription) {
  try {
    const searchResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/subscription/search`, {
      params: { transactionId: stripeSubscription.id }
    });

    if (searchResponse.data.success && searchResponse.data.data.subscriptions.length > 0) {
      const subscription = searchResponse.data.data.subscriptions[0];
      
      // Annuler la subscription via le service BDD
      await axios.patch(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}/cancel`);

      logger.info(`✅ Subscription annulée pour l'utilisateur ${subscription.userId}`);
    }
  } catch (error) {
    logger.error(`❌ Erreur lors de l'annulation : ${error.message}`);
  }
}

// Fonction pour gérer la mise à jour de subscription
async function handleSubscriptionUpdate(stripeSubscription) {
  try {
    const searchResponse = await axios.get(`${process.env.SERVICE_BDD_URL}/api/subscription/search`, {
      params: { transactionId: stripeSubscription.id }
    });

    if (searchResponse.data.success && searchResponse.data.data.subscriptions.length > 0) {
      const subscription = searchResponse.data.data.subscriptions[0];
      
      // Déterminer le nouveau statut basé sur le statut Stripe
      let newStatus = 'active';
      if (stripeSubscription.status === 'canceled') {
        newStatus = 'cancelled';
      } else if (stripeSubscription.status === 'past_due') {
        newStatus = 'inactive';
      }
      
      // Mettre à jour via le service BDD
      await axios.patch(`${process.env.SERVICE_BDD_URL}/api/subscription/${subscription.id}`, {
        status: newStatus
      });

      logger.info(`✅ Subscription mise à jour pour l'utilisateur ${subscription.userId} - Statut: ${newStatus}`);
    }
  } catch (error) {
    logger.error(`❌ Erreur lors de la mise à jour : ${error.message}`);
  }
}

// Fonction utilitaire pour gérer les erreurs d'API
function handleApiError(error, operation) {
  if (error.response) {
    logger.error(`❌ Erreur API ${operation}: ${error.response.status} - ${error.response.data.message || error.response.data}`);
  } else if (error.request) {
    logger.error(`❌ Erreur réseau ${operation}: Service BDD non disponible`);
  } else {
    logger.error(`❌ Erreur ${operation}: ${error.message}`);
  }
}