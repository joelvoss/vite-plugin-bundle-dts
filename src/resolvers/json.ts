import { relative } from 'node:path';

import type { DtsResolver } from '../types';

////////////////////////////////////////////////////////////////////////////////

const jsonRE = /\.json$/;

////////////////////////////////////////////////////////////////////////////////

/**
 * A simple resolver that generates declaration files for JSON modules by
 * wrapping their contents in a default export. This is useful for libraries
 * that include JSON files as part of their public API, but it can also be used
 * as a catch-all for any modules that don't have custom resolvers.
 */
export function createJsonResolver(): DtsResolver {
	return {
		name: 'json',
		supports(id) {
			return jsonRE.test(id);
		},
		transform({ id, root, program }) {
			const sourceFile = program.getSourceFile(id);
			if (!sourceFile) {
				return [];
			}

			return [
				{
					path: relative(root, `${id}.d.ts`),
					content: `declare const _default: ${sourceFile.text};\n\nexport default _default;\n`,
				},
			];
		},
	};
}
