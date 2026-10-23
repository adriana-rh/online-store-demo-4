// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const { status } = require('@grpc/grpc-js');
const cardValidator = require('simple-card-validator');
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');

const logger = pino({
  name: 'paymentservice-charge',
  messageKey: 'message',
  formatters: {
    level (logLevelString, logLevelNum) {
      return { severity: logLevelString }
    }
  }
});


class CreditCardError extends Error {
  constructor (message) {
    super(message);
    this.code = status.INVALID_ARGUMENT;
  }
}

class InvalidChargeRequest extends CreditCardError {
  constructor (field) {
    super(`Charge request is missing ${field}`);
  }
}

class InvalidCreditCard extends CreditCardError {
  constructor (cardType) {
    super(`Credit card info is invalid`);
  }
}

class UnacceptedCreditCard extends CreditCardError {
  constructor (cardType) {
    super(`Sorry, we cannot process ${cardType} credit cards. Only VISA or MasterCard is accepted.`);
  }
}

class ExpiredCreditCard extends CreditCardError {
  constructor (number, month, year) {
    super(`Your credit card (ending ${number.substr(-4)}) expired on ${month}/${year}`);
  }
}

// simple-card-validator throws a non-Error string for empty input.
function getCardDetails (cardNumber) {
  if (typeof cardNumber !== 'string' || cardNumber.length === 0) { throw new InvalidCreditCard(); }
  return cardValidator(cardNumber).getCardDetails();
}

/**
 * Verifies the credit card number and (pretend) charges the card.
 *
 * @param {*} request
 * @return transaction_id - a random uuid.
 */

module.exports = function charge (request) {
  const { amount, credit_card: creditCard } = request || {};
  if (!creditCard) { throw new InvalidChargeRequest('credit_card'); }
  if (!amount) { throw new InvalidChargeRequest('amount'); }

  const cardNumber = creditCard.credit_card_number;
  const {
    card_type: cardType,
    valid
  } = getCardDetails(cardNumber);

  if (!valid) { throw new InvalidCreditCard(); }

  // Only VISA and mastercard is accepted, other card types (AMEX, dinersclub) will
  // throw UnacceptedCreditCard error.
  if (!(cardType === 'visa' || cardType === 'mastercard')) { throw new UnacceptedCreditCard(cardType); }

  const { credit_card_expiration_year: year, credit_card_expiration_month: month } = creditCard;
  if (!Number.isInteger(month) || month < 1 || month > 12) { throw new InvalidCreditCard(); }

  // Also validate expiration is > today.
  const currentMonth = new Date().getMonth() + 1;
  const currentYear = new Date().getFullYear();
  if ((currentYear * 12 + currentMonth) > (year * 12 + month)) { throw new ExpiredCreditCard(cardNumber.replace(/-/g, ''), month, year); }

  logger.info(`Transaction processed: ${cardType} ending ${cardNumber.substr(-4)} \
    Amount: ${amount.currency_code}${amount.units}.${amount.nanos}`);

  return { transaction_id: uuidv4() };
};

module.exports.CreditCardError = CreditCardError;
module.exports.InvalidCreditCard = InvalidCreditCard;
module.exports.InvalidChargeRequest = InvalidChargeRequest;
module.exports.UnacceptedCreditCard = UnacceptedCreditCard;
module.exports.ExpiredCreditCard = ExpiredCreditCard;
