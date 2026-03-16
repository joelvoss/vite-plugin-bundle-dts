import { existsSync, lstatSync, readdirSync, rmdirSync } from 'node:fs';
import {
	basename,
	dirname,
	isAbsolute,
	normalize,
	relative,
	sep,
} from 'node:path';

import type { PathAlias } from '../types';
import { ensureAbsolute, isRegExp, normalizePath, resolvePath } from './common';

const speRE = /[\\/]/;
const regexpSymbolRE = /([$.\\+?()[\]!<=|{}^,])/g;
const asteriskRE = /[*]+/g;
const rootAsteriskImportRE = /^(?!\.{1,2}\/)([^*]+)$/;

export const fullRelativeRE = /^\.\.?\//;

export function queryPublicPath(paths: string[]): string {
	if (paths.length === 0) {
		return '';
	}
	if (paths.length === 1) {
		return dirname(paths[0]);
	}

	let publicPath = normalize(dirname(paths[0])) + sep;
	let publicUnits = publicPath.split(speRE);
	let index = publicUnits.length - 1;

	for (const filePath of paths.slice(1)) {
		if (!index) {
			return publicPath;
		}

		const dirPath = normalize(dirname(filePath)) + sep;
		if (dirPath.startsWith(publicPath)) {
			continue;
		}

		const units = dirPath.split(speRE);
		if (units.length < index) {
			publicPath = dirPath;
			publicUnits = units;
			continue;
		}

		for (let i = 0; i <= index; i += 1) {
			if (publicUnits[i] !== units[i]) {
				if (!i) {
					return '';
				}
				index = i - 1;
				publicUnits = publicUnits.slice(0, index + 1);
				publicPath = publicUnits.join(sep) + sep;
				break;
			}
		}
	}

	return publicPath.slice(0, -1);
}

export function removeDirIfEmpty(dir: string): boolean {
	if (!existsSync(dir)) {
		return false;
	}

	let onlyHasDirectories = true;
	for (const file of readdirSync(dir)) {
		const absolutePath = resolvePath(dir, file);
		if (lstatSync(absolutePath).isDirectory()) {
			if (!removeDirIfEmpty(absolutePath)) {
				onlyHasDirectories = false;
			}
			continue;
		}
		onlyHasDirectories = false;
	}

	if (onlyHasDirectories) {
		rmdirSync(dir);
	}

	return onlyHasDirectories;
}

export function parseTsAliases(
	basePath: string,
	paths: Record<string, string[]>,
): PathAlias[] {
	const aliases: PathAlias[] = [];

	for (const [pathWithAsterisk, replacements] of Object.entries(paths)) {
		const find = new RegExp(
			`^${pathWithAsterisk.replace(regexpSymbolRE, '\\$1').replace(asteriskRE, '(?!\\.{1,2}\\/)([^*]+)')}$`,
		);
		let index = 1;
		aliases.push({
			find,
			replacement: ensureAbsolute(
				replacements[0].replace(asteriskRE, () => `$${index++}`),
				basePath,
			),
		});
	}

	return aliases;
}

export function isAliasGlobal(alias: PathAlias): boolean {
	return alias.find.toString() === rootAsteriskImportRE.toString();
}

export function isAliasMatch(alias: PathAlias, importer: string): boolean {
	if (isRegExp(alias.find)) {
		return alias.find.test(importer);
	}
	if (importer.length < alias.find.length) {
		return false;
	}
	if (importer === alias.find) {
		return true;
	}
	return (
		importer.startsWith(alias.find) &&
		(alias.find.endsWith('/') || importer[alias.find.length] === '/')
	);
}

export function importResolves(path: string): boolean {
	const extensions = [
		'.js',
		'.jsx',
		'.mjs',
		'.cjs',
		'.ts',
		'.tsx',
		'.mts',
		'.cts',
		'.d.ts',
		'.json',
	];

	return extensions.some((extension) => existsSync(path + extension));
}

export function transformAlias(
	importer: string,
	dir: string,
	aliases: PathAlias[] | undefined,
	aliasesExclude: Array<string | RegExp>,
): string {
	if (
		!aliases?.length ||
		aliasesExclude.some((entry) =>
			isRegExp(entry) ? entry.test(importer) : String(entry) === importer,
		)
	) {
		return importer;
	}

	const matchedAlias = aliases.find((alias) => isAliasMatch(alias, importer));
	if (!matchedAlias) {
		return importer;
	}

	const replacement = isAbsolute(matchedAlias.replacement)
		? normalizePath(relative(dir, matchedAlias.replacement))
		: normalizePath(matchedAlias.replacement);
	const endsWithSlash =
		typeof matchedAlias.find === 'string'
			? matchedAlias.find.endsWith('/')
			: (importer.match(matchedAlias.find)?.[0]?.endsWith('/') ?? false);
	const truthPath = importer.replace(
		matchedAlias.find,
		replacement + (endsWithSlash ? '/' : ''),
	);
	const absolutePath = resolvePath(dir, truthPath);
	const normalizedPath = normalizePath(relative(dir, absolutePath));
	const resultPath = normalizedPath.startsWith('.')
		? normalizedPath
		: `./${normalizedPath}`;

	if (!isAliasGlobal(matchedAlias)) {
		return resultPath;
	}

	return importResolves(absolutePath) ? resultPath : importer;
}

export function normalizeGlob(path: string): string {
	const lastSegment = path.split(/[\\/]/).pop() ?? '';
	if (/[\\/]$/.test(path)) {
		return path + '**';
	}
	if (!/^((?:.*\.[^.]+)|(?:\*+))$/.test(lastSegment)) {
		return path + '/**';
	}
	return path;
}

export function tryGetPkgPath(beginPath: string): string | undefined {
	let current = normalizePath(beginPath);
	while (current) {
		const pkgPath = resolvePath(current, 'package.json');
		if (existsSync(pkgPath)) {
			return pkgPath;
		}
		const parentDir = normalizePath(dirname(current));
		if (!parentDir || parentDir === current) {
			return undefined;
		}
		current = parentDir;
	}
	return undefined;
}

export function toCapitalCase(value: string): string {
	const compact = value.trim().replace(/\s+/g, '-');
	const camel = compact.replace(/-+(\w)/g, (_, character: string | undefined) =>
		character ? character.toUpperCase() : '',
	);
	return (camel.charAt(0).toLocaleUpperCase() + camel.slice(1)).replace(
		/[^\w]/g,
		'',
	);
}

export function findTypesPath(
	...pkgs: Array<Record<string, any> | undefined>
): string | undefined {
	for (const pkg of pkgs) {
		if (!pkg || typeof pkg !== 'object') {
			continue;
		}
		const path =
			pkg.types ??
			pkg.typings ??
			pkg.exports?.types ??
			pkg.exports?.['.']?.types ??
			pkg.exports?.['./']?.types;
		if (typeof path === 'string') {
			return path;
		}
	}
	return undefined;
}

export const mtjsRE = /\.m(t|j)sx?$/;
export const ctjsRE = /\.c(t|j)sx?$/;
export const tsRE = /\.(m|c)?tsx?$/;

export function extPrefix(filePath: string): string {
	if (mtjsRE.test(filePath)) {
		return 'm';
	}
	if (ctjsRE.test(filePath)) {
		return 'c';
	}
	return '';
}

export function tsToDts(filePath: string): string {
	return `${filePath.replace(tsRE, '')}.d.ts`;
}

export function toEntryMap(
	input: string | string[] | Record<string, string>,
): Record<string, string> {
	if (typeof input === 'string') {
		return { [basename(input)]: input };
	}
	if (Array.isArray(input)) {
		return input.reduce<Record<string, string>>((acc, current) => {
			acc[basename(current)] = current;
			return acc;
		}, {});
	}
	return { ...input };
}
