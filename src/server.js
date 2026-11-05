import { config } from './config.js';
import { createApp } from './app.js';
import { prisma } from './lib/prisma.js';
import { ensureStorageDirs } from './lib/storage.js';
import { ensureAdmin } from './lib/bootstrap.js';

async function main() {
  await ensureStorageDirs();
  await prisma.$connect();
  await ensureAdmin();

  const server = createApp().listen(config.port, () => {
    console.log(`API running on http://localhost:${config.port}`);
    console.log(`Storage folder: ${config.storageRoot}`);
  });
  // Big ZIP uploads can take a while
  server.requestTimeout = 60 * 60 * 1000;
  server.headersTimeout = 65 * 1000;

  const shutdown = async () => {
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (err) => {
  console.error('Failed to start server:', err);
  await prisma.$disconnect();
  process.exit(1);
});
