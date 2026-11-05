import { prisma } from './prisma.js';

/**
 * Write a permanent history record. Never throws — logging must not break the request.
 * @param {{ action: string, entityType: string, entityId?: number, actor?: {id:number, role:string}, details?: object }} entry
 */
export async function logActivity({ action, entityType, entityId = null, actor = null, details = null }, client = prisma) {
  try {
    await client.activityLog.create({
      data: {
        action,
        entityType,
        entityId,
        actorId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        // round-trip through JSON so Dates/BigInts become plain JSON values
        details: details ? JSON.parse(JSON.stringify(details)) : undefined,
      },
    });
  } catch (err) {
    console.error('[activity] failed to log', action, err.message);
  }
}

export const fullName = (u) => (u ? [u.firstName, u.middleName, u.lastName].filter(Boolean).join(' ') : '');

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    employeeId: u.employeeId,
    firstName: u.firstName,
    middleName: u.middleName,
    lastName: u.lastName,
    fullName: fullName(u),
    email: u.email,
    role: u.role,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

/** "YYYY-MM-DD" -> Date at UTC midnight (matches Postgres DATE) */
export function parseWorkDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const formatWorkDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
