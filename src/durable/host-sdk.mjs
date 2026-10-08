/**
 * Preloaded into the durable owner (`node --import`) by durable_batch.
 *
 * Pi installs git packages without peer or dev dependencies, so a standalone
 * owner cannot resolve `@earendil-works/pi-coding-agent` from pi-dispatch's own
 * node_modules. The launching Pi process passes its own SDK entry in
 * PI_DISPATCH_HOST_SDK; the hook uses it only when normal resolution fails, so
 * development checkouts keep their installed copy.
 */
import { register } from "node:module";

const entry = process.env.PI_DISPATCH_HOST_SDK;
if (entry) register("./host-sdk-hooks.mjs", import.meta.url, { data: { entry } });
