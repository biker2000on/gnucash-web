import { simulatePlanner } from '@/lib/debt-investment-planner';

self.onmessage = (event: MessageEvent<unknown>) => {
  try { self.postMessage({ result: simulatePlanner(event.data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : 'Simulation failed' }); }
};
