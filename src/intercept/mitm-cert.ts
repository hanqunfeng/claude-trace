/**
 * @file mitm-cert.ts
 * @description Local CA and leaf certificate management for HTTPS MITM proxying.
 *
 * vibe-coding-proxy only decrypts HTTPS traffic for explicitly allowlisted model
 * API hosts. This module creates a reusable local certificate authority and
 * caches per-host leaf certificates signed by that CA. It never installs the CA
 * into the system trust store; users must opt in by trusting the printed CA path.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import forge from "node-forge";

/** PEM-encoded certificate and key pair used by Node TLS servers. */
export interface MitmCertificatePair {
	/** PEM private key for the generated leaf certificate. */
	key: string;
	/** PEM certificate signed by the local CA. */
	cert: string;
}

/** Paths and PEM contents for the local CA. */
export interface MitmAuthorityInfo {
	/** Absolute path to the CA certificate users must trust. */
	certPath: string;
	/** Absolute path to the CA private key used for leaf signing. */
	keyPath: string;
	/** PEM-encoded CA certificate. */
	certPem: string;
}

/**
 * Creates, loads, and reuses local MITM certificates for allowlisted hosts.
 */
export class MitmCertificateAuthority {
	private readonly caDir: string;
	private readonly caKeyPath: string;
	private readonly caCertPath: string;
	private authority: { key: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate; certPem: string } | null = null;

	/**
	 * @param caDir - Directory used to persist CA and cached leaf certificates.
	 */
	constructor(caDir: string = defaultCaDir()) {
		this.caDir = caDir;
		this.caKeyPath = path.join(caDir, "ca.key.pem");
		this.caCertPath = path.join(caDir, "ca.crt");
	}

	/**
	 * Ensure the local CA exists and return its user-facing paths.
	 * @returns CA certificate path and PEM content.
	 */
	ensureAuthority(): MitmAuthorityInfo {
		const authority = this.loadOrCreateAuthority();
		return {
			certPath: this.caCertPath,
			keyPath: this.caKeyPath,
			certPem: authority.certPem,
		};
	}

	/**
	 * Return a cached or newly generated leaf certificate for `hostname`.
	 * @param hostname - DNS name from the CONNECT target.
	 */
	getCertificateForHost(hostname: string): MitmCertificatePair {
		const normalizedHost = normalizeCertHost(hostname);
		const certPath = path.join(this.caDir, `${safeFileName(normalizedHost)}.crt.pem`);
		const keyPath = path.join(this.caDir, `${safeFileName(normalizedHost)}.key.pem`);

		if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
			const cachedCertPem = fs.readFileSync(certPath, "utf-8");
			if (isLeafCertificateUsable(cachedCertPem)) {
				return {
					cert: cachedCertPem,
					key: fs.readFileSync(keyPath, "utf-8"),
				};
			}
			fs.rmSync(certPath, { force: true });
			fs.rmSync(keyPath, { force: true });
		}

		const authority = this.loadOrCreateAuthority();
		const keys = forge.pki.rsa.generateKeyPair(2048);
		const cert = forge.pki.createCertificate();
		cert.publicKey = keys.publicKey;
		cert.serialNumber = crypto.randomBytes(16).toString("hex");
		cert.validity.notBefore = new Date(Date.now() - 60_000);
		cert.validity.notAfter = new Date();
		cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

		const attrs = [
			{ name: "commonName", value: normalizedHost },
			{ name: "organizationName", value: "vibe-coding-proxy" },
		];
		cert.setSubject(attrs);
		cert.setIssuer(authority.cert.subject.attributes);
		cert.setExtensions([
			{ name: "basicConstraints", cA: false, critical: true },
			{ name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
			{ name: "extKeyUsage", serverAuth: true },
			{
				name: "subjectAltName",
				altNames: buildSubjectAltNames(normalizedHost),
			},
			{ name: "subjectKeyIdentifier" },
			{
				name: "authorityKeyIdentifier",
				keyIdentifier: authority.cert.generateSubjectKeyIdentifier().getBytes(),
			},
		]);
		cert.sign(authority.key, forge.md.sha256.create());

		const pair = {
			key: forge.pki.privateKeyToPem(keys.privateKey),
			cert: forge.pki.certificateToPem(cert),
		};
		fs.writeFileSync(keyPath, pair.key, { mode: 0o600 });
		fs.writeFileSync(certPath, pair.cert);
		return pair;
	}

	/** Load persisted CA material or create it on first use. */
	private loadOrCreateAuthority(): { key: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate; certPem: string } {
		if (this.authority) {
			return this.authority;
		}

		fs.mkdirSync(this.caDir, { recursive: true });
		if (fs.existsSync(this.caKeyPath) && fs.existsSync(this.caCertPath)) {
			const keyPem = fs.readFileSync(this.caKeyPath, "utf-8");
			const certPem = fs.readFileSync(this.caCertPath, "utf-8");
			if (isAuthorityCertificateUsable(certPem)) {
				this.authority = {
					key: forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey,
					cert: forge.pki.certificateFromPem(certPem),
					certPem,
				};
				return this.authority;
			}
			fs.rmSync(this.caKeyPath, { force: true });
			fs.rmSync(this.caCertPath, { force: true });
			removeCachedLeafCertificates(this.caDir);
		}

		const keys = forge.pki.rsa.generateKeyPair(2048);
		const cert = forge.pki.createCertificate();
		cert.publicKey = keys.publicKey;
		cert.serialNumber = crypto.randomBytes(16).toString("hex");
		cert.validity.notBefore = new Date(Date.now() - 60_000);
		cert.validity.notAfter = new Date();
		cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
		const attrs = [
			{ name: "commonName", value: "vibe-coding-proxy Local CA" },
			{ name: "organizationName", value: "vibe-coding-proxy" },
		];
		cert.setSubject(attrs);
		cert.setIssuer(attrs);
		cert.setExtensions([
			{ name: "basicConstraints", cA: true, critical: true, pathLenConstraint: 1 },
			{ name: "keyUsage", keyCertSign: true, digitalSignature: true, cRLSign: true, critical: true },
			{ name: "subjectKeyIdentifier" },
			{ name: "authorityKeyIdentifier", keyIdentifier: true },
		]);
		cert.sign(keys.privateKey, forge.md.sha256.create());

		const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
		const certPem = forge.pki.certificateToPem(cert);
		fs.writeFileSync(this.caKeyPath, keyPem, { mode: 0o600 });
		fs.writeFileSync(this.caCertPath, certPem);
		this.authority = { key: keys.privateKey, cert, certPem };
		return this.authority;
	}
}

/** @returns Default persistent CA directory under the user's home directory. */
export function defaultCaDir(): string {
	return path.join(os.homedir(), ".claude-trace", "vibe-coding-proxy-ca");
}

/** Normalize hostnames before certificate generation and cache lookup. */
function normalizeCertHost(hostname: string): string {
	return hostname.trim().replace(/^\[|\]$/g, "").toLowerCase();
}

/** Convert hostnames into filesystem-safe cache file stems. */
function safeFileName(hostname: string): string {
	return hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
}

/** Return true when a PEM certificate is already expired. */
function isCertificateExpired(certPem: string, now: Date = new Date()): boolean {
	const cert = forge.pki.certificateFromPem(certPem);
	return cert.validity.notAfter.getTime() <= now.getTime();
}

/** Return true when a cached CA has the stricter MITM root extensions we expect. */
function isAuthorityCertificateUsable(certPem: string): boolean {
	try {
		const cert = forge.pki.certificateFromPem(certPem);
		return (
			!isCertificateExpired(certPem) &&
			hasExtension(cert, "basicConstraints") &&
			hasExtension(cert, "keyUsage") &&
			hasExtension(cert, "subjectKeyIdentifier") &&
			hasExtension(cert, "authorityKeyIdentifier")
		);
	} catch {
		return false;
	}
}

/** Return true when a cached leaf certificate has SAN and chain-linking extensions. */
function isLeafCertificateUsable(certPem: string): boolean {
	try {
		const cert = forge.pki.certificateFromPem(certPem);
		return (
			!isCertificateExpired(certPem) &&
			hasExtension(cert, "basicConstraints") &&
			hasExtension(cert, "keyUsage") &&
			hasExtension(cert, "extKeyUsage") &&
			hasExtension(cert, "subjectAltName") &&
			hasExtension(cert, "subjectKeyIdentifier") &&
			hasExtension(cert, "authorityKeyIdentifier")
		);
	} catch {
		return false;
	}
}

/** Check whether a parsed certificate contains an extension by name. */
function hasExtension(cert: forge.pki.Certificate, name: string): boolean {
	return Boolean(cert.getExtension({ name }));
}

/** Remove cached leaf certificates after the signing CA has been rotated. */
function removeCachedLeafCertificates(caDir: string): void {
	for (const entry of fs.readdirSync(caDir)) {
		if (entry === "ca.crt" || entry === "ca.key.pem") {
			continue;
		}
		if (entry.endsWith(".crt.pem") || entry.endsWith(".key.pem")) {
			fs.rmSync(path.join(caDir, entry), { force: true });
		}
	}
}

/** Build subjectAltName entries for DNS names and IP literals. */
function buildSubjectAltNames(hostname: string): Array<{ type: number; value?: string; ip?: string }> {
	if (isIpAddress(hostname)) {
		return [{ type: 7, ip: hostname }];
	}
	return [{ type: 2, value: hostname }];
}

/** @returns true when `hostname` is an IPv4 or IPv6 literal. */
function isIpAddress(hostname: string): boolean {
	return /^[0-9.]+$/.test(hostname) || hostname.includes(":");
}
