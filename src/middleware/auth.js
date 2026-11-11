import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../lib/errors.js';

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
}

export function setAuthCookie(res, token) {
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    path: '/',
    maxAge: 8 * 60 * 60 * 1000,
  });
}

export function clearAuthCookie(res) {
  res.clearCookie(config.cookieName, { httpOnly: true, secure: config.cookieSecure, sameSite: config.cookieSameSite, path: '/' });
}

/** Reads the JWT from the httpOnly cookie (or a Bearer header) and loads the user. */
export async function authenticate(req, _res, next) {
  const header = req.headers.authorization;
  const token = req.cookies?.[config.cookieName] || (header?.startsWith('Bearer ') ? header.slice(7) : null);
  if (!token) return next(new HttpError(401, 'Please log in'));

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(new HttpError(401, 'Your session has expired — please log in again'));
  }

  const user = await prisma.user.findUnique({ where: { id: Number(payload.sub) } });
  if (!user || !user.isActive || user.role !== payload.role) {
    return next(new HttpError(401, 'Your account is not active — please log in again'));
  }
  req.user = user;
  return next();
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(new HttpError(403, 'You do not have access to this area'));
  }
  return next();
};