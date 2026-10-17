import pkg from '../package.json' with { type: 'json' };

declare const SPINDLE_LSP_VERSION: string;

/** The build's injected version, with the package version for source consumers. */
export const VERSION = typeof SPINDLE_LSP_VERSION === 'undefined' ? pkg.version : SPINDLE_LSP_VERSION;
