import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import { StreamStateService } from './stream-state';
import { StreamEvent } from '../types';
import { logger } from '../utils/logger';

interface ClientConnection {
  ws: WebSocket;
  streamId?: string;
  subscribedStreams: Set<string>;
}

export class WebSocketService {
  private wss: WebSocketServer;
  private clients: Map<WebSocket, ClientConnection> = new Map();

  constructor(server: Server, stateService: StreamStateService) {
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws: WebSocket) => {
      this.handleConnection(ws);
    });

    stateService.onStreamEvent((event) => this.broadcastEvent(event));

    logger.info('WebSocket server initialized');
  }

  private handleConnection(ws: WebSocket): void {
    const client: ClientConnection = {
      ws,
      subscribedStreams: new Set()
    };

    this.clients.set(ws, client);

    ws.on('message', (message: string) => {
      try {
        const data = JSON.parse(message.toString());
        this.handleMessage(client, data);
      } catch (error) {
        logger.error('Failed to parse WebSocket message', { error, message });
        this.sendError(ws, 'Invalid message format');
      }
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      logger.info('WebSocket client disconnected', { clientCount: this.clients.size });
    });

    ws.on('error', (error: Error) => {
      logger.error('WebSocket error', { error });
      this.clients.delete(ws);
    });

    this.send(ws, {
      type: 'connected',
      message: 'Connected to Livestream Orchestrator WebSocket',
      timestamp: new Date()
    });

    logger.info('WebSocket client connected', { clientCount: this.clients.size });
  }

  private handleMessage(client: ClientConnection, data: any): void {
    switch (data.type) {
      case 'subscribe':
        if (data.streamId) {
          client.subscribedStreams.add(data.streamId);
          this.send(client.ws, {
            type: 'subscribed',
            streamId: data.streamId,
            timestamp: new Date()
          });
          logger.info('Client subscribed to stream', { streamId: data.streamId });
        }
        break;

      case 'unsubscribe':
        if (data.streamId) {
          client.subscribedStreams.delete(data.streamId);
          this.send(client.ws, {
            type: 'unsubscribed',
            streamId: data.streamId,
            timestamp: new Date()
          });
          logger.info('Client unsubscribed from stream', { streamId: data.streamId });
        }
        break;

      case 'ping':
        this.send(client.ws, { type: 'pong', timestamp: new Date() });
        break;

      default:
        this.sendError(client.ws, `Unknown message type: ${data.type}`);
    }
  }

  private broadcastEvent(event: StreamEvent): void {
    const message = JSON.stringify(event);
    let broadcastCount = 0;

    for (const [ws, client] of this.clients.entries()) {
      // send to clients explicitly subscribed to this specific stream
      if (client.subscribedStreams.size > 0 && client.subscribedStreams.has(event.streamId)) {
        if (this.isAlive(ws)) {
          ws.send(message);
          broadcastCount++;
        }
      }
    }

    if (broadcastCount > 0) {
      logger.info(`Broadcasted event to ${broadcastCount} clients`, {
        eventType: event.type,
        streamId: event.streamId
      });
    }
  }

  private send(ws: WebSocket, data: any): void {
    if (this.isAlive(ws)) {
      ws.send(JSON.stringify(data));
    }
  }

  private sendError(ws: WebSocket, message: string): void {
    this.send(ws, {
      type: 'error',
      message,
      timestamp: new Date()
    });
  }

  private isAlive(ws: WebSocket): boolean {
    return ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Gracefully shutdown WebSocket server
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down WebSocket server...');
    
    // Close all client connections
    for (const [ws] of this.clients.entries()) {
      if (this.isAlive(ws)) {
        ws.close(1000, 'Server shutting down');
      }
    }
    
    // Close the WebSocket server
    return new Promise((resolve) => {
      this.wss.close(() => {
        logger.info('WebSocket server shutdown complete');
        resolve();
      });
    });
  }
}

