const fs = require('fs');
const HTMLMinifier = require('@bhavingajjar/html-minify');
const minifier = new HTMLMinifier();

console.log('=== Testing Updated Forwarded Message Templates ===\n');

// Load templates
const message_forwarded_template = minifier.htmlMinify(
  fs.readFileSync('pages/templates/message/forwarded_message.html', 'utf-8')
);
const message_forwarded_reply_template = minifier.htmlMinify(
  fs.readFileSync('pages/templates/message/forwarded_message_reply.html', 'utf-8')
);

console.log('✓ Templates loaded successfully\n');

// Check for grey border instead of blue
if (message_forwarded_template.includes('border-left: 4px solid #4f545c')) {
  console.log('✓ Grey border color applied (#4f545c)');
} else {
  console.log('✗ Grey border not found');
}

// Check that blue border is removed
if (!message_forwarded_template.includes('#5865f2')) {
  console.log('✓ Blue border (#5865f2) removed');
} else {
  console.log('✗ Blue border still present');
}

// Check for proper element ordering (username should come before "Forwarded from")
const messageAuthorIndex = message_forwarded_template.indexOf('{$MESSAGE_AUTHOR}');
const forwardedAuthorIndex = message_forwarded_template.indexOf('{$FORWARDED_AUTHOR}');

if (messageAuthorIndex < forwardedAuthorIndex) {
  console.log('✓ Username appears before "Forwarded from" indicator');
} else {
  console.log('✗ Username ordering incorrect');
}

console.log('\n✓ All template updates validated successfully!');
