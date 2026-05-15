const fs = require('fs');
const path = require('path');

const gemoji = JSON.parse(fs.readFileSync('/tmp/emoji.json'));
const twemojiDir = 'pages/static/resources/twemoji/';
const files = fs.readdirSync(twemojiDir).filter(f => f.endsWith('.gif'));

const categorized = {};

const MANUAL_DATA = {
    '1f426-200d-1f525': { name: 'phoenix', cat: 'Animals & Nature' },
    '1f34b-200d-1f7e9': { name: 'lime', cat: 'Food & Drink' },
    '1f344-200d-1f7e8': { name: 'brown_mushroom', cat: 'Food & Drink' },
    '1f642-200d-2195-fe0f': { name: 'head_shaking_vertically', cat: 'Smileys & Emotion' },
    '1f642-200d-2194-fe0f': { name: 'head_shaking_horizontally', cat: 'Smileys & Emotion' },
    '1f517-200d-1f4a5': { name: 'broken_chain', cat: 'Objects' },
    '1f9d1-200d-1f9d1-200d-1f9d2': { name: 'family_adult_adult_child', cat: 'People & Body' },
    '1f9d1-200d-1f9d2-200d-1f9d2': { name: 'family_adult_child_child', cat: 'People & Body' },
    '1f9d1-200d-1f9d1-200d-1f9d2-200d-1f9d2': { name: 'family_adult_adult_child_child', cat: 'People & Body' },
    '1f9d1-200d-1f9d2': { name: 'family_adult_child', cat: 'People & Body' },
    // Directional variants
    '1f6b6-200d-27a1-fe0f': { name: 'person_walking_facing_right', cat: 'People & Body' },
    '1f6b6-200d-2640-fe0f-200d-27a1-fe0f': { name: 'woman_walking_facing_right', cat: 'People & Body' },
    '1f6b6-200d-2642-fe0f-200d-27a1-fe0f': { name: 'man_walking_facing_right', cat: 'People & Body' },
    '1f3c3-200d-27a1-fe0f': { name: 'person_running_facing_right', cat: 'People & Body' },
    '1f3c3-200d-2640-fe0f-200d-27a1-fe0f': { name: 'woman_running_facing_right', cat: 'People & Body' },
    '1f3c3-200d-2642-fe0f-200d-27a1-fe0f': { name: 'man_running_facing_right', cat: 'People & Body' },
    '1f9ce-200d-27a1-fe0f': { name: 'person_kneeling_facing_right', cat: 'People & Body' },
    '1f9ce-200d-2640-fe0f-200d-27a1-fe0f': { name: 'woman_kneeling_facing_right', cat: 'People & Body' },
    '1f9ce-200d-2642-fe0f-200d-27a1-fe0f': { name: 'man_kneeling_facing_right', cat: 'People & Body' },
    '1f9d1-200d-1f9af-200d-27a1-fe0f': { name: 'person_with_probing_cane_facing_right', cat: 'People & Body' },
    '1f9d1-200d-2640-fe0f-200d-1f9af-200d-27a1-fe0f': { name: 'woman_with_probing_cane_facing_right', cat: 'People & Body' },
    '1f9d1-200d-2642-fe0f-200d-1f9af-200d-27a1-fe0f': { name: 'man_with_probing_cane_facing_right', cat: 'People & Body' },
    '1f9d1-200d-1f9bc-200d-27a1-fe0f': { name: 'person_in_manual_wheelchair_facing_right', cat: 'People & Body' },
    '1f9d1-200d-2640-fe0f-200d-1f9bc-200d-27a1-fe0f': { name: 'woman_in_manual_wheelchair_facing_right', cat: 'People & Body' },
    '1f9d1-200d-2642-fe0f-200d-1f9bc-200d-27a1-fe0f': { name: 'man_in_manual_wheelchair_facing_right', cat: 'People & Body' },
    '1f9d1-200d-1f9bd-200d-27a1-fe0f': { name: 'person_in_motorized_wheelchair_facing_right', cat: 'People & Body' },
    '1f9d1-200d-2640-fe0f-200d-1f9bd-200d-27a1-fe0f': { name: 'woman_in_motorized_wheelchair_facing_right', cat: 'People & Body' },
    '1f9d1-200d-2642-fe0f-200d-1f9bd-200d-27a1-fe0f': { name: 'man_in_motorized_wheelchair_facing_right', cat: 'People & Body' },
};

// Helper to check if a file exists
const fileExists = (f) => fs.existsSync(path.join(twemojiDir, f));

// First pass: identify skin-toneable base emojis
const supportsSkinTone = new Set();
for (const file of files) {
    if (file.includes('-1f3fb.gif')) {
        // e.g. "1f44f-1f3fb.gif" -> base is "1f44f.gif"
        // or ZWJ: "1f9d1-1f3fb-200d-1f91d-200d-1f9d1-1f3fb.gif" -> base is "1f9d1-200d-1f91d-200d-1f9d1.gif"
        const base = file.replace(/-1f3fb/g, '');
        if (fileExists(base)) {
            supportsSkinTone.add(base);
        }
    }
}

// Map files to categories, excluding variants
for (const file of files) {
    // Skip variants (any file containing skin tone codepoints)
    if (file.includes('-1f3fb') || file.includes('-1f3fc') || file.includes('-1f3fd') || file.includes('-1f3fe') || file.includes('-1f3ff')) {
        continue;
    }
    
    const code = file; // e.g. "1f600.gif"
    const hex = file.replace('.gif', '');
    
    // Try to find name from gemoji
    const g = gemoji.find(item => {
        try {
            return item.emoji === String.fromCodePoint(...hex.split('-').map(h => parseInt(h, 16)));
        } catch (e) {
            return false;
        }
    });

    let name = hex;
    let cat = "Objects"; // Default

    if (MANUAL_DATA[hex]) {
        name = MANUAL_DATA[hex].name;
        cat = MANUAL_DATA[hex].cat;
    } else if (g) {
        name = (g.aliases && g.aliases.length > 0) ? g.aliases[0] : g.description.replace(/ /g, '_').toLowerCase();
        cat = g.category;
    }

    if (!categorized[cat]) categorized[cat] = [];
    
    const emojiObj = { code, name };
    if (supportsSkinTone.has(file)) {
        emojiObj.sk = true; // supports skin tone
    }
    
    categorized[cat].push(emojiObj);
}

// Sort categories
const desiredOrder = [
    "Smileys & Emotion", 
    "People & Body", 
    "Animals & Nature", 
    "Food & Drink", 
    "Travel & Places", 
    "Activities", 
    "Objects", 
    "Symbols", 
    "Flags"
];

const finalCategories = {};
for (const cat of desiredOrder) {
    if (categorized[cat]) finalCategories[cat] = categorized[cat];
}
// Catch any others
for (const cat in categorized) {
    if (!finalCategories[cat]) finalCategories[cat] = categorized[cat];
}

fs.writeFileSync('pages/static/js/emojiList.js', 'window.EMOJI_CATEGORIES = ' + JSON.stringify(finalCategories) + ';');
console.log('Categories built from files. Variants excluded, sk flag added.');
