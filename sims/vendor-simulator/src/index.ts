// WP-027: the vendor-sim service surface for in-process consumers (the
// reference loops bind a rail directly rather than over a socket). The HTTP
// bootstrap lives in server.ts and is not exported — importing it would start a
// listener.
export * from './rails.js';
export * from './service.js';
