import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            'db/**',
            'pages/static/js/emojiList.js',
            'pages/static/js/emojiKeywords.js',
        ],
    },
    {
        files: ['**/*.ts'],
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        languageOptions: {
            globals: globals.node,
            sourceType: 'commonjs',
        },
        rules: {
            // The server is CommonJS throughout and loads modules lazily on purpose.
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' },
            ],
            'no-empty': ['error', { allowEmptyCatch: true }],
            // Older modules use function-scoped `var` deliberately; converting
            // them wholesale risks hoisting changes for no runtime benefit.
            'no-var': 'off',
            // `let html = ''` followed by branch assignments is the house style.
            'no-useless-assignment': 'off',
        },
    },
    {
        // Client scripts run on legacy pre-ES5 browsers (Wii, DSi, PSP), so they
        // are plain browser globals with `var` and no modules.
        files: ['pages/static/**/*.js'],
        extends: [js.configs.recommended],
        languageOptions: {
            ecmaVersion: 5,
            sourceType: 'script',
            // Typed arrays are feature-detected before use.
            globals: { ...globals.browser, Uint32Array: 'readonly' },
        },
        rules: {
            'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    }
);
