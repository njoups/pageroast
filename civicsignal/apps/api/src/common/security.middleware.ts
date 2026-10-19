import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { AppRequest } from './request';

export function requestId(req: AppRequest, res: Response, next: NextFunction): void {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie auth, layered on SameSite=Lax:
 *  - a mutating request carrying an Origin must match an allowed origin;
 *  - a mutating request with no Origin that the browser marks cross-site (Sec-Fetch-Site) is rejected.
 * Non-browser clients send neither header and are unaffected (they hold no ambient cookie authority).
 */
export function originCheck(allowed: string[]) {
  return (req: AppRequest, res: Response, next: NextFunction): void => {
    if (SAFE.has(req.method)) return next();
    const origin = req.get('origin');
    const site = req.get('sec-fetch-site');
    const bad = origin ? !allowed.includes(origin) : site === 'cross-site';
    if (bad) {
      res.status(403).json({ error: { code: 'csrf_rejected', message: 'Cross-site request rejected', requestId: req.requestId } });
      return;
    }
    next();
  };
}
