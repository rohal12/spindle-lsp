import { afterAll, beforeAll, it } from 'vitest';
import { buildDist, type DistBuild } from './support/dist-build.js';
import { registerRepairEntrypoints } from '../review/support/repair-entrypoints.js';
let dist: DistBuild;
beforeAll(() => { dist = buildDist(); });
afterAll(() => dist?.dispose());
registerRepairEntrypoints((id, _dims, run) => it(id, run), () => dist.executable);
