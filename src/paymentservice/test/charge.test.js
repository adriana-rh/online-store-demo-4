const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { status } = require('@grpc/grpc-js');

const charge = require('../charge');
const {
  CreditCardError,
  InvalidCreditCard,
  InvalidChargeRequest,
  UnacceptedCreditCard,
  ExpiredCreditCard
} = charge;

const VISA = '4111111111111111';
const MASTERCARD = '5555555555554444';
const AMEX = '378282246310005';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const now = new Date();
const currentYear = now.getFullYear();
const currentMonth = now.getMonth() + 1;

function request (cardOverrides = {}, amountOverrides = {}) {
  return {
    amount: { currency_code: 'USD', units: 10, nanos: 500000000, ...amountOverrides },
    credit_card: {
      credit_card_number: VISA,
      credit_card_cvv: 123,
      credit_card_expiration_year: currentYear + 1,
      credit_card_expiration_month: 1,
      ...cardOverrides
    }
  };
}

function assertInvalidArgument (fn, ErrorClass, message) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof ErrorClass, `expected ${ErrorClass.name}, got ${err && err.constructor.name}`);
    assert.ok(err instanceof CreditCardError);
    assert.equal(err.code, status.INVALID_ARGUMENT);
    if (message) { assert.match(err.message, message); }
    return true;
  });
}

describe('charge', () => {
  describe('accepted cards', () => {
    it('charges a valid VISA card and returns a uuid transaction id', () => {
      const res = charge(request());
      assert.deepEqual(Object.keys(res), ['transaction_id']);
      assert.match(res.transaction_id, UUID_RE);
    });

    it('charges a valid MasterCard', () => {
      assert.match(charge(request({ credit_card_number: MASTERCARD })).transaction_id, UUID_RE);
    });

    it('accepts card numbers formatted with dashes', () => {
      assert.match(charge(request({ credit_card_number: '4111-1111-1111-1111' })).transaction_id, UUID_RE);
    });

    it('returns a unique transaction id per charge', () => {
      const ids = new Set(Array.from({ length: 20 }, () => charge(request()).transaction_id));
      assert.equal(ids.size, 20);
    });

    it('accepts a card that expires in the current month', () => {
      const req = request({ credit_card_expiration_year: currentYear, credit_card_expiration_month: currentMonth });
      assert.match(charge(req).transaction_id, UUID_RE);
    });

    it('accepts zero amounts', () => {
      assert.match(charge(request({}, { units: 0, nanos: 0 })).transaction_id, UUID_RE);
    });
  });

  describe('invalid card numbers', () => {
    it('rejects a number that fails the Luhn check', () => {
      assertInvalidArgument(() => charge(request({ credit_card_number: '4111111111111112' })), InvalidCreditCard, /invalid/);
    });

    it('rejects non-numeric input', () => {
      assertInvalidArgument(() => charge(request({ credit_card_number: 'not-a-card' })), InvalidCreditCard);
    });

    it('rejects an empty card number', () => {
      assertInvalidArgument(() => charge(request({ credit_card_number: '' })), InvalidCreditCard);
    });

    it('rejects a missing card number', () => {
      assertInvalidArgument(() => charge(request({ credit_card_number: undefined })), InvalidCreditCard);
    });
  });

  describe('unaccepted card types', () => {
    it('rejects American Express with a message naming the card type', () => {
      assertInvalidArgument(() => charge(request({ credit_card_number: AMEX })), UnacceptedCreditCard,
        /cannot process amex credit cards/);
    });

    it('rejects Discover', () => {
      assertInvalidArgument(() => charge(request({ credit_card_number: '6011111111111117' })), UnacceptedCreditCard,
        /cannot process discover/);
    });
  });

  describe('expiration', () => {
    it('rejects a card that expired last month and reports the last four digits', () => {
      const last = new Date(currentYear, currentMonth - 2, 1);
      const month = last.getMonth() + 1;
      const year = last.getFullYear();
      assertInvalidArgument(
        () => charge(request({ credit_card_expiration_year: year, credit_card_expiration_month: month })),
        ExpiredCreditCard,
        new RegExp(`ending 1111\\) expired on ${month}/${year}`)
      );
    });

    it('rejects a card that expired in a previous year', () => {
      assertInvalidArgument(
        () => charge(request({ credit_card_expiration_year: currentYear - 1, credit_card_expiration_month: 12 })),
        ExpiredCreditCard
      );
    });

    it('reports the last four digits of a dashed expired card number', () => {
      assertInvalidArgument(
        () => charge(request({ credit_card_number: '5555-5555-5555-4444', credit_card_expiration_year: currentYear - 1 })),
        ExpiredCreditCard,
        /ending 4444\)/
      );
    });

    for (const month of [0, 13, -1, 1.5, undefined]) {
      it(`rejects expiration month ${month}`, () => {
        assertInvalidArgument(
          () => charge(request({ credit_card_expiration_year: currentYear + 1, credit_card_expiration_month: month })),
          InvalidCreditCard
        );
      });
    }
  });

  describe('malformed requests', () => {
    it('rejects a request without credit card info', () => {
      assertInvalidArgument(() => charge({ amount: request().amount }), InvalidChargeRequest, /credit_card/);
    });

    it('rejects a request with null credit card info', () => {
      assertInvalidArgument(() => charge({ amount: request().amount, credit_card: null }), InvalidChargeRequest, /credit_card/);
    });

    it('rejects a request without an amount', () => {
      assertInvalidArgument(() => charge({ credit_card: request().credit_card }), InvalidChargeRequest, /amount/);
    });

    it('rejects an undefined request', () => {
      assertInvalidArgument(() => charge(undefined), InvalidChargeRequest);
    });
  });
});
