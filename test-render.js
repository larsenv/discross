const { renderTemplate, getTemplate } = require('./pages/utils.js');
const auth = require('./src/authentication.js');

const index_template = require('./pages/utils.js').loadAndRenderPageTemplate('index');
const response = renderTemplate(index_template, {
    MENU_OPTIONS: 'menu',
    WHITE_THEME_ENABLED: '',
    PAGE_TITLE: 'Discross - Use Discord Anywhere',
    SEO_METADATA: '<meta property="og:title" content="Discross - Use Discord Anywhere" />',
});

if (response.includes('<meta property="og:title"')) {
    console.log("SUCCESS: SEO_METADATA is preserved.");
} else {
    console.log("FAIL: SEO_METADATA is missing!");
}

if (response.includes('<title>Discross - Use Discord Anywhere</title>')) {
    console.log("SUCCESS: PAGE_TITLE is preserved.");
} else {
    console.log("FAIL: PAGE_TITLE is missing!");
}
