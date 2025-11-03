# Livestream Orchestrator API

A TypeScript-based API for managing LiveKit livestreams, including stream lifecycle management, participant tracking, and real-time state updates via gRPC streaming.

## Features

- **Stream Lifecycle Management**: Create, stop, and manage LiveKit livestreams
- **Participant Tracking**: Track user join/leave events with idempotent operations
- **Real-time Updates**: gRPC streaming, WebSocket, and Server-Sent Events (SSE) for live state updates
- **State Management**: In-memory state tracking with event history
- **LiveKit Integration**: Full integration with LiveKit Cloud for room management
- **Webhook Support**: Handle LiveKit webhooks for participant and room events
- **Type Safety**: Full TypeScript implementation with Zod validation

## Architecture

The API is built with a modular, service-oriented architecture:

```
┌─────────────────┐
│   REST API      │  ← Express.js routes
└────────┬────────┘
         │
┌────────▼─────────────────┐
│ StreamOrchestratorService │  ← Orchestrates stream operations
└────────┬──────────────────┘
         │
    ┌────┴────┐
    │         │
┌───▼───┐ ┌──▼──────┐
│LiveKit│ │Stream   │
│Service│ │State    │
│       │ │Service  │
└───────┘ └─────────┘
         │
┌────────▼────────┐
│   gRPC Server   │  ← gRPC streaming for real-time updates
└─────────────────┘
```

### Core Components

1. **LiveKitService**: Handles all LiveKit API interactions (room creation, deletion, participant management)
2. **StreamStateService**: Manages in-memory stream state with event emission
3. **StreamOrchestratorService**: Coordinates between LiveKit and state management
4. **GrpcService**: Provides gRPC streaming for real-time updates
5. **WebSocketService**: Provides WebSocket updates (optional, alongside gRPC)
6. **REST Routes**: HTTP endpoints for stream management

### State Model

Each stream maintains:
- Unique ID and room name
- Status (creating, active, stopping, stopped, error)
- Participant list with join/leave timestamps
- Metadata (custom key-value pairs)
- Creation and update timestamps

## Setup

### Prerequisites

- Node.js 18+ and npm
- LiveKit Cloud account (free tier available at https://cloud.livekit.io/)

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd favorited-livestream
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
```

Edit `.env` with your LiveKit credentials:
```
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
PORT=3000
GRPC_PORT=3001
```

**Note**: As per requirements, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` are assumed to be configured.

4. Build the project:
```bash
npm run build
```

5. Start the server:
```bash
npm start
```

For development with hot reload:
```bash
npm run dev
```

## API Endpoints

### Streams

#### Create Stream
```http
POST /streams
Content-Type: application/json

{
  "roomName": "my-stream",  // optional
  "metadata": {             // optional
    "title": "My Stream"
  }
}
```

Response:
```json
{
  "id": "uuid",
  "roomName": "my-stream",
  "status": "active",
  "createdAt": "2025-01-14T10:00:00Z",
  "updatedAt": "2025-01-14T10:00:00Z",
  "participants": [],
  "metadata": { "title": "My Stream" }
}
```

#### Get Stream
```http
GET /streams/:id
```

#### Get Stream State
```http
GET /streams/:id/state
```

Response:
```json
{
  "streamId": "uuid",
  "status": "active",
  "participants": [
    {
      "id": "user1",
      "identity": "user1",
      "joinedAt": "2025-01-14T10:05:00Z"
    }
  ],
  "startedAt": "2025-01-14T10:00:00Z",
  "updatedAt": "2025-01-14T10:05:00Z"
}
```

#### List All Streams
```http
GET /streams
```

#### Update Stream
```http
PATCH /streams/:id
Content-Type: application/json

{
  "status": "active",
  "metadata": { "title": "Updated Title" }
}
```

#### Stop Stream
```http
DELETE /streams/:id
```

#### Join Stream
```http
POST /streams/:id/join
Content-Type: application/json

{
  "participantName": "user1",
  "metadata": { "displayName": "John Doe" }
}
```

Response:
```json
{
  "token": "livekit-jwt-token",
  "streamId": "uuid",
  "participantName": "user1",
  "wsUrl": "wss://your-project.livekit.cloud"
}
```

#### Leave Stream
```http
POST /streams/:id/leave
Content-Type: application/json

{
  "participantName": "user1"
}
```

### Events

#### Server-Sent Events (SSE)
```http
GET /events?streamId=<optional>&limit=100
Accept: text/event-stream
```

Subscribe to real-time stream events via SSE. Events include:
- `stream_created`
- `stream_updated`
- `stream_stopped`
- `participant_joined`
- `participant_left`

#### Get Events History
```http
GET /events/:streamId?limit=100
```

### gRPC API

The API exposes a gRPC service for streaming updates. Default port is `3001` (HTTP port + 1).

#### Stream Updates (Server Streaming)
Stream real-time updates for a specific stream or all streams:

```typescript
// Example client usage
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const packageDefinition = protoLoader.loadSync('proto/streams.proto', {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
});

const proto = grpc.loadPackageDefinition(packageDefinition);
const client = new proto.livestream.orchestrator.v1.StreamService(
  'localhost:3001',
  grpc.credentials.createInsecure()
);

// Stream updates for all streams
const call = client.StreamUpdates({ stream_id: '' });
call.on('data', (update) => {
  console.log('Stream update:', update);
});

// Stream updates for specific stream
const call2 = client.StreamUpdates({ stream_id: 'stream-id-123' });
call2.on('data', (update) => {
  console.log('Stream update:', update);
});
```

#### Get Stream State (Unary)
Get current state of a stream:

```typescript
client.GetStreamState({ stream_id: 'stream-id-123' }, (error, state) => {
  if (error) {
    console.error('Error:', error);
    return;
  }
  console.log('Stream state:', state);
});
```

#### Subscribe to Events (Server Streaming)
Subscribe to stream events:

```typescript
const call = client.Subscribe({ stream_id: 'stream-id-123' });
call.on('data', (event) => {
  console.log('Event:', event);
});
```

### Webhooks

#### LiveKit Webhook Handler
```http
POST /webhooks/livekit
```

Configure this endpoint in your LiveKit Cloud dashboard to receive webhook events:
- `participant_joined`
- `participant_left`
- `room_started`
- `room_finished`

### Health Check

```http
GET /health
```

## WebSocket API

Connect to `ws://localhost:3000` for real-time updates.

### Message Types

#### Subscribe to Stream Events
```json
{
  "type": "subscribe",
  "streamId": "uuid"
}
```

#### Unsubscribe from Stream
```json
{
  "type": "unsubscribe",
  "streamId": "uuid"
}
```

#### Ping
```json
{
  "type": "ping"
}
```

### Event Messages

Server broadcasts events:
```json
{
  "type": "participant_joined",
  "streamId": "uuid",
  "data": {
    "participant": { ... },
    "stream": { ... }
  },
  "timestamp": "2025-01-14T10:05:00Z"
}
```

## Design Decisions

### Idempotency

All participant operations are idempotent:
- Adding the same participant multiple times updates the existing entry
- Removing participants tracks `leftAt` timestamp without deletion
- Stream creation generates unique IDs to prevent conflicts

### Concurrency

- In-memory state uses Map data structures for O(1) lookups
- Event emission is asynchronous and non-blocking
- gRPC broadcasts are handled concurrently

### State Management

- **In-memory**: Fast, simple, suitable for single-instance deployments
- **Event History**: Limited to last 1000 events to prevent memory bloat
- **Future**: Can be extended to Redis for distributed deployments

### Error Handling

- Zod validation for request validation
- Custom AppError class for structured error responses
- Comprehensive error logging with context
- Graceful error handling at all layers

### gRPC Streaming

- Server streaming for real-time updates
- Supports filtering by stream ID
- Efficient binary protocol
- Type-safe with Protocol Buffers

## Testing

Run tests:
```bash
npm test
```

Note: Full test suite requires LiveKit credentials. Tests include:
- Stream state management
- Idempotent operations
- Event emission

## Development

### Project Structure

```
src/
├── types/              # TypeScript type definitions
├── config/             # Configuration management
├── services/           # Business logic services
│   ├── livekit.service.ts
│   ├── stream-state.service.ts
│   ├── stream-orchestrator.service.ts
│   ├── grpc.service.ts
│   └── websocket.service.ts
├── routes/             # Express route handlers
│   ├── streams.routes.ts
│   ├── events.routes.ts
│   └── webhooks.routes.ts
├── middleware/         # Express middleware
│   └── error-handler.ts
├── utils/              # Utility functions
│   └── logger.ts
├── __tests__/          # Test files
├── app.ts              # Express app setup
└── index.ts            # Application entry point
proto/
└── streams.proto       # gRPC protocol definitions
```

### Code Quality

- TypeScript strict mode enabled
- ESLint configuration recommended
- Modular, single-responsibility design
- Comprehensive error handling
- Logging at all critical points

## Future Enhancements

- [ ] Redis backend for distributed state
- [ ] Prometheus metrics endpoint
- [ ] Stream cleanup job for inactive rooms
- [ ] Pub/Sub fan-out for scaling
- [ ] Rate limiting
- [ ] Authentication/authorization
- [ ] Database persistence for stream history

## License

MIT

## Resources

- [LiveKit Documentation](https://docs.livekit.io/)
- [LiveKit Cloud](https://cloud.livekit.io/)
- [LiveKit Server SDK](https://www.npmjs.com/package/livekit-server-sdk)
- [gRPC Documentation](https://grpc.io/docs/)
