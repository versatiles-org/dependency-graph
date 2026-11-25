import type { Status } from '../../../scripts/dependency-graph/drift';

/** One tab of a status page, with what is left to do in its part. */
export interface Tab {
	/** Also the hash that leads to it, so links to `#deployments` and the like keep working. */
	id: string;
	label: string;
	/** What is left to do there, or null when that is unknown. */
	count: number | null;
	/** What the count counts, read out after it. */
	counted: string;
	tone: Status;
}
