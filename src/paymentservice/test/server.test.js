const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const HipsterShopServer = require('../server');
const logger = require('../logger');

const PROTO_ROOT = path.join(__dirname, '..', 'proto');
const LOADER_OPTIONS = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VISA = '4111111111111111';

function loadPackage (file) {
  return grpc.loadPackageDefinition(protoLoader.loadSync(path.join(PROTO_ROOT, file), LOADER_OPTIONS));
}

function call (client, method, req) {
  return new Promise((resolve, reject) => {
    client[method](req, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

const nextYear = new Date().getFullYear() + 1;

function chargeRequest (cardOverrides = {}) {
  return {
    amount: { currency_code: 'USD', units: 42, nanos: 0 },
    credit_card: {
      credit_card_number: VISA,
      credit_card_cvv: 987,
      credit_card_expiration_year: nextYear,
      credit_card_expiration_month: 6,
      ...cardOverrides
    }
  };
}

describe('PaymentService gRPC server', () => {
  let server;
  let paymentClient;
  let healthClient;

  let port;

  before(async () => {
    mock.method(console, 'warn', () => {});
    server = new HipsterShopServer(PROTO_ROOT, 0);
    port = await new Promise((resolve, reject) => {
      server.listen((err, boundPort) => (err ? reject(err) : resolve(boundPort)));
    });
    assert.ok(port > 0);
    const address = `localhost:${port}`;
    const credentials = grpc.credentials.createInsecure();
    paymentClient = new (loadPackage('demo.proto').hipstershop.PaymentService)(address, credentials);
    healthClient = new (loadPackage('grpc/health/v1/health.proto').grpc.health.v1.Health)(address, credentials);
  });

  after(async () => {
    paymentClient.close();
    healthClient.close();
    await new Promise((resolve) => server.close(resolve));
    mock.restoreAll();
  });

  it('reports a bind error through the listen callback', async () => {
    const error = mock.method(logger, 'error', () => {});
    const other = new HipsterShopServer(PROTO_ROOT, port);
    try {
      const err = await new Promise((resolve) => other.listen(resolve));
      assert.ok(err instanceof Error);
      assert.equal(error.mock.callCount(), 1);
    } finally {
      error.mock.restore();
      other.server.forceShutdown();
    }
  });

  it('reports SERVING on the health check', async () => {
    const res = await call(healthClient, 'check', { service: '' });
    assert.equal(res.status, 'SERVING');
  });

  it('charges a valid card', async () => {
    const res = await call(paymentClient, 'charge', chargeRequest());
    assert.match(res.transaction_id, UUID_RE);
  });

  it('returns INVALID_ARGUMENT for an unaccepted card type', async () => {
    await assert.rejects(call(paymentClient, 'charge', chargeRequest({ credit_card_number: '378282246310005' })), (err) => {
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      assert.match(err.details, /cannot process amex/);
      return true;
    });
  });

  it('returns INVALID_ARGUMENT for an expired card', async () => {
    const req = chargeRequest({ credit_card_expiration_year: nextYear - 2 });
    await assert.rejects(call(paymentClient, 'charge', req), (err) => {
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      assert.match(err.details, /expired/);
      return true;
    });
  });

  it('returns INVALID_ARGUMENT for an empty card number', async () => {
    await assert.rejects(call(paymentClient, 'charge', chargeRequest({ credit_card_number: '' })), (err) => {
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      assert.match(err.details, /Credit card info is invalid/);
      return true;
    });
  });

  it('returns INVALID_ARGUMENT when credit card info is omitted', async () => {
    await assert.rejects(call(paymentClient, 'charge', { amount: chargeRequest().amount }), (err) => {
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      assert.match(err.details, /credit_card/);
      return true;
    });
  });

  it('returns INVALID_ARGUMENT when the amount is omitted', async () => {
    await assert.rejects(call(paymentClient, 'charge', { credit_card: chargeRequest().credit_card }), (err) => {
      assert.equal(err.code, grpc.status.INVALID_ARGUMENT);
      assert.match(err.details, /amount/);
      return true;
    });
  });

  it('does not log the card number or CVV', async () => {
    const info = mock.method(logger, 'info');
    try {
      await call(paymentClient, 'charge', chargeRequest());
    } finally {
      info.mock.restore();
    }
    assert.ok(info.mock.callCount() > 0);
    for (const { arguments: args } of info.mock.calls) {
      const line = args.map(String).join(' ');
      assert.doesNotMatch(line, new RegExp(VISA));
      assert.doesNotMatch(line, /credit_card_cvv|987/);
    }
  });
});
