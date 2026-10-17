'use strict';

/**
 * Discord picks an attachment's icon from its file extension. The icons live
 * in /resources/images/files/<type>.png (rasterised from Discord's own SVGs so
 * that legacy browsers without SVG support can show them).
 */
const FILE_ICON_EXTENSIONS = {
    image: 'png jpg jpeg jfif pjpeg pjp gif webp avif apng bmp ico cur tif tiff svg heic heif',
    video: 'mp4 m4v mov qt webm mkv avi wmv flv f4v mpg mpeg mpe ogv 3gp 3g2 ts mts m2ts vob',
    audio: 'mp3 wav wave ogg oga opus flac m4a aac weba wma aiff aif aifc mid midi amr',
    archive: 'zip rar 7z tar gz tgz bz2 tbz2 xz txz zst lz lzma cab iso dmg jar apk ipa deb rpm',
    pdf: 'pdf',
    psd: 'psd psb',
    ai: 'ai eps',
    sheet: 'xls xlsx xlsm xlsb xlt xltx csv tsv ods numbers',
    text: 'txt text md markdown rtf doc docx dot dotx odt pages log tex nfo',
    code:
        'js jsx mjs cjs ts tsx json json5 html htm xhtml css scss sass less xml yml yaml toml ini ' +
        'cfg conf env py pyw rb php java kt kts swift c h cpp cc cxx hpp hh cs go rs lua sh bash ' +
        'zsh fish bat cmd ps1 psm1 sql pl pm r dart vue svelte scala sc hs ex exs erl clj cljs ' +
        'm mm asm s gradle groovy cmake makefile mk dockerfile diff patch coffee elm fs fsx ' +
        'vb vbs nim zig v jl graphql gql proto',
};

const EXTENSION_TO_ICON = new Map();
for (const [type, list] of Object.entries(FILE_ICON_EXTENSIONS)) {
    for (const ext of list.split(' ')) EXTENSION_TO_ICON.set(ext, type);
}

/**
 * @param {string} fileName
 * @returns {string} Icon name (image, video, audio, archive, pdf, psd, ai,
 *   sheet, text, code or misc)
 */
function fileIconType(fileName) {
    const name = String(fileName || '').toLowerCase();
    const dot = name.lastIndexOf('.');
    const ext = dot === -1 ? name : name.slice(dot + 1);
    return EXTENSION_TO_ICON.get(ext) || 'misc';
}

module.exports = { fileIconType };
