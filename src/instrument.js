'use strict';
require('dotenv').config({ quiet: true });
const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        // Send default PII data (e.g. IP address) with error reports
        sendDefaultPii: true,
        integrations: [
            Sentry.captureConsoleIntegration({
                levels: ['error', 'warn'],
            }),
        ],
    });
}
