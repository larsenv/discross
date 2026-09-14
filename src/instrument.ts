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

            // Ignore upstream 403 or timeouts when scraping external news (AP News)
            if (
                message.includes('apnews.com') ||
                message.includes('HTTP 403 fetching') ||
                (error && error.statusCode === 403)
            ) {
                return null;
            }

            // Ignore revoked or invalid user Discord OAuth tokens (user deauthorized or invalid)
            if (
                message.includes('401: Unauthorized') ||
                (error && error.message && error.message.includes('401: Unauthorized'))
            ) {
                return null;
            }

            // Ignore empty message submission errors from Discord API
            if (
                (error && error.code === 50006) ||
                message.includes('50006') ||
                message.includes('Cannot send an empty message')
            ) {
                return null;
            }

            // Ignore expired Discord interaction errors
            if (
                (error && (error.code === 10062 || error.code === 40060)) ||
                message.includes('10062') ||
                message.includes('Unknown interaction')
            ) {
                return null;
            }

            // Ignore Resend send-only API key permission errors on inbound webhook polling
            if (
                message.includes('restricted to only send emails') ||
                message.includes('Failed to retrieve received email from Resend API') ||
                message.includes('[Resend API Error]')
            ) {
                return null;
            }

            return event;
        },
    });
}

