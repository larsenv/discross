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

            // Ignore transient third-party upload provider (x0.at) 502 errors
            if (message.includes('Upload failed with status 502') || message.includes('Error uploading to x0.at')) {
                return null;
            }

            // Ignore expected Discord API rate limit responses
            if (
                message.includes('rate limited') ||
                message.includes('limitate') ||
                (error && error.status === 429) ||
                (error && error.code === 20028)
            ) {
                return null;
            }

            // Ignore transient Discord connection timeouts
            if (
                (error && error.name === 'ConnectTimeoutError') ||
                message.includes('Connect Timeout Error') ||
                message.includes('getaddrinfo EAI_AGAIN discord.com')
            ) {
                return null;
            }

            return event;
        },
    });
}

