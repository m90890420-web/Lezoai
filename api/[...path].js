'use strict';

// Vercel catch-all API function. It forwards /api/* requests to the existing
// Express backend, preserving the current authentication and chat routes.
const app = require('../server/index.js');
module.exports = app;
