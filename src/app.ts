import express, { Express } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { config } from './config';
import { LiveKitService } from './services/livekit';
import { StreamStateService } from './services/stream-state';
import { StreamOrchestratorService } from './services/stream-orchestrator';
// import { WebSocketService } from './services/websocket';
import { GrpcService } from './services/grpc';
import { RedisService } from './services/redis';
import { createStreamsRouter } from './routes/streams';
import { createWebhooksRouter } from './routes/webhooks';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { logger } from './utils/logger';

export class App {
  private app: Express;
  private server: ReturnType<typeof createServer>;
  private livekitService: LiveKitService;
  private stateService: StreamStateService;
  private orchestrator: StreamOrchestratorService;
  // private wsService?: WebSocketService;
  private grpcService?: GrpcService;
  private redisService?: RedisService;

  constructor() {
    this.app = express();
    this.server = createServer(this.app);

    // Initialize services
    this.livekitService = new LiveKitService(config.livekit);
    
    this.redisService = config.redis?.url 
      ? new RedisService(config.redis.url)
      : undefined;
    
    this.stateService = new StreamStateService(this.redisService);
    this.orchestrator = new StreamOrchestratorService(this.livekitService, this.stateService);

    if (this.redisService) {
      this.redisService.connect().catch(error => {
        logger.error('Failed to connect Redis', { error });
      });
    }

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();

    // this.wsService = new WebSocketService(this.server, this.stateService);
    this.grpcService = new GrpcService(this.stateService);
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    this.app.get('/health', (_req: any, res: any) => {
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        // wsClients: this.wsService?.getClientCount() || 0,
        grpcClients: this.grpcService?.getClientCount() || 0,
        uptime: process.uptime()
      });
    });
  }

  private setupRoutes(): void {
    this.app.use('/streams', createStreamsRouter(this.orchestrator, this.stateService, this.redisService));
    this.app.use('/webhooks', createWebhooksRouter(this.orchestrator, this.stateService));
  }

  private setupErrorHandling(): void {
    this.app.use(notFoundHandler);
    this.app.use(errorHandler);
  }

  public start(): void {
    const port = config.port;
    const grpcPort = config.grpcPort || 8001;
    
    this.server.listen(port, () => {
      logger.info(`Livestream Orchestrator API started on port ${port}`, {
        port,
        grpcPort,
        env: config.env,
        livekitUrl: config.livekit.url
      });
    });

    if (this.grpcService) {
      this.grpcService.start(grpcPort);
    }
  }

  public getApp(): Express {
    return this.app;
  }

  public getServer(): ReturnType<typeof createServer> {
    return this.server;
  }

  public async shutdown(): Promise<void> {
    logger.info('Shutting down server...');
  
    try {
      // Shutdown WS, gRPC, and Redis services
      await Promise.all([
        // this.wsService?.shutdown().catch(err => logger.error('WS shutdown failed', { err })),
        this.grpcService?.shutdown().catch(err => logger.error('gRPC shutdown failed', { err })),
        this.redisService?.disconnect().catch(err => logger.error('Redis disconnect failed', { err }))
      ]);
  
      if (this.server.listening) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            logger.warn('Server shutdown timeout, forcing close');
            if (typeof (this.server as any).closeAllConnections === 'function') {
              (this.server as any).closeAllConnections();
            }
            this.server.close(() => resolve());
          }, 5000);
  
          this.server.close(() => {
            clearTimeout(timeout);
            logger.info('HTTP server shutdown complete');
            resolve();
          });
        });
      }
  
      logger.info('All services shutdown complete');
    } catch (error) {
      logger.error('Error during shutdown', { error });
      // Force close HTTP server if still listening
      if (this.server.listening) {
        if (typeof (this.server as any).closeAllConnections === 'function') {
          (this.server as any).closeAllConnections();
        }
        this.server.close();
      }
      throw error;
    }
  }
}

