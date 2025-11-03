import { Router, Request, Response } from 'express';
import { StreamStateService } from '../services/stream-state';

export function createEventsRouter(stateService: StreamStateService): Router {
  const router = Router();

  router.get('/:streamId', (req: Request, res: Response) => {
    const { streamId } = req.params;
    const { limit } = req.query;
    const limitNum = limit ? parseInt(limit as string, 10) : 100;

    const events = stateService.getStreamEvents(streamId, limitNum);
    res.json({ streamId, events, count: events.length });
  });

  return router;
}

