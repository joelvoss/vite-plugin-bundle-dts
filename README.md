# vite-plugin-bundle-dts

`vite-plugin-bundle-dts` generates `.d.ts` files for Vite library builds and can optionally bundle them into a smaller public type surface.

The current implementation is aimed at TypeScript and JavaScript libraries, with built-in JSON module support. It works with single-entry and multi-entry library builds, can mirror aliases from both Vite and `tsconfig.json`, and exposes hooks for post-processing generated declaration output.

## What this plugin does

During `vite build`, the plugin:

1. Loads your TypeScript project using your `tsconfig.json`.
2. Emits declaration files for your library entry graph.
3. Rewrites declaration imports so they match your published layout.
4. Optionally creates package `types` entry shims.
5. Optionally rolls declarations into bundled entry files with API Extractor.

## Install

```bash
npm install -D vite-plugin-bundle-dts typescript
```

The plugin requires Vite `>=5`.

## Quick start

```ts
import { defineConfig } from 'vite';
import { bundleDts } from 'vite-plugin-bundle-dts';

export default defineConfig({
	build: {
		lib: {
			entry: 'src/index.ts',
			name: 'MyLibrary',
			fileName: 'index',
		},
	},
	plugins: [
		bundleDts({
			insertTypesEntry: true,
		}),
	],
});
```

With this setup, a typical build will emit declaration files into your Vite output directory, usually `dist`.

## Recommended library setup

For a conventional package, keep these files aligned:

`package.json`

```json
{
	"name": "my-library",
	"type": "module",
	"main": "./dist/index.cjs",
	"module": "./dist/index.js",
	"types": "./dist/index.d.ts"
}
```

`tsconfig.json`

```json
{
	"compilerOptions": {
		"target": "ES2020",
		"module": "ESNext",
		"moduleResolution": "Bundler",
		"declaration": true,
		"rootDir": "src",
		"baseUrl": ".",
		"paths": {
			"@/*": ["src/*"]
		}
	},
	"include": ["src"]
}
```

`vite.config.ts`

```ts
import { defineConfig } from 'vite';
import { bundleDts } from 'vite-plugin-bundle-dts';

export default defineConfig({
	resolve: {
		alias: {
			'@': new URL('./src', import.meta.url).pathname,
		},
	},
	build: {
		lib: {
			entry: 'src/index.ts',
			name: 'MyLibrary',
			fileName: 'index',
		},
	},
	plugins: [bundleDts()],
});
```

## Usage patterns

### Basic single-entry library

This is the default case. The plugin reads the Vite library entry and emits matching declarations.

```ts
import { defineConfig } from 'vite';
import { bundleDts } from 'vite-plugin-bundle-dts';

export default defineConfig({
	build: {
		lib: {
			entry: 'src/index.ts',
			name: 'MyLibrary',
			fileName: 'index',
		},
	},
	plugins: [bundleDts()],
});
```

Typical output:

```text
dist/
  index.js
  index.cjs
  index.d.ts
```

### Declaration-only builds

If you want Vite to produce declarations but drop runtime bundle assets from the final output, enable `declarationOnly`.

```ts
bundleDts({
	declarationOnly: true,
});
```

Use this when your build pipeline handles JavaScript output separately, or when you are validating declaration generation in tests.

### Multi-entry libraries

The plugin supports object-style `build.lib.entry` and emits one declaration entry per library entry.

```ts
import { defineConfig } from 'vite';
import { bundleDts } from 'vite-plugin-bundle-dts';

export default defineConfig({
	build: {
		lib: {
			entry: {
				index: 'src/index.ts',
				extra: 'src/extra.ts',
			},
			name: 'MyLibrary',
			fileName: 'index',
		},
	},
	plugins: [bundleDts()],
});
```

Typical output:

```text
dist/
  index.d.ts
  extra.d.ts
```

### JSON modules

JSON support is built in. If your public API re-exports JSON, the plugin generates a declaration file for that JSON module automatically.

Example source:

```ts
export { default as data } from './data.json';
```

Typical generated declaration:

```ts
declare const _default: {
	readonly label: 'fixture';
	readonly count: 1;
};

export default _default;
```

### Package `types` shim generation

If your package publishes types from a path that does not match the emitted declaration entry, enable `insertTypesEntry`.

For example, if your package metadata says:

```json
{
	"types": "./dist/types/entry.d.ts"
}
```

but Vite emits `dist/index.d.ts`, the plugin can generate a small shim file that re-exports the actual entry.

```ts
bundleDts({
	insertTypesEntry: true,
});
```

This is especially useful when your published package structure is opinionated but your Vite entry file name is not.

### Bundled type output with API Extractor

If you want a single rolled-up declaration file per public entry, enable `rollupTypes`.

```ts
bundleDts({
	rollupTypes: true,
});
```

This keeps your published type surface smaller and removes intermediate declaration files after bundling.

For a single-entry package, that usually means:

```text
Before rollup:
dist/index.d.ts
dist/internal-helper.d.ts

After rollup:
dist/index.d.ts
```

For multi-entry libraries, the plugin rolls up each entry separately.

### Preserve alias rewriting in declarations

The plugin rewrites declaration imports using:

- Vite `resolve.alias`
- `compilerOptions.paths` from `tsconfig.json`

Example source:

```ts
export type { User } from '@/types';
```

Generated declaration:

```ts
export type { User } from './types';
```

This avoids publishing unresolved internal aliases to consumers.

### Output to multiple directories

If you need the generated declarations copied to multiple build locations, pass an array to `outDir`.

```ts
bundleDts({
	outDir: ['dist', 'dist-types'],
});
```

The first directory is the primary output. Additional directories receive copied declaration files after the main emit finishes.

### Keep existing `.d.ts` files

If your source tree already contains hand-written declaration files and you want them copied into the build output, enable `copyDtsFiles`.

```ts
bundleDts({
	copyDtsFiles: true,
});
```

### Custom declaration resolvers

The plugin includes a built-in JSON resolver and also supports custom resolvers for other file types.

```ts
import { defineConfig } from 'vite';
import { bundleDts } from 'vite-plugin-bundle-dts';

export default defineConfig({
	plugins: [
		bundleDts({
			resolvers: [
				{
					name: 'svg',
					supports(id) {
						return id.endsWith('.svg');
					},
					transform({ id }) {
						return [
							{
								path: `${id}.d.ts`,
								content: [
									'declare const src: string;',
									'export default src;',
								].join('\n'),
							},
						];
					},
				},
			],
		}),
	],
});
```

Resolvers can either return an array of output files directly or return an object with `outputs`, `emitSkipped`, and `diagnostics`.

## Full configuration reference

### Project and output options

#### `root`

Type: `string`

Default: Vite `config.root`

Overrides the project root used for resolving paths.

#### `entryRoot`

Type: `string`

Default: inferred from `tsconfig.compilerOptions.rootDir`, otherwise from the shallowest shared source directory

Controls how emitted declaration paths are made relative before being written to `outDir`.

Use this when the plugin is computing the correct declarations but nesting them too deeply in the output.

#### `outDir`

Type: `string | string[]`

Default: Vite `build.outDir`

Sets the declaration output directory. If you pass an array, the first directory is the primary output and the remaining directories receive copies of the generated files.

```ts
bundleDts({
	outDir: ['dist', 'dist-types'],
});
```

#### `tsconfigPath`

Type: `string`

Default: auto-detected with TypeScript's config lookup

Points the plugin at a specific `tsconfig.json` file.

```ts
bundleDts({
	tsconfigPath: './tsconfig.build.json',
});
```

#### `include`

Type: `string | string[]`

Default: `include` or `files` from `tsconfig.json`, otherwise `**/*`

Overrides the files considered part of the declaration build.

```ts
bundleDts({
	include: ['src/**/*', 'types/**/*'],
});
```

#### `exclude`

Type: `string | string[]`

Default: `exclude` from `tsconfig.json`, otherwise `node_modules/**`

Excludes files from the declaration graph.

```ts
bundleDts({
	exclude: ['**/*.stories.ts', '**/*.test.ts'],
});
```

#### `compilerOptions`

Type: `ts.CompilerOptions`

Default: none

Merges additional TypeScript compiler options into the loaded config.

```ts
bundleDts({
	compilerOptions: {
		baseUrl: '.',
		paths: {
			'@/*': ['src/*'],
		},
	},
});
```

The plugin still forces declaration-oriented emit settings internally, including declaration output and `emitDeclarationOnly`.

#### `copyDtsFiles`

Type: `boolean`

Default: `false`

Copies source `.d.ts` files that already exist in your project into the final output.

#### `strictOutput`

Type: `boolean`

Default: `true`

Prevents `beforeWriteFile` from redirecting output outside the target output directory. Disable this only if you intentionally want the hook to write files elsewhere.

#### `declarationOnly`

Type: `boolean`

Default: `false`

Removes non-declaration assets from the final Vite bundle during `generateBundle`.

### Import rewriting options

#### `staticImport`

Type: `boolean`

Default: `false`

Rewrites `import("...").Type` references in generated declarations into static imports when possible.

This is useful if you plan to roll declarations with API Extractor, because static imports are more predictable during bundling.

Example:

```ts
bundleDts({
	staticImport: true,
});
```

#### `clearPureImport`

Type: `boolean`

Default: `true`

Removes side-effect-only imports such as `import "foo";` from declaration output.

Disable this if you need to preserve those imports in emitted declarations.

#### `pathsToAliases`

Type: `boolean`

Default: `true`

Converts `compilerOptions.paths` entries from `tsconfig.json` into declaration rewrite aliases.

If your project already manages these paths another way, you can turn this off.

#### `aliasesExclude`

Type: `Array<string | RegExp>`

Default: `[]`

Prevents matching aliases or import specifiers from being rewritten.

```ts
bundleDts({
	aliasesExclude: [/^react$/, 'vue'],
});
```

Use this when some aliases should remain package imports instead of being rewritten to relative paths.

### Type entry and rollup options

#### `insertTypesEntry`

Type: `boolean`

Default: `false`

Creates package type entry shims when your package metadata points at a types file that does not already exist in the emitted output.

The plugin checks common package metadata fields, including:

- `types`
- `typings`
- `exports.types`
- `exports["."].types`
- `exports["./"].types`

#### `rollupTypes`

Type: `boolean`

Default: `false`

Bundles declarations with API Extractor after emit. Intermediate declaration files are removed, and the bundled entry file is written back in place.

This is often the best option for published libraries with a curated public API.

#### `rollupConfig`

Type: `Record<string, unknown>`

Default: `{}`

Passes extra API Extractor config fields into the generated extractor config object.

Useful for customizing message reporting or other extractor behavior.

```ts
bundleDts({
	rollupTypes: true,
	rollupConfig: {
		messages: {
			extractorMessageReporting: {
				default: {
					logLevel: 'warning',
				},
			},
		},
	},
});
```

#### `rollupOptions`

Type: `Record<string, unknown>`

Default: `{}`

Passes invoke-time options to API Extractor.

This is where you can provide a `messageCallback` or other invocation flags.

#### `bundledPackages`

Type: `string[]`

Default: `[]`

Convenience option for API Extractor's `bundledPackages` setting.

This is merged into `rollupConfig` automatically.

```ts
bundleDts({
	rollupTypes: true,
	bundledPackages: ['my-internal-runtime'],
});
```

### Resolver and logging options

#### `resolvers`

Type: `DtsResolver[]`

Default: `[]` plus the built-in JSON resolver

Registers custom resolvers for non-standard file types.

Resolvers run before the normal TypeScript declaration emit path for matching files. If multiple resolvers share the same `name`, the later one wins.

#### `logLevel`

Type: `"silent" | "error" | "warn" | "info"`

Default: Vite's configured logger

Overrides the logger used for plugin messages.

### Hook options

#### `afterDiagnostic`

Type: `(diagnostics: readonly ts.Diagnostic[]) => void | Promise<void>`

Called after diagnostics are collected and logged, but before files are written.

Use this to fail builds, aggregate diagnostics, or forward them elsewhere.

#### `beforeWriteFile`

Type: `(filePath: string, content: string) => void | false | { filePath?: string; content?: string } | Promise<...>`

Called before each output file is written.

Return values:

- `undefined` to keep the file as-is
- `false` to skip writing the file
- an object to replace the output path, content, or both

Example:

```ts
bundleDts({
	beforeWriteFile(filePath, content) {
		if (filePath.endsWith('internal.d.ts')) {
			return false;
		}

		if (filePath.endsWith('index.d.ts')) {
			return {
				content: `${content}\nexport type BuildTag = \"stable\";\n`,
			};
		}
	},
});
```

#### `afterRollup`

Type: `(result: unknown) => void | Promise<void>`

Called after each API Extractor rollup completes.

This hook only runs when `rollupTypes` is enabled.

#### `afterBuild`

Type: `(emittedFiles: ReadonlyMap<string, string>) => void | Promise<void>`

Called after the main declaration build finishes.

The `Map` contains files emitted for the primary output directory. Secondary `outDir` copies are not added to that map.

## Resolver API

Custom resolvers receive this context:

```ts
interface DtsResolverContext {
	id: string;
	code: string;
	root: string;
	outDir: string;
	host: ts.CompilerHost;
	program: ts.Program;
}
```

They can return either:

```ts
type DtsOutputFile = {
	path: string;
	content: string;
};

type DtsResolverReturn =
	| DtsOutputFile[]
	| {
			outputs: DtsOutputFile[];
			emitSkipped?: boolean;
			diagnostics?: readonly ts.Diagnostic[];
	  };
```

Paths returned by a resolver should point to the declaration file location you want under the active output directory.

## Notes and caveats

- This plugin is designed for Vite library builds, not general app builds.
- The built-in JSON resolver is always enabled unless you replace it with another resolver using the same `name`.
- In watch mode, the plugin rebuilds declarations when source files or resolver-backed assets change.
- `rollupTypes` is best used after import rewriting has already normalized the declaration graph.
- If `insertTypesEntry` or `rollupTypes` is enabled, the plugin will inspect `package.json` to determine your public type entry.

## Example setups

### Minimal published library

```ts
bundleDts();
```

### Package with a custom `types` path

```ts
bundleDts({
	insertTypesEntry: true,
});
```

### Curated public API with bundled declarations

```ts
bundleDts({
	insertTypesEntry: true,
	rollupTypes: true,
	staticImport: true,
});
```

### Advanced build with hooks and extra output copies

```ts
bundleDts({
	outDir: ['dist', 'dist-types'],
	copyDtsFiles: true,
	beforeWriteFile(filePath, content) {
		if (filePath.endsWith('internal.d.ts')) {
			return false;
		}

		return {
			content,
		};
	},
});
```

## Development

```bash
./Taskfile.sh help
```
