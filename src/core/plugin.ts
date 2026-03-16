import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, basename, relative } from 'node:path';

import ts from 'typescript';
import {
	createLogger,
	type Logger,
	type Plugin,
	type ResolvedConfig,
} from 'vite';

import { createJsonResolver } from '../resolvers/json';
import type { DtsPluginOptions, DtsResolver, PathAlias } from '../types';
import { hasExportDefault, hasNormalExport } from '../utils/ast';
import {
	ensureAbsolute,
	ensureArray,
	isNativeObject,
	normalizePath,
	runParallel,
	unwrapPromise,
	resolvePath,
} from '../utils/common';
import { createFilter } from '../utils/filter';
import {
	extPrefix,
	findTypesPath,
	fullRelativeRE,
	normalizeGlob,
	parseTsAliases,
	queryPublicPath,
	removeDirIfEmpty,
	toCapitalCase,
	toEntryMap,
	tsToDts,
	tryGetPkgPath,
} from '../utils/path';
import { editSourceMapDir } from '../utils/source-map';
import {
	getTsConfig,
	loadTsConfig,
	resolveConfigDir,
	setModuleResolution,
} from '../utils/tsconfig';
import { getTsLibFolder, rollupDeclarationFiles } from './rollup';
import { transformDeclarationContent } from './transform';

////////////////////////////////////////////////////////////////////////////////

const tjsRE = /\.(m|c)?(t|j)sx?$/;
const jsRE = /\.(m|c)?jsx?$/;
const dtsRE = /\.d\.(m|c)?tsx?$/;
const defaultIndex = 'index.d.ts';
const pluginName = 'vite-plugin-bundle-dts';
const logPrefix = `[${pluginName}]`;
const noop = () => {};

// These options intentionally override whatever comes from tsconfig because the
// plugin only exists to produce declaration output.
const fixedCompilerOptions: ts.CompilerOptions = {
	noEmit: false,
	declaration: true,
	emitDeclarationOnly: true,
	checkJs: false,
	skipLibCheck: true,
	preserveSymlinks: false,
	noEmitOnError: undefined,
	target: ts.ScriptTarget.ESNext,
};

////////////////////////////////////////////////////////////////////////////////

/**
 * Parse resolvers from plugin options while ensuring that later entries with
 * the same name override earlier ones, and assign stable names to anonymous
 * resolvers so they can be overridden by later options without accidentally
 * registering duplicates.
 */
function parseResolvers(resolvers: DtsResolver[]): DtsResolver[] {
	const nameMap = new Map<string, DtsResolver>();
	for (const resolver of resolvers) {
		// Resolver names act as stable identities so later options cannot
		// accidentally register the same built-in twice and get duplicate output
		// files.
		if (resolver.name) {
			nameMap.set(resolver.name, resolver);
			continue;
		}
		nameMap.set(`anonymous:${nameMap.size}`, resolver);
	}
	return Array.from(nameMap.values());
}

////////////////////////////////////////////////////////////////////////////////

/**
 * Maybe emit a source file depending on compiler options. This is used to
 * determine which files are considered part of the declaration graph and
 * should be watched for changes, which is important for rollup and custom
 * resolvers that need to process the entire graph at once instead of relying
 * on Vite's transform hook.
 */
function maybeEmitSourceFile(
	program: ts.Program,
	compilerOptions: ts.CompilerOptions,
	sourceFile: ts.SourceFile,
): boolean {
	return !(
		(compilerOptions.noEmitForJsFiles && jsRE.test(sourceFile.fileName)) ||
		sourceFile.isDeclarationFile ||
		program.isSourceFileFromExternalLibrary(sourceFile)
	);
}

////////////////////////////////////////////////////////////////////////////////

/**
 * The main plugin function. The returned object implements the Vite plugin
 * interface and hooks into the build lifecycle to generate, transform, and emit
 * declaration files based on the provided options and resolvers. The plugin
 * manages internal state across hooks to track the declaration graph and ensure
 * that all relevant files are processed and emitted correctly, even in watch
 * mode with incremental changes.
 */
export function dtsPlugin(options: DtsPluginOptions = {}): Plugin {
	const {
		tsconfigPath,
		logLevel,
		staticImport = false,
		clearPureImport = true,
		insertTypesEntry = false,
		rollupTypes = false,
		pathsToAliases = true,
		aliasesExclude = [],
		rollupOptions = {},
		copyDtsFiles = false,
		declarationOnly = false,
		strictOutput = true,
		afterDiagnostic = noop,
		beforeWriteFile = noop,
		afterRollup = noop,
		afterBuild = noop,
	} = options;

	// These variables are populated incrementally across Vite's hook lifecycle
	// and then reused during writeBundle and watch rebuilds.
	let root = ensureAbsolute(options.root, process.cwd());
	let publicRoot = '';
	let entryRoot = options.entryRoot ?? '';
	let configPath: string | undefined;
	let compilerOptions: ts.CompilerOptions | undefined;
	let rawCompilerOptions: Record<string, unknown> = {};
	let outDirs: string[] | undefined;
	let entries: Record<string, string> | undefined;
	let include: string[] = [];
	let exclude: string[] = [];
	let aliases: PathAlias[] = [];
	let libName = '_default';
	let indexName = defaultIndex;
	let logger: Logger | Console = console;
	let host: ts.CompilerHost | undefined;
	let program: ts.Program | undefined;
	let filter: ReturnType<typeof createFilter> | undefined;
	let rootNames: string[] = [];
	let rebuildProgram: (() => ts.Program) | undefined;
	let bundled = false;
	let timeRecord = 0;
	let viteConfig: ResolvedConfig | undefined;

	// Built-ins are always registered first so callers can extend behavior
	// without having to remember to re-add the default JSON support.
	const resolvers = parseResolvers([
		createJsonResolver(),
		...(options.resolvers ?? []),
	]);
	// These collections track the declaration graph across the build lifecycle.
	const rootFiles = new Set<string>();
	const outputFiles = new Map<string, string>();
	const transformedFiles = new Set<string>();
	const diagnostics: ts.Diagnostic[] = [];
	const rollupConfig = {
		...options.rollupConfig,
		bundledPackages:
			(options.rollupConfig?.bundledPackages as string[] | undefined) ??
			options.bundledPackages ??
			[],
	};

	function setOutputFile(filePath: string, content: string): void {
		outputFiles.set(filePath, content);
	}

	function parseViteAliases(aliasOptions: unknown): void {
		// Vite accepts aliases either as an object map or as explicit finder
		// entries. Normalize both into one internal shape before later path
		// rewriting.
		if (isNativeObject(aliasOptions)) {
			aliases = Object.entries(aliasOptions).map(([find, replacement]) => ({
				find,
				replacement: resolvePath(String(replacement)),
			}));
			return;
		}

		aliases = ensureArray(aliasOptions as PathAlias[]).map((alias) => ({
			...alias,
			replacement: resolvePath(alias.replacement),
		}));
	}

	return {
		name: pluginName,
		apply: 'build',
		enforce: 'pre',
		config(config) {
			// Capture aliases early so declaration rewriting can mirror runtime
			// imports.
			parseViteAliases(config.resolve?.alias ?? []);

			if (aliasesExclude.length > 0) {
				aliases = aliases.filter(
					({ find }) =>
						!aliasesExclude.some((entry) => {
							if (entry instanceof RegExp && find instanceof RegExp) {
								return entry.toString() === find.toString();
							}
							if (entry instanceof RegExp) {
								return typeof find === 'string' && entry.test(find);
							}
							return find === entry;
						}),
				);
			}
		},
		configResolved(config) {
			// Once Vite resolves the full config we can lock in output directories,
			// entry names, and the logger instance that should be used for
			// diagnostics.
			viteConfig = config;
			logger = logLevel
				? createLogger(logLevel, { allowClearScreen: config.clearScreen })
				: config.logger;
			root = ensureAbsolute(options.root, config.root);

			const libraryConfig = config.build.lib || undefined;
			if (libraryConfig?.entry) {
				entries = toEntryMap(
					libraryConfig.entry as string | string[] | Record<string, string>,
				);
				const filename = libraryConfig.fileName ?? defaultIndex;
				const firstEntry =
					typeof libraryConfig.entry === 'string'
						? libraryConfig.entry
						: Array.isArray(libraryConfig.entry)
							? libraryConfig.entry[0]
							: Object.keys(libraryConfig.entry)[0];

				libName = libraryConfig.name || '_default';
				indexName =
					typeof filename === 'string' ? filename : filename('es', firstEntry);
				if (!dtsRE.test(indexName)) {
					indexName = `${indexName.replace(tjsRE, '')}.d.${extPrefix(indexName)}ts`;
				}
			}

			if (!entries) {
				logger.warn(
					`\n${logPrefix} No library entry was found in Vite config. Falling back to Rollup input when available.\n`,
				);
				libName = '_default';
				indexName = defaultIndex;
			}

			if (!options.outDir) {
				outDirs = [ensureAbsolute(config.build.outDir, root)];
			}
		},
		options(rollupInputOptions) {
			// Rollup input is the fallback when `build.lib` is not present in the
			// Vite config.
			if (!entries && rollupInputOptions.input) {
				entries = toEntryMap(
					rollupInputOptions.input as
						| string
						| string[]
						| Record<string, string>,
				);
			}
		},
		async buildStart() {
			// Vite can call buildStart more than once in watch mode. Refresh the
			// cached declaration state here as a fallback so rebuilds stay correct
			// even if the watcher backend does not trigger watchChange.
			if (program) {
				bundled = false;
				timeRecord = 0;
				outputFiles.clear();
				diagnostics.length = 0;
				for (const file of rootNames) {
					rootFiles.add(file);
				}
				if (rebuildProgram) {
					program = rebuildProgram();
					diagnostics.push(
						...program.getDeclarationDiagnostics(),
						...program.getSemanticDiagnostics(),
						...program.getSyntacticDiagnostics(),
					);
				}
				return;
			}

			const startTime = Date.now();
			// Start each build with a clean emission cache so files from previous
			// runs do not leak into the next writeBundle phase.
			outputFiles.clear();
			diagnostics.length = 0;
			configPath = tsconfigPath
				? ensureAbsolute(tsconfigPath, root)
				: ts.findConfigFile(root, ts.sys.fileExists);
			const content = configPath ? loadTsConfig(configPath) : undefined;
			compilerOptions = {
				...content?.options,
				...options.compilerOptions,
				...fixedCompilerOptions,
				outDir: '.',
				declarationDir: '.',
			};

			rawCompilerOptions =
				(content?.raw.compilerOptions as Record<string, unknown> | undefined) ??
				{};
			setModuleResolution(compilerOptions);

			// Output directories come from the plugin option first, then tsconfig,
			// then Vite.
			if (!outDirs) {
				outDirs = options.outDir
					? ensureArray(options.outDir).map((dir) => ensureAbsolute(dir, root))
					: [
							ensureAbsolute(
								content?.raw.compilerOptions?.outDir
									? resolveConfigDir(content.raw.compilerOptions.outDir, root)
									: 'dist',
								root,
							),
						];
			}

			const baseUrl = compilerOptions.paths ? process.cwd() : undefined;
			const paths = compilerOptions.paths;
			if (pathsToAliases && baseUrl && paths) {
				aliases.push(
					...parseTsAliases(
						ensureAbsolute(
							resolveConfigDir(baseUrl, root),
							configPath ? dirname(configPath) : root,
						),
						paths,
					),
				);
			}

			const computeGlobs = (
				rootGlobs: string | string[] | undefined,
				tsGlobs: string[] | undefined,
				defaultGlob: string,
			): string[] => {
				if (rootGlobs && ensureArray(rootGlobs).length) {
					return ensureArray(rootGlobs).map((glob) =>
						normalizeGlob(ensureAbsolute(resolveConfigDir(glob, root), root)),
					);
				}

				// If the plugin does not override include/exclude, mirror the
				// tsconfig view of the project so declaration generation sees the same
				// file set as TypeScript.
				return ensureArray(tsGlobs?.length ? tsGlobs : defaultGlob).map(
					(glob) =>
						normalizeGlob(
							ensureAbsolute(
								resolveConfigDir(glob, root),
								configPath ? dirname(configPath) : root,
							),
						),
				);
			};

			include = computeGlobs(
				options.include,
				[
					...ensureArray(content?.raw.include as string[] | undefined),
					...ensureArray(content?.raw.files as string[] | undefined),
				],
				'**/*',
			);
			exclude = computeGlobs(
				options.exclude,
				ensureArray(content?.raw.exclude as string[] | undefined),
				'node_modules/**',
			);
			filter = createFilter(include, exclude);

			const entryValues = entries
				? Object.values(entries).map((entry) => ensureAbsolute(entry, root))
				: [];
			// Root names include both declared library entries and every filtered
			// tsconfig file so the emitted declaration graph is complete even for
			// re-export chains.
			rootNames = Array.from(
				new Set(
					[...entryValues, ...(content?.fileNames.filter(filter) ?? [])].map(
						normalizePath,
					),
				),
			);
			rebuildProgram = () => {
				host = ts.createCompilerHost(compilerOptions!);
				return ts.createProgram({
					host,
					rootNames,
					options: compilerOptions!,
					projectReferences: content?.projectReferences,
				});
			};
			program = rebuildProgram();

			// Prefer TS rootDir when available; otherwise compute the shallowest
			// shared source directory so emitted relative paths stay stable across
			// projects.
			publicRoot = compilerOptions.rootDir
				? ensureAbsolute(resolveConfigDir(compilerOptions.rootDir, root), root)
				: queryPublicPath(
						program
							.getSourceFiles()
							.filter((sourceFile) =>
								maybeEmitSourceFile(program!, compilerOptions!, sourceFile),
							)
							.map((sourceFile) => sourceFile.fileName),
					);
			publicRoot = normalizePath(publicRoot || root);
			entryRoot = ensureAbsolute(entryRoot || publicRoot, root);
			libName = toCapitalCase(libName || '_default');
			indexName = indexName || defaultIndex;

			diagnostics.push(
				...(content?.errors ?? []),
				...program.getDeclarationDiagnostics(),
				...program.getSemanticDiagnostics(),
				...program.getSyntacticDiagnostics(),
			);

			for (const file of rootNames) {
				rootFiles.add(file);
			}

			// Watch every participating source file, not just entry files.
			// Resolver-backed assets such as JSON never become TS root names on
			// their own, but they still need to invalidate the declaration graph
			// when they change.
			for (const sourceFile of program.getSourceFiles()) {
				if (filter?.(sourceFile.fileName)) {
					this.addWatchFile(sourceFile.fileName);
				}
			}

			timeRecord += Date.now() - startTime;
		},
		async transform(code, id) {
			const normalizedId = normalizePath(id).split('?')[0];
			const resolver = resolvers.find((entry) => entry.supports(normalizedId));

			// Skip anything outside the filtered project view, and avoid
			// reprocessing files that already produced declaration output during
			// this build.
			if (
				!host ||
				!program ||
				!filter ||
				!filter(normalizedId) ||
				(!resolver && !tjsRE.test(normalizedId)) ||
				transformedFiles.has(normalizedId)
			) {
				return undefined;
			}

			const startTime = Date.now();
			const outDir = outDirs?.[0] ?? ensureAbsolute('dist', root);
			// Once a file is transformed here it no longer needs the writeBundle
			// root-file emit path.
			rootFiles.delete(normalizedId);
			transformedFiles.add(normalizedId);

			if (resolver) {
				// Custom resolvers synthesize declaration files directly instead of
				// relying on TS emit.
				const result = await resolver.transform({
					id: normalizedId,
					code,
					root: publicRoot,
					outDir,
					host,
					program,
				});

				const output = Array.isArray(result) ? result : result.outputs;
				if (
					!Array.isArray(result) &&
					result.emitSkipped &&
					result.diagnostics?.length
				) {
					diagnostics.push(...result.diagnostics);
				}

				for (const { path, content } of output) {
					setOutputFile(
						resolvePath(
							publicRoot,
							relative(outDir, ensureAbsolute(path, outDir)),
						),
						content,
					);
				}
			} else {
				// For standard TS and JS sources, delegate declaration generation to
				// the compiler.
				const sourceFile = program.getSourceFile(normalizedId);
				if (sourceFile) {
					const result = program.emit(
						sourceFile,
						(name, text) => {
							setOutputFile(
								resolvePath(
									publicRoot,
									relative(outDir, ensureAbsolute(name, outDir)),
								),
								text,
							);
						},
						undefined,
						true,
					);
					if (result.emitSkipped && result.diagnostics.length) {
						diagnostics.push(...result.diagnostics);
					}
				}
			}

			const dtsId = normalizedId.replace(tjsRE, '') + '.d.ts';
			const dtsSourceFile = program.getSourceFile(dtsId);
			if (dtsSourceFile && filter(dtsSourceFile.fileName)) {
				// TS can synthesize a declaration file for JS/TS inputs without
				// routing the final .d.ts back through Vite, so cache it explicitly
				// when it exists.
				setOutputFile(
					normalizePath(dtsSourceFile.fileName),
					dtsSourceFile.getFullText(),
				);
			}

			timeRecord += Date.now() - startTime;
			return undefined;
		},
		watchChange(id) {
			const normalizedId = normalizePath(id).split('?')[0];
			const resolver = resolvers.find((entry) => entry.supports(normalizedId));
			if (
				!host ||
				!program ||
				!filter ||
				!filter(normalizedId) ||
				(!resolver && !tjsRE.test(normalizedId))
			) {
				return;
			}

			// Requeue every root file because TypeScript declarations can change
			// transitively when any dependency changes, even if the changed file
			// is not an entry itself.
			for (const file of rootNames) {
				rootFiles.add(file);
			}

			rootFiles.add(normalizedId);
			bundled = false;
			timeRecord = 0;
			outputFiles.clear();
			diagnostics.length = 0;
			if (rebuildProgram) {
				program = rebuildProgram();
			}
		},
		async writeBundle() {
			// writeBundle is the single point that flushes the accumulated
			// declaration graph.
			transformedFiles.clear();
			if (!host || !program || bundled) {
				return;
			}

			bundled = true;
			const outDir = outDirs?.[0] ?? ensureAbsolute('dist', root);
			const startTime = Date.now();
			const emittedFiles = new Map<string, string>();
			const declareModules: string[] = [];

			logger.info(`\n${logPrefix} Start generate declaration files...`);

			if (diagnostics.length) {
				logger.error(
					ts.formatDiagnosticsWithColorAndContext(diagnostics, host),
				);
			}
			await unwrapPromise(afterDiagnostic(diagnostics));

			const writeOutput = async (
				filePath: string,
				content: string,
				targetOutDir: string,
				record = true,
			): Promise<void> => {
				// Hooks can redirect or suppress writes, but the plugin still
				// enforces that the final path stays inside the selected output
				// directory when strictOutput is on.
				const maybeResult = await unwrapPromise(
					beforeWriteFile(filePath, content),
				);
				if (maybeResult === false) {
					return;
				}

				let resolvedPath = normalizePath(filePath);
				let resolvedContent = content;
				if (maybeResult && typeof maybeResult === 'object') {
					resolvedPath = normalizePath(maybeResult.filePath ?? resolvedPath);
					resolvedContent = maybeResult.content ?? resolvedContent;
				}

				const dir = normalizePath(dirname(resolvedPath));
				if (strictOutput && !dir.startsWith(normalizePath(targetOutDir))) {
					logger.warn(`${logPrefix} Outside emitted: ${resolvedPath}`);
					return;
				}

				await mkdir(dir, { recursive: true });
				await writeFile(resolvedPath, resolvedContent, 'utf8');
				if (record) {
					emittedFiles.set(resolvedPath, resolvedContent);
				}
			};

			for (const sourceFile of program.getSourceFiles()) {
				if (!filter?.(sourceFile.fileName)) {
					continue;
				}

				const resolver = resolvers.find((entry) =>
					entry.supports(sourceFile.fileName),
				);

				if (copyDtsFiles && dtsRE.test(sourceFile.fileName)) {
					setOutputFile(
						normalizePath(sourceFile.fileName),
						sourceFile.getFullText(),
					);
				}

				if (resolver && !transformedFiles.has(sourceFile.fileName)) {
					// Vite only calls `transform` for modules that pass through its
					// pipeline. Imported assets handled by custom resolvers may still
					// be present in the TS program, so writeBundle performs a final
					// sweep to avoid missing files.
					const result = await resolver.transform({
						id: sourceFile.fileName,
						code: sourceFile.getFullText(),
						root: publicRoot,
						outDir,
						host,
						program,
					});

					const output = Array.isArray(result) ? result : result.outputs;
					if (
						!Array.isArray(result) &&
						result.emitSkipped &&
						result.diagnostics?.length
					) {
						diagnostics.push(...result.diagnostics);
					}

					for (const { path, content } of output) {
						setOutputFile(
							resolvePath(
								publicRoot,
								relative(outDir, ensureAbsolute(path, outDir)),
							),
							content,
						);
					}
					transformedFiles.add(sourceFile.fileName);
				}

				if (rootFiles.has(sourceFile.fileName)) {
					program.emit(
						sourceFile,
						(name, text) => {
							setOutputFile(
								resolvePath(
									publicRoot,
									relative(outDir, ensureAbsolute(name, outDir)),
								),
								text,
							);
						},
						undefined,
						true,
					);
					rootFiles.delete(sourceFile.fileName);
				}
			}

			const declarationFiles = new Map<string, string>();
			const mapFiles = new Map<string, string>();
			const prependMappings = new Map<string, string>();

			// Source maps need separate handling because declaration rewriting may
			// change line counts, which has to be reflected in the final mapping
			// output.
			for (const [filePath, content] of outputFiles.entries()) {
				if (filePath.endsWith('.map')) {
					mapFiles.set(filePath, content);
				} else {
					declarationFiles.set(filePath, content);
				}
			}

			await runParallel(
				cpus().length,
				Array.from(declarationFiles.entries()),
				async ([filePath, content]) => {
					const newFilePath = resolvePath(
						outDir,
						relative(entryRoot, filePath),
					);
					let nextContent = content;
					if (nextContent) {
						// Normalize imports after TS emit so aliases, import types, and
						// ambient modules all use the same layout before anything is
						// written or rolled up.
						const result = transformDeclarationContent({
							filePath,
							content: nextContent,
							aliases,
							aliasesExclude,
							staticImport,
							clearPureImport,
						});
						nextContent = result.content;
						declareModules.push(...result.declareModules);
						if (result.diffLineCount) {
							prependMappings.set(
								`${newFilePath}.map`,
								';'.repeat(result.diffLineCount),
							);
						}
					}
					await writeOutput(newFilePath, nextContent, outDir);
				},
			);

			await runParallel(
				cpus().length,
				Array.from(mapFiles.entries()),
				async ([filePath, content]) => {
					const baseDir = dirname(filePath);
					const outputPath = resolvePath(outDir, relative(entryRoot, filePath));
					let nextContent = content;
					try {
						const sourceMap = JSON.parse(content) as {
							sources: string[];
							mappings: string;
						};
						sourceMap.sources = sourceMap.sources.map((source) =>
							normalizePath(
								relative(
									dirname(outputPath),
									resolvePath(
										viteConfig?.root ?? root,
										relative(publicRoot, baseDir),
										source,
									),
								),
							),
						);
						if (prependMappings.has(outputPath)) {
							sourceMap.mappings = `${prependMappings.get(outputPath)}${sourceMap.mappings}`;
						}
						nextContent = JSON.stringify(sourceMap);
					} catch {
						logger.warn(
							`${logPrefix} Processing source map fail: ${outputPath}`,
						);
					}
					await writeOutput(outputPath, nextContent, outDir);
				},
			);

			if (insertTypesEntry || rollupTypes) {
				// Package metadata can redirect the public type entry away from the
				// compiler's natural output location, so read it before generating
				// entry shims or rollups.
				const pkgPath = tryGetPkgPath(root);
				let pkg: Record<string, any> = {};
				if (pkgPath && existsSync(pkgPath)) {
					try {
						pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<
							string,
							any
						>;
					} catch {
						pkg = {};
					}
				}

				const entryNames = Object.keys(entries ?? {});
				const types = findTypesPath(pkg.publishConfig, pkg);
				const multipleEntries = entryNames.length > 1;
				let typesPath = types
					? resolvePath(root, types)
					: resolvePath(outDir, indexName);

				if (!multipleEntries && !dtsRE.test(typesPath)) {
					logger.warn(
						`\n${logPrefix} The resolved type entry does not end with .d.ts; normalizing it.\n`,
					);
					typesPath = `${typesPath.replace(tjsRE, '')}.d.${extPrefix(typesPath)}ts`;
				}

				for (const name of entryNames) {
					const entryDtsPath = multipleEntries
						? resolvePath(outDir, tsToDts(name))
						: typesPath;
					if (existsSync(entryDtsPath)) {
						continue;
					}

					// When package.json points `types` somewhere other than the
					// emitted entry, generate a shim that re-exports the actual
					// declaration file Vite produced.
					const sourceEntry = normalizePath(
						resolvePath(outDir, relative(entryRoot, tsToDts(entries![name]))),
					);
					let fromPath = normalizePath(
						relative(dirname(entryDtsPath), sourceEntry),
					).replace(dtsRE, '');
					fromPath = fullRelativeRE.test(fromPath) ? fromPath : `./${fromPath}`;

					let shimContent = 'export {}\n';
					const emittedEntry = emittedFiles.get(sourceEntry);
					if (emittedEntry) {
						if (hasNormalExport(emittedEntry)) {
							shimContent = `export * from '${fromPath}'\n${shimContent}`;
						}
						if (hasExportDefault(emittedEntry)) {
							shimContent += `import ${libName} from '${fromPath}'\nexport default ${libName}\n`;
						}
					}

					await writeOutput(entryDtsPath, shimContent, outDir);
				}

				if (rollupTypes) {
					logger.info(`${logPrefix} Start rollup declaration files...`);
					const compilerOptionsForRollup =
						configPath && host.readFile
							? getTsConfig(configPath, host.readFile).compilerOptions
							: rawCompilerOptions;
					const rollupFiles = new Set<string>();

					const rollupEntry = async (filePath: string): Promise<void> => {
						// API Extractor writes the bundled entry in place, so the original
						// emitted declaration becomes temporary build state that can be
						// deleted afterwards.
						const result = await rollupDeclarationFiles({
							root: publicRoot,
							configPath,
							compilerOptions: compilerOptionsForRollup,
							outDir,
							entryPath: filePath,
							fileName: basename(filePath),
							libFolder: getTsLibFolder(publicRoot),
							rollupConfig,
							rollupOptions,
						});
						emittedFiles.delete(filePath);
						rollupFiles.add(filePath);
						await unwrapPromise(afterRollup(result));
					};

					if (multipleEntries) {
						await runParallel(cpus().length, entryNames, async (name) => {
							await rollupEntry(resolvePath(outDir, tsToDts(name)));
						});
					} else {
						await rollupEntry(typesPath);
					}

					await runParallel(
						cpus().length,
						Array.from(emittedFiles.keys()),
						async (filePath) => {
							await unlink(filePath);
						},
					);

					removeDirIfEmpty(outDir);
					emittedFiles.clear();
					const declared = declareModules.join('\n');
					await runParallel(
						cpus().length,
						Array.from(rollupFiles),
						async (filePath) => {
							const content = await readFile(filePath, 'utf8');
							await writeOutput(
								filePath,
								declared ? `${content}\n${declared}` : content,
								dirname(filePath),
							);
						},
					);
				}
			}

			if (outDirs && outDirs.length > 1) {
				// Secondary outDirs are simple copies of the primary output with
				// source-map paths adjusted to stay relative to the target directory.
				const extraOutDirs = outDirs.slice(1);
				await runParallel(
					cpus().length,
					Array.from(emittedFiles.entries()),
					async ([writtenFile, content]) => {
						const relativePath = relative(outDir, writtenFile);
						await Promise.all(
							extraOutDirs.map(async (targetOutDir) => {
								const targetPath = resolvePath(targetOutDir, relativePath);
								let nextContent = content;
								if (writtenFile.endsWith('.map')) {
									const updated = editSourceMapDir(
										content,
										outDir,
										targetOutDir,
									);
									if (updated === false) {
										logger.warn(
											`${logPrefix} Processing source map fail: ${targetPath}`,
										);
									} else if (typeof updated === 'string') {
										nextContent = updated;
									}
								}
								await writeOutput(targetPath, nextContent, targetOutDir, false);
							}),
						);
					},
				);
			}

			diagnostics.length = 0;
			await unwrapPromise(afterBuild(emittedFiles));
			logger.info(
				`${logPrefix} Declaration files built in ${timeRecord + Date.now() - startTime}ms.\n`,
			);
		},
		generateBundle(_, bundle) {
			if (!declarationOnly) {
				return;
			}
			for (const key of Object.keys(bundle)) {
				delete bundle[key];
			}
		},
	};
}
