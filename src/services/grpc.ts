import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { join } from 'path';
import { existsSync } from 'fs';
import { StreamStateService } from './stream-state';
import { StreamOrchestratorService } from './stream-orchestrator';
import { Stream, StreamStatus, Participant, StreamEvent } from '../types';
import { logger } from '../utils/logger';

const getProtoPath = (): string => {
  if (typeof __dirname !== 'undefined') {
    const path = join(__dirname, '../../proto/streams.proto');
    if (existsSync(path)) return path;
  }
  return join(process.cwd(), 'proto/streams.proto');
};

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
    private stateService: StreamStateService,
    private orchestrator: StreamOrchestratorService
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
      StreamUpdates: this.handleStreamUpdates.bind(this),
      GetStreamState: this.handleGetStreamState.bind(this),
      Subscribe: this.handleSubscribe.bind(this)
    });
  }

  private async handleStreamUpdates(
    call: grpc.ServerWritableStream<any, any>
  ): Promise<void> {
    const request = call.request;
    const streamId = request.stream_id || undefined;

    logger.info('gRPC client connected for stream updates', { streamId });

    const client: GrpcClient = {
      streamId,
      call
    };

    this.clients.add(client);

    if (streamId) {
      const stream = await this.orchestrator.getStream(streamId);
      if (stream) {
        call.write(this.convertStreamToUpdate(stream, 'created'));
      }
    } else {
      const streams = this.stateService.getAllStreams();
      for (const stream of streams) {
        call.write(this.convertStreamToUpdate(stream, 'created'));
      }
    }

    call.on('cancelled', () => {
      this.clients.delete(client);
      logger.info('gRPC client disconnected', { streamId, clientCount: this.clients.size });
    });

    call.on('end', () => {
      this.clients.delete(client);
      logger.info('gRPC client ended connection', { streamId, clientCount: this.clients.size });
    });
  }

  private async handleGetStreamState(
    call: grpc.ServerUnaryCall<any, any>,
    callback: grpc.sendUnaryData<any>
  ): Promise<void> {
    try {
      const request = call.request;
      const streamId = request.stream_id;

      if (!streamId) {
        callback({
          code: grpc.status.INVALID_ARGUMENT,
          message: 'stream_id is required'
        });
        return;
      }

      const stream = await this.orchestrator.getStream(streamId);
      if (!stream) {
        callback({
          code: grpc.status.NOT_FOUND,
          message: `Stream with id ${streamId} not found`
        });
        return;
      }

      const state = this.convertStreamToState(stream);
      callback(null, state);
    } catch (error) {
      logger.error('Error getting stream state via gRPC', { error });
      callback({
        code: grpc.status.INTERNAL,
        message: error instanceof Error ? error.message : 'Internal server error'
      });
    }
  }

  private async handleSubscribe(
    call: grpc.ServerWritableStream<any, any>
  ): Promise<void> {
    const request = call.request;
    const streamId = request.stream_id || undefined;

    logger.info('gRPC client subscribed to events', { streamId });

    const client: GrpcClient = {
      streamId,
      call
    };

    this.clients.add(client);

    const events = this.stateService.getStreamEvents(streamId, 10);
    for (const event of events) {
      call.write(this.convertEventToGrpc(event));
    }

    call.on('cancelled', () => {
      this.clients.delete(client);
      logger.info('gRPC subscriber disconnected', { streamId, clientCount: this.clients.size });
    });

    call.on('end', () => {
      this.clients.delete(client);
      logger.info('gRPC subscriber ended connection', { streamId, clientCount: this.clients.size });
    });
  }

  private broadcastEvent(event: StreamEvent): void {
    const grpcEvent = this.convertEventToGrpc(event);
    let broadcastCount = 0;
    const clientsToRemove: GrpcClient[] = [];

    for (const client of this.clients) {
      // only send to clients explicitly subscribed to this specific stream
      if (client.streamId && client.streamId === event.streamId) {
        try {
          client.call.write(grpcEvent);
          broadcastCount++;
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

  private convertStreamToUpdate(stream: Stream, updateType: string): any {
    return {
      stream_id: stream.id,
      status: this.convertStatusToGrpc(stream.status),
      participants: stream.participants.map(p => this.convertParticipantToGrpc(p)),
      timestamp: stream.updatedAt.getTime(),
      update_type: this.getUpdateType(updateType),
      metadata: stream.metadata ? this.convertMetadata(stream.metadata) : {}
    };
  }

  private convertStreamToState(stream: Stream): any {
    return {
      stream_id: stream.id,
      status: this.convertStatusToGrpc(stream.status),
      participants: stream.participants.map(p => this.convertParticipantToGrpc(p)),
      started_at: stream.createdAt.getTime(),
      updated_at: stream.updatedAt.getTime(),
      stopped_at: stream.stoppedAt ? stream.stoppedAt.getTime() : 0,
      metadata: stream.metadata ? this.convertMetadata(stream.metadata) : {}
    };
  }

  private convertEventToGrpc(event: StreamEvent): any {
    const result: any = {
      event_type: this.convertEventTypeToGrpc(event.type),
      stream_id: event.streamId,
      timestamp: event.timestamp.getTime()
    };

    const stream = event.data?.stream || event.data;
    const participant = event.data?.participant;

    switch (event.type) {
      case 'stream_created':
        result.stream_created = {
          room_name: stream?.roomName || '',
          metadata: stream?.metadata ? this.convertMetadata(stream.metadata) : {}
        };
        break;
      case 'stream_updated':
        result.stream_updated = {
          previous_status: stream?.previousStatus 
            ? this.convertStatusToGrpc(stream.previousStatus) 
            : 0,
          current_status: stream?.status 
            ? this.convertStatusToGrpc(stream.status) 
            : 0,
          metadata: stream?.metadata ? this.convertMetadata(stream.metadata) : {}
        };
        break;
      case 'stream_stopped':
        result.stream_stopped = {
          room_name: stream?.roomName || ''
        };
        break;
      case 'participant_joined':
        if (participant) {
          result.participant_joined = {
            participant: this.convertParticipantToGrpc(participant)
          };
        }
        break;
      case 'participant_left':
        if (participant) {
          result.participant_left = {
            participant: this.convertParticipantToGrpc(participant)
          };
        }
        break;
    }

    return result;
  }

  private convertParticipantToGrpc(participant: Participant): any {
    return {
      id: participant.id,
      identity: participant.identity,
      joined_at: participant.joinedAt.getTime(),
      left_at: participant.leftAt ? participant.leftAt.getTime() : 0,
      metadata: participant.metadata ? this.convertMetadata(participant.metadata) : {}
    };
  }

  private convertStatusToGrpc(status: StreamStatus): number {
    const statusMap: Record<StreamStatus, number> = {
      'creating': 1,
      'active': 2,
      'stopping': 3,
      'stopped': 4,
      'error': 5
    };
    return statusMap[status] || 0;
  }

  private convertEventTypeToGrpc(type: StreamEvent['type']): number {
    const typeMap: Record<StreamEvent['type'], number> = {
      'stream_created': 1,
      'stream_updated': 2,
      'stream_stopped': 3,
      'participant_joined': 4,
      'participant_left': 5
    };
    return typeMap[type] || 0;
  }

  private getUpdateType(type: string): number {
    const updateTypeMap: Record<string, number> = {
      'created': 1,
      'updated': 2,
      'stopped': 3,
      'status_changed': 4,
      'participant_joined': 5,
      'participant_left': 6
    };
    return updateTypeMap[type] || 0;
  }

  private convertMetadata(metadata: Record<string, any>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata)) {
      result[key] = String(value);
    }
    return result;
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
        this.server.start();
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

