'use strict';
(function () {
    var quickNames = [
        'sob',
        'skull',
        'pleading_face',
        'heart',
        'joy',
        'fire',
        'white_check_mark',
        'eyes',
    ];

    function getSkinToneIndex(hex) {
        var mapping = {
            '1f3fb': '1',
            '1f3fc': '2',
            '1f3fd': '3',
            '1f3fe': '4',
            '1f3ff': '5',
        };
        return mapping[hex] || '';
    }

    function createEmojiElement(emoji, isCustom, animated) {
        // Server emojis use .id, Twemoji use .code
        var code = isCustom ? emoji.id : typeof emoji === 'string' ? emoji : emoji.code;
        var name = typeof emoji === 'string' ? '' : emoji.name;
        var supportsSkinTone = typeof emoji === 'object' && emoji.sk;

        var finalCode = code;
        var activeTone = '';
        if (!isCustom && supportsSkinTone && window.EMOJI_SKIN_TONE) {
            var toneHex = window.EMOJI_SKIN_TONE;
            activeTone = toneHex;
            if (code.indexOf('-200d') !== -1) {
                // Multi-person or complex ZWJ emojis: apply tone to all "person" components
                // Common person base codepoints: 1f468 (man), 1f469 (woman), 1f9d1 (person), 1f466 (boy), 1f467 (girl), 1f6b6 (walking), 1f3c3 (running), 1f9ce (kneeling)
                finalCode = code.replace(
                    /(1f468|1f469|1f9d1|1f466|1f467|1f6b6|1f3c3|1f9ce)(?=[-.]|$)/g,
                    '$1-' + toneHex
                );
            } else {
                finalCode = code.replace('.gif', '-' + toneHex + '.gif');
            }
        }

        var a = document.createElement('a');
        a.href = 'javascript:void(0)';
        a.title = ':' + name + ':';
        a.style.display = 'inline-block';
        a.style.background = 'none';
        a.style.cursor = 'pointer';
        a.style.padding = '8px';
        a.style.borderRadius = '4px';
        a.style.textDecoration = 'none';

        if (typeof setHoverBg === 'function') {
            a.onmouseover = function () {
                setHoverBg(this);
            };
            a.onmouseout = function () {
                clearBg(this);
            };
        } else {
            a.onmouseover = function () {
                this.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
            };
            a.onmouseout = function () {
                this.style.backgroundColor = 'transparent';
            };
        }

        a.onclick = function () {
            if (typeof insertEmoji === 'function') {
                if (isCustom) {
                    insertEmoji('<' + (animated ? 'a' : '') + ':' + name + ':' + code + '>');
                } else {
                    var skinToneIdx = getSkinToneIndex(activeTone);
                    var suffix = skinToneIdx ? ':skin-tone-' + skinToneIdx + ':' : '';
                    insertEmoji(':' + name + ':' + suffix);
                }
            }
            var details = document.getElementById('emoji-details');
            if (details) details.removeAttribute('open');
            return false;
        };

        var img = document.createElement('img');
        if (isCustom) {
            img.src =
                'https://cdn.discordapp.com/emojis/' +
                code +
                (animated ? '.gif' : '.png') +
                '?size=48';
        } else {
            img.src = '/resources/twemoji/' + finalCode;
        }

        img.alt = name;
        img.width = 24;
        img.height = 24;
        // loading=lazy is ignored by old browsers, which is fine
        try {
            img.setAttribute('loading', 'lazy');
        } catch (e) {}

        img.style.width = '24px';
        img.style.height = '24px';

        a.appendChild(img);
        return a;
    }

    function renderCategories() {
        var container = document.getElementById('emoji-container');
        if (!container || !window.EMOJI_CATEGORIES) return;

        container.innerHTML = '';

        // 1. Server Emojis
        if (window.SERVER_EMOJIS && window.SERVER_EMOJIS.length > 0) {
            var h3 = document.createElement('h3');
            h3.innerHTML = 'Server Emojis';
            h3.style.margin = '8px 4px 4px 4px';
            h3.style.color = '#8e9297';
            h3.style.fontSize = '12px';
            h3.style.textTransform = 'uppercase';
            container.appendChild(h3);

            var div = document.createElement('div');
            div.style.display = 'block'; // Use block for extreme legacy, or inline-block

            for (var i = 0; i < window.SERVER_EMOJIS.length; i++) {
                var e = window.SERVER_EMOJIS[i];
                div.appendChild(createEmojiElement(e, true, e.animated));
            }
            container.appendChild(div);
        }

        // 2. Standard Categories
        for (var catName in window.EMOJI_CATEGORIES) {
            if (!Object.prototype.hasOwnProperty.call(window.EMOJI_CATEGORIES, catName)) continue;

            var h3 = document.createElement('h3');
            h3.innerHTML = catName;
            h3.style.margin = '12px 4px 4px 4px';
            h3.style.color = '#8e9297';
            h3.style.fontSize = '12px';
            h3.style.textTransform = 'uppercase';
            container.appendChild(h3);

            var div = document.createElement('div');
            div.style.display = 'block';

            var cat = window.EMOJI_CATEGORIES[catName];
            for (var j = 0; j < cat.length; j++) {
                div.appendChild(createEmojiElement(cat[j], false));
            }
            container.appendChild(div);
        }
    }

    function renderQuickPicker() {
        var quickPicker = document.getElementById('emoji-quick-picker');
        if (!quickPicker || !window.EMOJI_CATEGORIES) return;

        quickPicker.innerHTML = '';

        // Find the quick emojis in the categories
        var quickEmojis = [];
        for (var cat in window.EMOJI_CATEGORIES) {
            if (!Object.prototype.hasOwnProperty.call(window.EMOJI_CATEGORIES, cat)) continue;
            var list = window.EMOJI_CATEGORIES[cat];
            for (var i = 0; i < list.length; i++) {
                var e = list[i];
                for (var j = 0; j < quickNames.length; j++) {
                    if (e.name === quickNames[j]) {
                        quickEmojis.push(e);
                        break;
                    }
                }
            }
        }

        // Remove duplicates and respect order
        var sortedQuick = [];
        for (var k = 0; k < quickNames.length; k++) {
            var name = quickNames[k];
            var found = null;
            for (var m = 0; m < quickEmojis.length; m++) {
                if (quickEmojis[m].name === name) {
                    found = quickEmojis[m];
                    break;
                }
            }
            if (found) sortedQuick.push(found);
        }

        for (var n = 0; n < sortedQuick.length; n++) {
            var div = document.createElement('div');
            div.className = 'emoji-quick-item';
            div.style.display = 'inline-block';
            div.appendChild(createEmojiElement(sortedQuick[n], false));
            quickPicker.appendChild(div);
        }
    }

    // Initialize when template is loaded/shown
    window.initEmojiPicker = function () {
        renderQuickPicker();
        renderCategories();
    };

    // Auto-init if categories are already there
    if (window.EMOJI_CATEGORIES) {
        window.initEmojiPicker();
    }
})();
