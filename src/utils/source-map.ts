import { relative } from 'node:path';

import { normalizePath, resolvePath } from './common.ts';

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
		const sourceMap = JSON.parse(content) as { sources?: string[] };
		sourceMap.sources = (sourceMap.sources ?? []).map((source) =>
			normalizePath(relative(toDir, resolvePath(fromDir, source))),
		);
		return JSON.stringify(sourceMap);
	} catch {
		return false;
	}
}
