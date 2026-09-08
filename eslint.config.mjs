/**
 * ESLint configuration for the project.
 *
 * See https://eslint.style and https://typescript-eslint.io for additional linting options.
 */
// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

export default tseslint.config(
	{
		ignores: [
			// Match at any depth: the downloaded VS Code lives at both ./.vscode-test
			// and ./e2e/.vscode-test (hundreds of MB of JS) — a bare '.vscode-test'
			// only matches the root copy, so eslint walks the nested one and OOMs.
			'**/.vscode-test/**',
			'out',
			'**/*.d.ts'
		]
	},
	{
		files: ['**/*.{js,mjs,cjs,ts,jsx,tsx}'],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	...tseslint.configs.stylistic,
	{
		plugins: {
			'@stylistic': stylistic
		},
		rules: {
			'curly': 'warn',
			'@stylistic/semi': ['warn', 'always'],
			'@typescript-eslint/no-empty-function': 'off',
			'@typescript-eslint/array-type': 'off',
			'@typescript-eslint/naming-convention': [
				'warn',
				{
					'selector': 'import',
					'format': ['camelCase', 'PascalCase']
				}
			],
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					'argsIgnorePattern': '^_'
				}
			]
		}
	},
	{
		// Standalone CommonJS Node scripts, not part of the extension bundle. They
		// legitimately use require(), console and process, none of which exist in
		// the default (browser-ish) globals the TS config assumes.
		files: ['scripts/**/*.js'],
		languageOptions: {
			globals: globals.node,
			sourceType: 'commonjs'
		},
		rules: {
			'@typescript-eslint/no-require-imports': 'off'
		}
	}
);