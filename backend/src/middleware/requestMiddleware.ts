import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export interface RequestWithId extends Request {
  requestId?: string;
}

export const requestMiddleware = (req: RequestWithId, res: Response, next: NextFunction) => {
  req.requestId = req.headers['x-request-id'] as string || crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  next();
};
