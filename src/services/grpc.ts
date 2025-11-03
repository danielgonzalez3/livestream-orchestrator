import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { StreamStateService } from './stream-state';
import { StreamEvent } from '../types';
import { logger } from '../utils/logger';
import {
  convertEventToGrpc,
  getProtoPath
} from '../utils/grpc_util';

const PROTO_PATH = getProtoPath();

interface GrpcClient {
  streamId?: string;
  call: grpc.ServerWritableStream<any, any>;
}

export class GrpcService {
  private server: grpc.Server;
  private clients: Set<GrpcClient> = new Set();
  private packageDefinition: protoLoader.PackageDefinition;
  private protoDescriptor: any;

  constructor(
    private stateService: StreamStateService
  ) {
    this.server = new grpc.Server();
    this.packageDefinition = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true
    });

    this.protoDescriptor = grpc.loadPackageDefinition(this.packageDefinition);
    this.setupServices();
    this.stateService.onStreamEvent((event: StreamEvent) => this.broadcastEvent(event));

    logger.info('gRPC service initialized');
  }

  private setupServices(): void {
    const streamService = (this.protoDescriptor as any).livestream.orchestrator.v1.StreamService;

    this.server.addService(streamService.service, {
      Subscribe: this.handleSubscribe.bind(this)
    });
  }

  private async handleSubscribe(
    call: grpc.ServerWritableStream<any, any>
  ): Promise<void> {
    const request = call.request;
    logger.info('Received gRPC subscribe request', { request });
    
    // validate stream_id BEFORE any processing
    const streamId = request.stream_id?.trim();
    if (!streamId || streamId === '') {
      const error: any = {
        code: grpc.status.INVALID_ARGUMENT,
        message: 'stream_id is required',
        details: 'stream_id cannot be empty'
      };
      logger.warn('gRPC subscribe rejected: empty stream_id');
      call.emit('error', error);
      call.end();
      return;
    }

    logger.info('gRPC client subscribed to events', { streamId });

    try {
      const stream = await this.stateService.getStream(streamId);
      if (!stream) {
        const error: any = {
          code: grpc.status.NOT_FOUND,
          message: `Stream with id ${streamId} not found`
        };
        call.emit('error', error);
        call.end();
        return;
      }

      const client: GrpcClient = {
        streamId,
        call
      };

      this.clients.add(client);

      call.on('cancelled', () => {
        this.clients.delete(client);
        logger.info('gRPC subscriber disconnected', { streamId, clientCount: this.clients.size });
      });

      call.on('end', () => {
        this.clients.delete(client);
        logger.info('gRPC subscriber ended connection', { streamId, clientCount: this.clients.size });
      });
    } catch (error) {
      logger.error('Error handling subscribe', { error, streamId });
      const grpcError: any = {
        code: grpc.status.INTERNAL,
        message: error instanceof Error ? error.message : 'Internal server error'
      };
      call.emit('error', grpcError);
      call.end();
    }
  }

  private broadcastEvent(event: StreamEvent): void {
    const grpcEvent = convertEventToGrpc(event);
    let broadcastCount = 0;
    const clientsToRemove: GrpcClient[] = [];
    
    for (const client of this.clients) {
      // only send to clients explicitly subscribed to this specific stream
      if (client.streamId && client.streamId === event.streamId) {
        try {
          client.call.write(grpcEvent);
          broadcastCount++;
          // if stream is stopped, end the subscription
          if (event.type === 'stream_stopped') {
            logger.info('Stream stopped, ending gRPC subscription', { streamId: event.streamId });
            client.call.end();
            clientsToRemove.push(client);
          }
        } catch (error) {
          logger.error('Failed to send event to gRPC client', { error });
          clientsToRemove.push(client);
        }
      }
    }

    // remove dead clients after iteration to avoid modifying Set during iteration
    for (const client of clientsToRemove) {
      this.clients.delete(client);
    }

    if (broadcastCount > 0) {
      logger.info(`Broadcasted event to ${broadcastCount} gRPC clients`, {
        eventType: event.type,
        streamId: event.streamId
      });
    }
  }


  public start(port: number): void {
    this.server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (error: Error | null, actualPort?: number) => {
        if (error) {
          logger.error('Failed to start gRPC server', { error });
          return;
        }
        logger.info(`gRPC server started on port ${actualPort}`);
      }
    );
  }

  public getClientCount(): number {
    return this.clients.size;
  }

  public shutdown(): Promise<void> {
    return new Promise((resolve) => {
      this.server.tryShutdown(() => {
        logger.info('gRPC server shutdown complete');
        resolve();
      });
    });
  }
}

