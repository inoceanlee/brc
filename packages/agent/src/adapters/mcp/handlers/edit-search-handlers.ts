import {
    EditBlockArgsSchema
} from '../schemas.js';

import { handleEditBlock } from '../../filesystem/edit.js';

import { ServerResult } from '../../../core/types.js';

/**
 * Handle edit_block command
 * Uses the enhanced implementation with multiple occurrence support and fuzzy matching
 */
export { handleEditBlock };