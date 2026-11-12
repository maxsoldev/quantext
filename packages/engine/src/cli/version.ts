/**
 * The release version, from the root package.json: its one source (ADR 30). The bundler inlines only this
 * string, so the engine reports the same version run from source or from `dist/engine.js`.
 */
import rootPackage from "../../../../package.json" with { type: "json" };

export const VERSION: string = rootPackage.version;
