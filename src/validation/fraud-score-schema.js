export const fraudScoreSchema = {
  body: {
    type: 'object',
    required: ['id', 'transaction', 'customer', 'merchant', 'terminal', 'last_transaction'],
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      transaction: {
        type: 'object',
        required: ['amount', 'installments', 'requested_at'],
        additionalProperties: false,
        properties: {
          amount: { type: 'number' },
          installments: { type: 'integer' },
          requested_at: { type: 'string', format: 'date-time' }
        }
      },
      customer: {
        type: 'object',
        required: ['avg_amount', 'tx_count_24h', 'known_merchants'],
        additionalProperties: false,
        properties: {
          avg_amount: { type: 'number' },
          tx_count_24h: { type: 'integer' },
          known_merchants: {
            type: 'array',
            items: { type: 'string' }
          }
        }
      },
      merchant: {
        type: 'object',
        required: ['id', 'mcc', 'avg_amount'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          mcc: { type: 'string' },
          avg_amount: { type: 'number' }
        }
      },
      terminal: {
        type: 'object',
        required: ['is_online', 'card_present', 'km_from_home'],
        additionalProperties: false,
        properties: {
          is_online: { type: 'boolean' },
          card_present: { type: 'boolean' },
          km_from_home: { type: 'number' }
        }
      },
      last_transaction: {
        type: ['object', 'null'],
        required: ['timestamp', 'km_from_current'],
        additionalProperties: false,
        properties: {
          timestamp: { type: 'string', format: 'date-time' },
          km_from_current: { type: 'number' }
        }
      }
    }
  },
  response: {
    200: {
      type: 'object',
      required: ['approved', 'fraud_score'],
      additionalProperties: false,
      properties: {
        approved: { type: 'boolean' },
        fraud_score: { type: 'number' }
      }
    }
  }
}
