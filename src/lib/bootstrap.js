import bcrypt from 'bcryptjs';
import { prisma } from './prisma.js';
import { config } from '../config.js';

/**
 * Make sure the admin account exists and matches ADMIN_USERNAME / ADMIN_PASSWORD from .env.
 * The admin "username" is stored in the employeeId column.
 */
export async function ensureAdmin() {
  const existing = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { id: 'asc' } });

  if (!existing) {
    await prisma.user.create({
      data: {
        employeeId: config.adminUsername,
        firstName: 'System',
        lastName: 'Admin',
        email: config.adminEmail,
        role: 'ADMIN',
        passwordHash: await bcrypt.hash(config.adminPassword, 12),
      },
    });
    console.log(`[bootstrap] Admin account created (username: ${config.adminUsername})`);
    return;
  }

  const data = {};
  if (existing.employeeId !== config.adminUsername) data.employeeId = config.adminUsername;
  if (!(await bcrypt.compare(config.adminPassword, existing.passwordHash))) {
    data.passwordHash = await bcrypt.hash(config.adminPassword, 12);
  }
  if (!existing.isActive) data.isActive = true;
  if (Object.keys(data).length) {
    await prisma.user.update({ where: { id: existing.id }, data });
    console.log('[bootstrap] Admin account synced with .env');
  }
}
