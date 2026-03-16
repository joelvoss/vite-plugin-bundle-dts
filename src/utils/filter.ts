import { normalizePath } from './common';

type FilterPattern = string | RegExp;

function escapeRegex(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
	const normalized = normalizePath(glob);
	const segments = normalized.split('/');
	const pattern = segments
		.map((segment) => {
			if (segment === '**') {
				return '.*';
			}

			return escapeRegex(segment)
				.replace(/\\\*/g, '[^/]*')
				.replace(/\\\?/g, '[^/]');
		})
		.join('/');

	return new RegExp(`^${pattern}$`);
}

function matchesPattern(id: string, pattern: FilterPattern): boolean {
	return pattern instanceof RegExp
		? pattern.test(id)
		: globToRegExp(pattern).test(id);
}

export function createFilter(
	include: FilterPattern | FilterPattern[] | undefined,
	exclude: FilterPattern | FilterPattern[] | undefined,
): (id: string) => boolean {
	const includePatterns = (
		Array.isArray(include) ? include : include ? [include] : []
	).map((pattern) =>
		pattern instanceof RegExp ? pattern : normalizePath(pattern),
	);
	const excludePatterns = (
		Array.isArray(exclude) ? exclude : exclude ? [exclude] : []
	).map((pattern) =>
		pattern instanceof RegExp ? pattern : normalizePath(pattern),
	);

	return (id: string): boolean => {
		const normalizedId = normalizePath(id);
		const included =
			includePatterns.length === 0 ||
			includePatterns.some((pattern) => matchesPattern(normalizedId, pattern));
		if (!included) {
			return false;
		}

		return !excludePatterns.some((pattern) =>
			matchesPattern(normalizedId, pattern),
		);
	};
}
