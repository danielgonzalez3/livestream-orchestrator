import { Request, Response, NextFunction } from 'express';
import { createIdempotencyMiddleware } from '../../src/middleware/idempotency';
import { RedisService } from '../../src/services/redis';

describe('createIdempotencyMiddleware', () => {
  let mockRedis: jest.Mocked<RedisService>;
  let middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: jest.Mock;

  beforeEach(() => {
    mockRedis = {
      isConnected: jest.fn().mockReturnValue(true),
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined)
    } as any;

    middleware = createIdempotencyMiddleware(mockRedis);

    req = {
      method: 'POST',
      path: '/streams',
      headers: {}
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      getHeaders: jest.fn().mockReturnValue({ 'content-type': 'application/json' }),
      statusCode: 200
    };

    next = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should call next if no idempotency key is provided', async () => {
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('should call next if Redis is not available', async () => {
    const middlewareWithoutRedis = createIdempotencyMiddleware(undefined);
    req.headers!['idempotency-key'] = 'test-key';

    await middlewareWithoutRedis(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('should call next if Redis is not connected', async () => {
    mockRedis.isConnected.mockReturnValue(false);
    req.headers!['idempotency-key'] = 'test-key';

    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('should return cached response if idempotency key exists', async () => {
    req.headers!['idempotency-key'] = 'test-key';
    const cachedResponse = {
      status: 201,
      body: { id: 'stream-1', status: 'active' },
      headers: { 'content-type': 'application/json' }
    };

    mockRedis.get.mockResolvedValue(JSON.stringify(cachedResponse));

    await middleware(req as Request, res as Response, next);

    expect(mockRedis.get).toHaveBeenCalledWith('idempotency:POST:/streams:test-key');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(cachedResponse.body);
    expect(res.setHeader).toHaveBeenCalledWith('content-type', 'application/json');
    expect(next).not.toHaveBeenCalled();
  });

  it('should cache response after successful request', async () => {
    req.headers!['idempotency-key'] = 'test-key';
    mockRedis.get.mockResolvedValue(null);

    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    
    // simulate response being sent
    const responseBody = { id: 'stream-1' };
    res.statusCode = 201;
    (res.json as jest.Mock).call(res, responseBody);

    // wait for async cache operation
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockRedis.set).toHaveBeenCalledWith(
      'idempotency:POST:/streams:test-key',
      expect.stringContaining('"status":201'),
      30
    );
  });

  it('should handle errors gracefully', async () => {
    req.headers!['idempotency-key'] = 'test-key';
    mockRedis.get.mockRejectedValue(new Error('Redis error'));

    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('should handle invalid cached response JSON', async () => {
    req.headers!['idempotency-key'] = 'test-key';
    mockRedis.get.mockResolvedValue('invalid-json');

    await middleware(req as Request, res as Response, next);

    // should handle error and call next
    expect(next).toHaveBeenCalled();
  });

  it('should generate correct cache key for different methods and paths', async () => {
    req.headers!['idempotency-key'] = 'test-key';
    mockRedis.get.mockResolvedValue(null);

    await middleware(req as Request, res as Response, next);

    expect(mockRedis.get).toHaveBeenCalledWith('idempotency:POST:/streams:test-key');

    // Test PATCH
    const req2 = { ...req, method: 'PATCH', path: '/streams/123' } as Request;
    await middleware(req2, res as Response, next);
    expect(mockRedis.get).toHaveBeenCalledWith('idempotency:PATCH:/streams/123:test-key');
  });

  it('should cache response headers', async () => {
    req.headers!['idempotency-key'] = 'test-key';
    mockRedis.get.mockResolvedValue(null);

    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    
    // simulate response with headers
    res.statusCode = 201;
    const responseBody = { id: 'stream-1' };
    (res.json as jest.Mock).call(res, responseBody);

    // wait for async cache operation
    await new Promise(resolve => setTimeout(resolve, 10));

    const setCall = mockRedis.set!.mock.calls[0];
    const cachedData = JSON.parse(setCall[1] as string);
    
    expect(cachedData.headers).toBeDefined();
    expect(cachedData.headers['content-type']).toBe('application/json');
  });
});

