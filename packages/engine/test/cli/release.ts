/** The release version: the root package.json is its one source (ADR 30). */
import rootPackage from "../../../../package.json" with { type: "json" };

export const RELEASE: string = rootPackage.version;
