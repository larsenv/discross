'use strict';
const { render } = require('./utils');

/**
 * Discord lays out several images as a mosaic whose shape depends on how many
 * there are. Each entry lists the number of tiles per row; three images are
 * the exception (one large tile beside two stacked ones) and are built
 * separately below.
 */
const MOSAIC_ROWS = {
    2: [2],
    4: [2, 2],
    5: [2, 3],
    6: [3, 3],
    7: [1, 3, 3],
    8: [2, 3, 3],
    9: [3, 3, 3],
    10: [1, 3, 3, 3],
};

/**
 * Tile height as a percentage of its width. A lone full-width tile is about
 * twice as wide as it is tall, the 2x2 grid uses shorter tiles, and every
 * other tile is square.
 */
function tileAspect(perRow, count) {
    if (perRow === 1) return 50;
    if (perRow === 2 && count === 4) return 62.5;
    return 100;
}

function mosaicTile(content, aspect, attrs = '') {
    return render('channel/mosaic-cell', {
        ATTRS: attrs,
        ASPECT: String(aspect),
        CONTENT: content,
    });
}

/**
 * Renders the HTML for one image tile, blurred behind a click-to-reveal
 * overlay when it is a spoiler.
 * @param {string} url - Proxied image URL (already safe for an attribute)
 * @param {boolean} [isSpoiler]
 */
function mosaicImage(url, isSpoiler = false) {
    return render(isSpoiler ? 'channel/mosaic-spoiler' : 'channel/mosaic-image', {
        IMAGE_URL: url,
    });
}

/**
 * Arranges image tiles the way Discord's client does. Rows are separate
 * fixed-layout tables (each with its own column count) and tiles keep their
 * shape with the padding-top aspect-ratio trick, so the layout holds on old
 * browsers without flexbox or grid.
 * @param {string[]} tiles - Inner HTML of each tile (from mosaicImage)
 * @returns {string}
 */
function renderMosaic(tiles) {
    const list = tiles.slice(0, 10);
    const count = list.length;
    if (count === 0) return '';

    let rows = '';
    if (count === 1) {
        rows = render('channel/mosaic-row', { CELLS: mosaicTile(list[0], 100) });
    } else if (count === 3) {
        rows = render('channel/mosaic-row-3', {
            LARGE: mosaicTile(list[0], 100, ' rowspan="2" width="66%"'),
            TOP: mosaicTile(list[1], 100),
            BOTTOM: mosaicTile(list[2], 100),
        });
    } else {
        let index = 0;
        for (const perRow of MOSAIC_ROWS[count]) {
            const cells = list
                .slice(index, index + perRow)
                .map((tile) => mosaicTile(tile, tileAspect(perRow, count)))
                .join('');
            rows += render('channel/mosaic-row', { CELLS: cells });
            index += perRow;
        }
    }

    return render('channel/mosaic', { COUNT: String(count), ROWS: rows });
}

module.exports = { renderMosaic, mosaicImage };
