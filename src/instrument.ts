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
                levels: ['error'],
            }),
        ],
        beforeSend(event, hint) {
            const error = hint && hint.originalException;
            const message = (event.message || (error && error.message) || '').toString();

            // Ignore expected operational 404s when upstream content or scrapers hit missing pages
            if (error && error.statusCode === 404) {
                return null;
            }
            if (message.includes('HTTP 404 fetching')) {
                return null;
            }

            // Ignore transient port binding issues during process restart / hot-reload
            if (error && error.code === 'EADDRINUSE') {
                return null;
            }

            // Ignore normal OAuth exchange invalid_grant errors caused by cancelled/expired flows
            if (message.includes('invalid_grant')) {
                return null;
            }

            return event;
        },
    });
}

