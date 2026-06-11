/**
 * @file api-format-display.test.ts
 *
 * Unit tests for human-readable API format labels used in trace reports and
 * the HTML conversation viewer.
 *
 * Raw traffic logs store internal `apiFormat` enum values (e.g. `"openai"`,
 * `"anthropic"`, `"openai-responses"`). The HTML generator and index metadata
 * use `formatApiFormatLabel` and `formatApiFormatsDisplay` (from `api-format.ts`)
 * to render user-facing strings such as "OpenAI Chat" or "Mixed (OpenAI Chat +
 * Anthropic Messages)" when a conversation spans multiple provider formats.
 *
 * @see ../src/api-format.ts — label formatting helpers
 * @see ../src/report/html-generator.ts — consumer of format display strings
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatApiFormatLabel, formatApiFormatsDisplay } from "../src/adapt/api-format";

/**
 * Tests mapping from internal `apiFormat` enum values to stable display strings.
 *
 * Labels are shown in report headers and conversation index entries.
 */
describe("formatApiFormatLabel", () => {
	/**
	 * Each recognized format token should resolve to a fixed, user-facing label
	 * suitable for display in the HTML viewer.
	 */
	it("maps known formats", () => {
		assert.equal(formatApiFormatLabel("openai"), "OpenAI Chat");
		assert.equal(formatApiFormatLabel("anthropic"), "Anthropic Messages");
	});
});

/**
 * Tests aggregation of one or more API formats into a single display string.
 *
 * Used when summarizing conversations that may have used multiple providers
 * or API formats across request pairs.
 */
describe("formatApiFormatsDisplay", () => {
	/**
	 * When only one recognized format is present, the display string should
	 * equal that format's individual label (no "Mixed" prefix).
	 */
	it("returns single format label", () => {
		assert.equal(formatApiFormatsDisplay(["openai"]), "OpenAI Chat");
	});

	/**
	 * When multiple recognized formats appear in the same conversation, they
	 * should be combined into a "Mixed (...)" summary with joined labels.
	 */
	it("returns mixed label for multiple formats", () => {
		assert.equal(
			formatApiFormatsDisplay(["openai", "anthropic"]),
			"Mixed (OpenAI Chat + Anthropic Messages)",
		);
	});

	/**
	 * Unrecognized format tokens produce no display string (`undefined`), so
	 * callers can omit the format badge when nothing is known.
	 */
	it("ignores unknown formats", () => {
		assert.equal(formatApiFormatsDisplay(["unknown"]), undefined);
	});
});
