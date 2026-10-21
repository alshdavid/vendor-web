import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function getVersion(packageName: string): string {
    let directory = dirname(fileURLToPath(import.meta.resolve(packageName)));

    while (true) {
        const packageJsonPath = join(directory, "package.json");

        try {
            const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

            if (packageJson.name === packageName) {
                return String(packageJson.version ?? "0.0.0");
            }
        } catch (error: any) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }

        const parentDirectory = dirname(directory);
        if (parentDirectory === directory) {
            throw new Error(`Could not find package metadata for "${packageName}"`);
        }
        directory = parentDirectory;
    }
}
