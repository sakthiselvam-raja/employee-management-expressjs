import { PrismaClient } from '@prisma/client';

// BigInt columns (ZIP size) can't be JSON.stringified by default.
// eslint-disable-next-line no-extend-native
BigInt.prototype.toJSON = function toJSON() {
  return Number(this);
};

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
});
