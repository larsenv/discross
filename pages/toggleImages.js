'use strict';
const { parseCookies } = require('./utils.js');

exports.toggleImages = function toggleImages(req, res) {
    try {
        const parsedUrl = new URL(req.url, 'http://localhost');
        const urlImages = parsedUrl.searchParams.get('images');
        const { images: imagesCookie } = parseCookies(req);

        // URL param takes priority over cookie for determining current images state
        // Validate URL param is a valid images value (0 or 1)
        const rawImages = urlImages !== null ? parseInt(urlImages, 10) : null;
        const parsedUrlImages =
            rawImages !== null && !isNaN(rawImages) && (rawImages === 0 || rawImages === 1)
                ? rawImages
                : null;
        const currentValue =
            parsedUrlImages !== null
                ? parsedUrlImages
                : imagesCookie !== undefined
                  ? parseInt(imagesCookie, 10)
                  : 1;
        const newValue = currentValue === 1 ? 0 : 1;

        const referer = req.headers.referer || '/server/';
        const refererUrl = new URL(referer, 'http://dummy.local');
        refererUrl.searchParams.set('images', newValue);
        const location = refererUrl.pathname + refererUrl.search;

        res.writeHead(302, {
            'Set-Cookie': [`images=${newValue}; path=/`],
            'Content-Type': 'text/html',
            Location: location,
        });
        res.end();
    } catch (error) {
        res.writeHead(302, { Location: '/server/' });
        res.end();
    }
};
