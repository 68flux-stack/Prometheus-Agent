import { delimiter } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBinDir } from "../src/config.js";
import { kernelSpawnEnv } from "../src/core/kernel/index.js";

const saved = { ...process.env };

afterEach(() => {
	process.env = { ...saved };
});

describe("kernelSpawnEnv", () => {
	it("unsets inherited color-forcing vars instead of contradicting them", () => {
		process.env.FORCE_COLOR = "1";
		process.env.CLICOLOR_FORCE = "1";

		const env = kernelSpawnEnv(undefined);

		expect(env.NO_COLOR).toBe("1");
		expect(env.FORCE_COLOR).toBeUndefined();
		expect(env.CLICOLOR_FORCE).toBeUndefined();
	});

	it("uses UTF-8 mode on Windows so the kernel doesn't decode files as cp1252", () => {
		expect(kernelSpawnEnv(undefined).PYTHONUTF8).toBe(process.platform === "win32" ? "1" : undefined);
	});

	it("puts the managed bin directory on PATH so rg resolves for search() and %%bash", () => {
		const env = kernelSpawnEnv(undefined);
		const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";

		expect(env[pathKey]?.split(delimiter)).toContain(getBinDir());
	});

	it("lets per-kernel overrides win", () => {
		expect(kernelSpawnEnv({ NO_COLOR: "0", PYTHONUTF8: "0" }).NO_COLOR).toBe("0");
	});
});
