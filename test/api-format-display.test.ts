import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatApiFormatLabel, formatApiFormatsDisplay } from "../src/api-format";

describe("formatApiFormatLabel", () => {
	it("maps known formats", () => {
		assert.equal(formatApiFormatLabel("openai"), "OpenAI Chat");
		assert.equal(formatApiFormatLabel("anthropic"), "Anthropic Messages");
	});
});

describe("formatApiFormatsDisplay", () => {
	it("returns single format label", () => {
		assert.equal(formatApiFormatsDisplay(["openai"]), "OpenAI Chat");
	});

	it("returns mixed label for multiple formats", () => {
		assert.equal(
			formatApiFormatsDisplay(["openai", "anthropic"]),
			"Mixed (OpenAI Chat + Anthropic Messages)",
		);
	});

	it("ignores unknown formats", () => {
		assert.equal(formatApiFormatsDisplay(["unknown"]), undefined);
	});
});
