const { createCheckoutSession } = require('../path/to/controller');
const stripe = require('../config/stripe');
const logger = require('../config/logger');

jest.mock('../config/stripe');
jest.mock('../config/logger');

describe('createCheckoutSession', () => {
  let req;
  let res;

  beforeEach(() => {
    req = {
      body: {
        amount: 5000,
        currency: 'eur',
        productName: 'Test Product',
        userId: 'user123',
        premiumId: 'premium123',
        duration: '30',
        userEmail: 'test@example.com',
      },
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    stripe.checkout.sessions.create.mockReset();
    logger.info.mockReset();
    logger.error.mockReset();
  });

  it('should return 400 if userId or premiumId missing', async () => {
    req.body.userId = null;

    await createCheckoutSession(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'userId et premiumId sont requis pour créer une session de paiement',
    });
  });

  it('should create a Stripe session and return session info', async () => {
    const mockSession = { id: 'sess_123', url: 'https://checkout.stripe.com/pay/sess_123' };
    stripe.checkout.sessions.create.mockResolvedValue(mockSession);

    await createCheckoutSession(req, res);

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith({
      payment_method_types: ['card', 'paypal'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: 'Test Product' },
          unit_amount: 5000,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: 'http://localhost:3009/payement/success',
      cancel_url: 'http://localhost:3009/payement/error',
      metadata: {
        userId: 'user123',
        premiumId: 'premium123',
        duration: '30',
        userEmail: 'test@example.com',
      },
    });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Demande de création de session'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Session Stripe créée'));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      url: mockSession.url,
      sessionId: mockSession.id,
    });
  });

  it('should handle errors thrown by Stripe API', async () => {
    const error = new Error('Stripe error');
    stripe.checkout.sessions.create.mockRejectedValue(error);

    await createCheckoutSession(req, res);

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Erreur création session Stripe'));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Stripe error',
    });
  });
});
