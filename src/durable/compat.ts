import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import type * as DurableModule from "@earendil-works/pi-durable";
import type * as DurableSqliteModule from "@earendil-works/pi-durable/storage/sqlite/node";

/** Exact package versions the durable store was verified against. */
export const DURABLE_PACKAGE_VERSIONS = Object.freeze({
	"@earendil-works/pi-durable": "1.0.4",
	"@earendil-works/pi-ai": "1.0.4",
	"@earendil-works/chord": "1.0.4",
} as const);
export const DURABLE_MIN_NODE_VERSION = "22.19.0";

type PackageName = keyof typeof DURABLE_PACKAGE_VERSIONS;
type DurableHarnessOptions = DurableModule.HarnessOptions;
/** pi-ai Models as Durable's declarations resolve them; never the root SDK copy. */
export type DurableModels = DurableHarnessOptions["models"];
/** Chord Context as Durable's declarations resolve it. */
export type DurableContext = Parameters<typeof DurableModule.Harness.open>[2];

export interface DurableRuntime {
	readonly durable: typeof DurableModule;
	readonly sqlite: typeof DurableSqliteModule;
	/** Providerless pi-ai model access from Durable's own pi-ai copy. */
	readonly createModels: () => DurableModels;
	/** Durable-resolved Chord BACKGROUND_CONTEXT. */
	readonly context: DurableContext;
	readonly versions: Readonly<Record<PackageName, string>>;
	/** Absolute entry files actually loaded. */
	readonly entries: Readonly<Record<"durable" | "sqlite" | "models" | "context", string>>;
}

export class DurableCompatibilityError extends Error {
	override name = "DurableCompatibilityError";
}

export interface LoadDurableRuntimeOptions {
	/** Durable package.json to anchor resolution at; defaults to the copy this package depends on. */
	readonly durablePackageJson?: string;
	readonly nodeVersion?: string;
}

function versionParts(version: string): number[] {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!match) throw new DurableCompatibilityError(`Unrecognized Node.js version ${version}.`);
	return match.slice(1, 4).map(Number);
}

/** Reject Node.js releases older than Durable's engine floor. */
export function assertNodeVersion(version: string = process.versions.node): void {
	const actual = versionParts(version);
	const minimum = versionParts(DURABLE_MIN_NODE_VERSION);
	const index = actual.findIndex((part, i) => part !== minimum[i]);
	if (index === -1 || actual[index] > minimum[index]) return;
	throw new DurableCompatibilityError(`Durable store requires Node.js >=${DURABLE_MIN_NODE_VERSION}; found ${version}.`);
}

interface PackageManifest { readonly dir: string; readonly name: string; readonly version: string; readonly exports: unknown }

function readManifest(packageJson: string): PackageManifest {
	const parsed = JSON.parse(fs.readFileSync(packageJson, "utf8")) as { name?: unknown; version?: unknown; exports?: unknown };
	if (typeof parsed.name !== "string" || typeof parsed.version !== "string") {
		throw new DurableCompatibilityError(`Invalid package manifest ${packageJson}.`);
	}
	return { dir: path.dirname(packageJson), name: parsed.name, version: parsed.version, exports: parsed.exports };
}

/**
 * Node's package-directory lookup from a Durable-anchored `createRequire`,
 * without export conditions or host aliases.
 */
function packageFrom(durableRequire: NodeJS.Require, name: string): PackageManifest {
	for (const base of durableRequire.resolve.paths(name) ?? []) {
		const packageJson = path.join(base, name, "package.json");
		if (fs.existsSync(packageJson)) return readManifest(fs.realpathSync(packageJson));
	}
	throw new DurableCompatibilityError(`Durable cannot resolve ${name}.`);
}

function assertVersion(manifest: PackageManifest, name: PackageName): void {
	const expected = DURABLE_PACKAGE_VERSIONS[name];
	if (manifest.name === name && manifest.version === expected) return;
	throw new DurableCompatibilityError(
		`Durable store requires ${name}@${expected}; resolved ${manifest.name}@${manifest.version} at ${manifest.dir}.`,
	);
}

/** File for an ESM `import` export of `subpath`; fails closed for any other shape. */
function exportedFile(manifest: PackageManifest, subpath: string): string {
	const target = (manifest.exports as Record<string, { import?: unknown } | undefined> | undefined)?.[subpath]?.import;
	if (typeof target !== "string") {
		throw new DurableCompatibilityError(`${manifest.name}@${manifest.version} does not export ${subpath} for import.`);
	}
	const file = path.resolve(manifest.dir, target);
	if (!file.startsWith(manifest.dir + path.sep)) {
		throw new DurableCompatibilityError(`${manifest.name} export ${subpath} escapes its package.`);
	}
	return file;
}

function defaultDurablePackageJson(): string {
	return createRequire(import.meta.url).resolve("@earendil-works/pi-durable/package.json");
}

/**
 * `import()` on Node's main-context ESM loader. Host transpilers (Pi's jiti,
 * tsx) never rewrite it, so their package aliases cannot substitute another
 * pi-ai or Chord copy inside Durable's module graph.
 */
let nativeImport: ((specifier: string) => Promise<unknown>) | undefined;
function importFile<T>(file: string): Promise<T> {
	nativeImport ??= vm.compileFunction("return import(specifier)", ["specifier"], {
		importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
	}) as (specifier: string) => Promise<unknown>;
	return nativeImport(pathToFileURL(file).href) as Promise<T>;
}

let cached: Promise<DurableRuntime> | undefined;

/**
 * Load Durable and the pi-ai/Chord copies Durable itself resolves. Versions are
 * checked before any module code runs.
 */
export function loadDurableRuntime(options: LoadDurableRuntimeOptions = {}): Promise<DurableRuntime> {
	const useCache = options.durablePackageJson === undefined && options.nodeVersion === undefined;
	if (!useCache) return loadRuntime(options);
	cached ??= loadRuntime(options);
	cached.catch(() => { cached = undefined; });
	return cached;
}

async function loadRuntime(options: LoadDurableRuntimeOptions): Promise<DurableRuntime> {
	assertNodeVersion(options.nodeVersion);
	const durablePackageJson = fs.realpathSync(options.durablePackageJson ?? defaultDurablePackageJson());
	const durableRequire = createRequire(durablePackageJson);
	const durable = readManifest(durablePackageJson);
	const ai = packageFrom(durableRequire, "@earendil-works/pi-ai");
	const chord = packageFrom(durableRequire, "@earendil-works/chord");
	assertVersion(durable, "@earendil-works/pi-durable");
	assertVersion(ai, "@earendil-works/pi-ai");
	assertVersion(chord, "@earendil-works/chord");
	const entries = Object.freeze({
		durable: exportedFile(durable, "."),
		sqlite: exportedFile(durable, "./storage/sqlite/node"),
		models: exportedFile(ai, "./models"),
		context: exportedFile(chord, "./context"),
	});
	const [durableModule, sqlite, models, context] = await Promise.all([
		importFile<typeof DurableModule>(entries.durable),
		importFile<typeof DurableSqliteModule>(entries.sqlite),
		importFile<{ createModels: () => DurableModels }>(entries.models),
		importFile<{ BACKGROUND_CONTEXT: DurableContext }>(entries.context),
	]);
	return Object.freeze({
		durable: durableModule,
		sqlite,
		createModels: () => models.createModels(),
		context: context.BACKGROUND_CONTEXT,
		versions: Object.freeze({
			"@earendil-works/pi-durable": durable.version,
			"@earendil-works/pi-ai": ai.version,
			"@earendil-works/chord": chord.version,
		}),
		entries,
	});
}
