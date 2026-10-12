export interface ServiceHealth {
  service: string;
  status: 'ok';
  timestamp: string;
}

export * from './states.js';
