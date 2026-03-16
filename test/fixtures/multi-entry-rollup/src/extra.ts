import { type SharedShape, primaryLabel } from './shared';

export function buildExtra(): SharedShape {
	return {
		label: primaryLabel,
		enabled: true,
	};
}
