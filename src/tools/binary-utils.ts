/**
 * @file tools/binary-utils.ts
 * @description Utilities for detecting native executables vs Node.js entry scripts.
 *
 * Claude Code V2+ ships as ELF/Mach-O/PE binaries; attempting to run them with
 * `node --require interceptor` causes syntax errors. These helpers let
 * `trace-runner.ts` choose reverse-proxy mode vs V1 interceptor mode.
 */

import * as fs from "fs";

/** Magic-byte signatures at the start of common native executable formats. */
const NATIVE_BINARY_SIGNATURES = {
	ELF: Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
	MACHO_32: Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
	MACHO_64: Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
	MACHO_32_REV: Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
	MACHO_64_REV: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
	MACHO_FAT: Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
	PE: Buffer.from([0x4d, 0x5a]),
} as const;

/**
 * Resolve a CLI wrapper (npm bin shim, bash script) to the actual JavaScript entry file.
 *
 * npm/global installs often expose a small shell script that delegates to a `.js`
 * file under `lib/`. This function follows symlinks and heuristics to find that file.
 *
 * @param filePath - Path from `which claude` or user override
 * @returns Resolved `.js` path when found, otherwise the best-effort real path
 */
export function resolveToJsFile(filePath: string): string {
	try {
		const realPath = fs.realpathSync(filePath);

		if (realPath.endsWith(".js")) {
			return realPath;
		}

		// Shell wrapper pointing at Node — treat the wrapper itself as the entry
		if (fs.existsSync(realPath)) {
			const content = fs.readFileSync(realPath, "utf-8");
			if (
				content.startsWith("#!/usr/bin/env node") ||
				content.match(/^#!.*\/node$/m) ||
				content.includes("require(") ||
				content.includes("import ")
			) {
				return realPath;
			}
		}

		// Common npm layout: bin/foo -> ../lib/foo.js
		const possibleJsPaths = [
			realPath + ".js",
			realPath.replace(/\/bin\//, "/lib/") + ".js",
			realPath.replace(/\/\.bin\//, "/lib/bin/") + ".js",
		];

		for (const jsPath of possibleJsPaths) {
			if (fs.existsSync(jsPath)) {
				return jsPath;
			}
		}

		return realPath;
	} catch {
		return filePath;
	}
}

/**
 * Detect whether a file is a native compiled binary (not a Node.js script).
 *
 * Reads the first four bytes and compares against known executable magic numbers.
 * Used to gate reverse-proxy mode in trace-runner.
 *
 * @param filePath - Path to the candidate executable
 * @returns true if the file appears to be ELF, Mach-O, or PE
 */
export function isNativeBinary(filePath: string): boolean {
	try {
		const fd = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(4);
		fs.readSync(fd, buffer, 0, 4, 0);
		fs.closeSync(fd);

		if (buffer.subarray(0, 4).equals(NATIVE_BINARY_SIGNATURES.ELF)) return true;
		if (buffer.subarray(0, 4).equals(NATIVE_BINARY_SIGNATURES.MACHO_32)) return true;
		if (buffer.subarray(0, 4).equals(NATIVE_BINARY_SIGNATURES.MACHO_64)) return true;
		if (buffer.subarray(0, 4).equals(NATIVE_BINARY_SIGNATURES.MACHO_32_REV)) return true;
		if (buffer.subarray(0, 4).equals(NATIVE_BINARY_SIGNATURES.MACHO_64_REV)) return true;
		if (buffer.subarray(0, 4).equals(NATIVE_BINARY_SIGNATURES.MACHO_FAT)) return true;
		if (buffer.subarray(0, 2).equals(NATIVE_BINARY_SIGNATURES.PE)) return true;

		return false;
	} catch {
		return false;
	}
}
