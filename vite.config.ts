import { builtinModules } from 'node:module';
import { resolve, parse, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import packageJson from './package.json';
import bundleDts from './src';

////////////////////////////////////////////////////////////////////////////////

const __dirname = dirname(fileURLToPath(import.meta.url));

const externalPackages = [
	'@microsoft/api-extractor',
	'magic-string',
	'typescript',
	'vite',
];

const external = new Set([
	...builtinModules,
	...builtinModules.map((moduleName) => `node:${moduleName}`),
	...externalPackages,
]);

////////////////////////////////////////////////////////////////////////////////

export default defineConfig({
	plugins: [
		bundleDts({ rollupTypes: true, insertTypesEntry: true, logLevel: 'error' }),
	],
	build: {
		// NOTE(joel): Don't minify, because every consumer will minify themselves
		// anyway. We're only bundling for the sake of publishing to npm.
		minify: false,
		lib: {
			entry: resolve(__dirname, packageJson.source),
			formats: ['cjs', 'es'],
			fileName: parse(packageJson.module).name,
		},
		rollupOptions: {
			external: (id) => {
				if (id.startsWith('node:')) return true;
				return external.has(id);
			},
			output: { exports: 'named' },
		},
	},
});
