// Seeds the admin account (and optionally two demo users).
// Usage:  npx prisma db seed            -> admin only
//         SEED_DEMO_USERS=true npx prisma db seed  -> admin + 2 demo users
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma.js';
import { ensureAdmin } from '../src/lib/bootstrap.js';
import { config } from '../src/config.js';

async function main() {
  await ensureAdmin();

  if (process.env.SEED_DEMO_USERS === 'true') {
    const passwordHash = await bcrypt.hash(config.defaultUserPassword, 12);
    const demo = [
      { employeeId: 'EMP001', firstName: 'Priya', lastName: 'Raman', email: 'priya@example.com' },
      { employeeId: 'EMP002', firstName: 'Arun', middleName: 'K', lastName: 'Kumar', email: 'arun@example.com' },
    ];
    for (const u of demo) {
      await prisma.user.upsert({
        where: { employeeId: u.employeeId },
        update: {},
        create: { ...u, passwordHash, role: 'USER' },
      });
    }
    console.log(`Demo users ready (password: ${config.defaultUserPassword})`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
