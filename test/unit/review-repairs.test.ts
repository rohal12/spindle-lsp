import { it } from 'vitest';
import { registerRepairContracts } from '../review/support/repair-contracts.js';
registerRepairContracts((id, _dims, run) => it(id, run));
