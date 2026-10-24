import { isAbsolute, relative } from 'node:path';

import { normalizePath, resolvePath } from './common.ts';

const absoluteUrlRE = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

export function editSourceMapDir(
	content: string,
	fromDir: string,
	toDir: string,
): boolean | string {
	const relativeOutDir = relative(fromDir, toDir);
	if (!relativeOutDir) {
		return true;
	}

	try {
		const sourceMap = JSON.parse(content) as {
			sources?: string[];
			sourceRoot?: string;
		};
		if (sourceMap.sourceRoot) {
			if (
				!isAbsolute(sourceMap.sourceRoot) &&
				!absoluteUrlRE.test(sourceMap.sourceRoot)
			) {
				sourceMap.sourceRoot =
					normalizePath(
						relative(toDir, resolvePath(fromDir, sourceMap.sourceRoot)),
					) + (sourceMap.sourceRoot.endsWith('/') ? '/' : '');
			}
		} else {
			sourceMap.sources = (sourceMap.sources ?? []).map((source) =>
				absoluteUrlRE.test(source)
					? source
					: normalizePath(relative(toDir, resolvePath(fromDir, source))),
			);
		}
		return JSON.stringify(sourceMap);
	} catch {
		return false;
	}
}
