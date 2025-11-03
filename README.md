# Livestream Orchestrator API

TypeScript-based API for managing LiveKit livestreams with real-time state updates.

## Features

- Stream lifecycle management (create, update, stop)
- Participant tracking with idempotent operations
- Real-time updates via gRPC and WebSocket
- Redis-based distributed state synchronization
- Idempotency middleware for safe retries
- LiveKit webhook integration

## Setup

### Prerequisites

- Node.js 18+
- LiveKit Cloud account

### Installation

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables:
```
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret
PORT=3000
GRPC_PORT=3001
REDIS_URL=redis://localhost:6379  # Optional, for distributed features
```

3. Start Redis (optional):
```bash
docker-compose up -d
```

4. Build and run:
```bash
npm run build
npm start
```

For development:
```bash
npm run dev
```

## Testing

Import the Postman collection (`postman/Orchestrator.postman_collection.json`) to test all REST endpoints. An example HTML client is available in `examples/client.html`.

Run unit tests:
```bash
npm test
```

## CI/CD

GitHub Actions runs on every push and pull request:
- Type checking
- Build validation
- Unit tests

The workflow tests against Node.js 18.x and 20.x.

## API Endpoints

### Streams

- `POST /streams` - Create stream
- `GET /streams` - List all streams
- `GET /streams/:id` - Get stream
- `GET /streams/:id/state` - Get stream state
- `PATCH /streams/:id` - Update stream
- `DELETE /streams/:id` - Stop stream
- `POST /streams/:id/join` - Join stream (returns LiveKit token)
- `POST /streams/:id/leave` - Leave stream

### Webhooks

- `POST /webhooks/livekit` - Handle LiveKit webhooks

### Health

- `GET /health` - Health check

## Real-time APIs

### WebSocket

Connect to `ws://localhost:3000` and send:
```json
{ "type": "subscribe", "streamId": "uuid" }
```

### gRPC

gRPC server runs on port 8001 (or `GRPC_PORT`). See `proto/streams.proto` for definitions.

- `Subscribe` - Server streaming events for a stream

**Testing with grpcurl:**

```bash
# Subscribe to stream events (server streaming)
grpcurl -plaintext -proto proto/streams.proto -d '{"stream_id": "your-stream-id"}' \
  localhost:8001 livestream.orchestrator.v1.StreamService/Subscribe
```

## Redis

Redis is optional but recommended for distributed deployments. It provides:
- Distributed locking for stream updates
- Event distribution across instances via pub/sub
- Idempotency key caching

Use `docker-compose.yml` to start Redis locally:
```bash
docker-compose up -d redis
```

Set `REDIS_URL` environment variable to enable Redis features.

## License

MIT
