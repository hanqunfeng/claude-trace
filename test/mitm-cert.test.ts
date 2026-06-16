/**
 * @file mitm-cert.test.ts
 *
 * Unit tests for the local CA and per-host leaf certificate cache used by
 * `vibe-coding-proxy` HTTPS MITM interception.
 *
 * @see ../src/intercept/mitm-cert.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import forge from "node-forge";
import { describe, it } from "node:test";
import { MitmCertificateAuthority } from "../src/intercept/mitm-cert";

/** Verifies persistent CA creation and host certificate reuse. */
describe("MitmCertificateAuthority", () => {
	/** The CA certificate should be generated once and persisted for reuse. */
	it("creates a reusable local CA certificate", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-ca-"));
		const ca = new MitmCertificateAuthority(tempDir);

		const info = ca.ensureAuthority();

		assert.equal(fs.existsSync(info.certPath), true);
		assert.equal(fs.existsSync(info.keyPath), true);
		assert.match(info.certPem, /BEGIN CERTIFICATE/);
	});

	/** Leaf certificates are cached by normalized host name. */
	it("caches leaf certificates for hosts", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-leaf-"));
		const ca = new MitmCertificateAuthority(tempDir);

		const first = ca.getCertificateForHost("API.DeepSeek.com");
		const second = ca.getCertificateForHost("api.deepseek.com");

		assert.equal(first.cert, second.cert);
		assert.equal(first.key, second.key);
	});

	/** Expired leaf certificates should be replaced automatically. */
	it("reissues expired leaf certificates", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-expired-leaf-"));
		const ca = new MitmCertificateAuthority(tempDir);
		const first = ca.getCertificateForHost("api.deepseek.com");
		fs.writeFileSync(path.join(tempDir, "api.deepseek.com.crt.pem"), createExpiredCertificatePem("api.deepseek.com"));

		const second = ca.getCertificateForHost("api.deepseek.com");

		assert.notEqual(second.cert, first.cert);
		assert.equal(/expired.example/.test(second.cert), false);
	});

	/** Expired CA certificates should be rebuilt and old leaf cache removed. */
	it("rebuilds expired CA and clears leaf cache", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-expired-ca-"));
		const ca = new MitmCertificateAuthority(tempDir);
		ca.getCertificateForHost("api.deepseek.com");
		fs.writeFileSync(path.join(tempDir, "ca.crt"), createExpiredCertificatePem("vibe-coding-proxy Local CA"));

		const refreshed = new MitmCertificateAuthority(tempDir).ensureAuthority();

		assert.match(refreshed.certPem, /BEGIN CERTIFICATE/);
		assert.equal(fs.existsSync(path.join(tempDir, "api.deepseek.com.crt.pem")), false);
		assert.equal(fs.existsSync(path.join(tempDir, "api.deepseek.com.key.pem")), false);
	});
});

/** Create an already-expired self-signed certificate for cache invalidation tests. */
function createExpiredCertificatePem(commonName: string): string {
	const keys = forge.pki.rsa.generateKeyPair(1024);
	const cert = forge.pki.createCertificate();
	cert.publicKey = keys.publicKey;
	cert.serialNumber = "01";
	cert.validity.notBefore = new Date("2000-01-01T00:00:00Z");
	cert.validity.notAfter = new Date("2000-01-02T00:00:00Z");
	const attrs = [
		{ name: "commonName", value: commonName },
		{ name: "organizationName", value: "expired.example" },
	];
	cert.setSubject(attrs);
	cert.setIssuer(attrs);
	cert.sign(keys.privateKey, forge.md.sha256.create());
	return forge.pki.certificateToPem(cert);
}
