import type { SpindlePlugin } from '../core/plugin/plugin-api.js';
import { diagnosticsPlugin } from './diagnostics.js';

/**
 * Registry of all feature plugins.
 */
export const allPlugins: SpindlePlugin[] = [diagnosticsPlugin];
