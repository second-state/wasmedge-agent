export const bundledCatalogFiles: string[];
export const MIN_BUNDLED_MODEL_TRANSPORT_TUPLES: number;
export const MIN_BUNDLED_MCP_SERVICES: number;

export interface CatalogAssetOptions {
	outDir?: string;
	sourceDir?: string;
	catalogDir?: string;
	allowSmallFixture?: boolean;
}

export interface CatalogAssetResult {
	models: { models: number; transportTuples: number };
	mcpServices: { services: number };
}

export function generateBundledCatalogAssets(options?: CatalogAssetOptions): CatalogAssetResult;
export function copySourceCatalogAssets(options?: CatalogAssetOptions): CatalogAssetResult;
export function validateBundledModelCatalog(
	path: string,
	options?: CatalogAssetOptions,
): { models: number; transportTuples: number };
export function validateBundledMcpCatalog(path: string, options?: CatalogAssetOptions): { services: number };
export function validateBundledCatalogDir(directory: string, options?: CatalogAssetOptions): CatalogAssetResult;
