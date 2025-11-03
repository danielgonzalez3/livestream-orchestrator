import { Request, Response, NextFunction } from 'express';
import { RedisService } from '../services/redis';
import { logger } from '../utils/logger';

// NOTE: Catch all TTL
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const IDEMPOTENCY_TTL = 3600;

export function createIdempotencyMiddleware(redisService?: RedisService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const idempotencyKey = req.headers[IDEMPOTENCY_KEY_HEADER] as string;
    if (!idempotencyKey) {
      return next();
    }

    if (!redisService || !redisService.isConnected()) {
      return next();
    }

    const key = `idempotency:${req.method}:${req.path}:${idempotencyKey}`;

    try {
      // check if we've seen this request before
      const cachedResponse = await redisService.get(key);
      if (cachedResponse) {
        const { status, body, headers } = JSON.parse(cachedResponse);
        logger.info('Idempotency cache hit', { key, status });
        
        // set headers and send cached response
        if (headers) {
          Object.entries(headers).forEach(([name, value]) => {
            res.setHeader(name, value as string);
          });
        }
        res.status(status).json(body);
        return;
      }

      // store original json method
      const originalJson = res.json.bind(res);
      
      // cache the response
      res.json = function(body: any): Response {
        const responseData = {
          status: res.statusCode,
          body,
          headers: res.getHeaders()
        };
        
        // cache the response asynchronously
        redisService.set(key, JSON.stringify(responseData), IDEMPOTENCY_TTL).catch(error => {
          logger.error('Failed to cache idempotency response', { error, key });
        });

        return originalJson(body);
      };

      next();
    } catch (error) {
      logger.error('Idempotency middleware error', { error, key });
      next();
    }
  };
}

