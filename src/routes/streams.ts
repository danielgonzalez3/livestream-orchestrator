import { Router, Request, Response, NextFunction } from 'express';
import { StreamOrchestratorService } from '../services/stream-orchestrator';
import { StreamStateService } from '../services/stream-state';
import { AppError } from '../middleware/error-handler';
import { StreamStatus } from '../types';
import { createIdempotencyMiddleware } from '../middleware/idempotency';
import { RedisService } from '../services/redis';

export function createStreamsRouter(
  orchestrator: StreamOrchestratorService,
  stateService: StreamStateService,
  redisService?: RedisService
): Router {
  const router = Router();

  // apply idempotency middleware to routes that need it (IE: POST/PATCH)
  const idempotencyMiddleware = createIdempotencyMiddleware(redisService);

  router.post('/', idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { roomName, metadata } = req.body || {};
      const idempotencyKey = req.headers['idempotency-key'] as string;
      const stream = await orchestrator.createStream(roomName, metadata, idempotencyKey);
      res.status(201).json(stream);
    } catch (error) {
      next(error);
    }
  });

  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const streams = await stateService.getAllStreams();
      res.json(streams);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const stream = await orchestrator.getStream(id);
      if (!stream) {
        return next(new AppError(404, `Stream with id ${id} not found`));
      }
      res.json(stream);
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id/state', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const stream = await orchestrator.getStream(id);
      if (!stream) {
        return next(new AppError(404, `Stream with id ${id} not found`));
      }

      res.json({
        streamId: stream.id,
        status: stream.status,
        participants: stream.participants.map(p => ({
          id: p.id,
          identity: p.identity,
          joinedAt: p.joinedAt,
          leftAt: p.leftAt
        })),
        startedAt: stream.createdAt,
        updatedAt: stream.updatedAt,
        stoppedAt: stream.stoppedAt,
        metadata: stream.metadata
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id', idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { status, metadata } = req.body || {};

      const stream = await stateService.getStream(id);
      if (!stream) {
        return next(new AppError(404, `Stream with id ${id} not found`));
      }

      if (status) {
        const validStatuses = ['creating', 'active', 'stopping', 'stopped', 'error'];
        if (validStatuses.includes(status)) {
          const expectedVersion = req.body.version;
          await stateService.updateStreamStatus(id, status as StreamStatus, expectedVersion);
        } else {
          return next(new AppError(400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`));
        }
      }

      if (metadata) {
        await stateService.updateStreamMetadata(id, metadata);
      }

      const updatedStream = await stateService.getStream(id);
      res.json(updatedStream);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', idempotencyMiddleware, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const stream = await orchestrator.stopStream(id);
      if (!stream) {
        return next(new AppError(404, `Stream with id ${id} not found`));
      }
      res.json({ message: 'Stream stopped successfully', stream });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/join', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { participantName, metadata } = req.body;

      if (!participantName || typeof participantName !== 'string') {
        return next(new AppError(400, 'participantName is required and must be a string'));
      }

      const token = await orchestrator.generateAccessToken(id, participantName, metadata);
      if (!token) {
        return next(new AppError(404, `Stream with id ${id} not found`));
      }

      await orchestrator.handleParticipantJoined(id, participantName, metadata);

      res.json({
        token,
        streamId: id,
        participantName,
        wsUrl: process.env.LIVEKIT_URL || ''
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/leave', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { participantName } = req.body;

      if (!participantName || typeof participantName !== 'string') {
        return next(new AppError(400, 'participantName is required and must be a string'));
      }

      const stream = await stateService.getStream(id);
      if (!stream) {
        return next(new AppError(404, `Stream with id ${id} not found`));
      }

      await orchestrator.handleParticipantLeft(id, participantName);

      res.json({
        message: 'Participant left stream successfully',
        streamId: id,
        participantName
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

