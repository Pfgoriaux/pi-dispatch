/**
 * Preload (`node --import`) for running the durable CLI from an installed copy.
 *
 * Pi installs git packages without peer or dev dependencies, so the CLI cannot
 * resolve `@earendil-works/pi-coding-agent` from pi-dispatch's own
 * node_modules. PI_DISPATCH_HOST_SDK names a Pi installation's SDK entry; the
 * hook uses it only when normal resolution fails, so development checkouts
 * keep their installed copy.
 */
import { register } from "node:module";

const entry = process.env.PI_DISPATCH_HOST_SDK;
if (entry) register("./host-sdk-hooks.mjs", import.meta.url, { data: { entry } });
