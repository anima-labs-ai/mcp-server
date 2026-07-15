import { describe, expect, test } from "bun:test";
import { maskCredentialFields } from "../vault/index.js";

describe("maskCredentialFields", () => {
	test("masks login password and totp, leaves username and uris", () => {
		const masked = maskCredentialFields({
			id: "cred_1",
			type: "login",
			name: "Acme Portal",
			login: {
				username: "bot@acme.io",
				password: "hunter2",
				totp: "JBSWY3DPEHPK3PXP",
				uris: [{ uri: "https://acme.io" }],
			},
		});

		const login = masked.login as Record<string, unknown>;
		expect(login.password).toBe("****");
		expect(login.totp).toBe("****");
		expect(login.username).toBe("bot@acme.io");
		expect(login.uris).toEqual([{ uri: "https://acme.io" }]);
		expect(masked.name).toBe("Acme Portal");
	});

	test("masks card code and keeps last 4 of the number", () => {
		const masked = maskCredentialFields({
			card: { cardholderName: "Bot", number: "4111111111111234", code: "123" },
		});

		const card = masked.card as Record<string, unknown>;
		expect(card.code).toBe("****");
		expect(card.number).toBe("****1234");
		expect(card.cardholderName).toBe("Bot");
	});

	test("masks oauthToken secrets and omits refreshToken entirely", () => {
		const masked = maskCredentialFields({
			oauthToken: {
				provider: "google",
				accessToken: "ya29.secret",
				refreshToken: "1//refresh-secret",
				idToken: "eyJhbGciOi.secret",
				clientSecret: "GOCSPX-secret",
			},
		});

		const oauth = masked.oauthToken as Record<string, unknown>;
		expect(oauth.accessToken).toBe("****");
		expect(oauth.idToken).toBe("****");
		expect(oauth.clientSecret).toBe("****");
		expect("refreshToken" in oauth).toBe(false);
		expect(oauth.provider).toBe("google");
	});

	test("masks apiKey keeping prefix and last 4", () => {
		const masked = maskCredentialFields({
			apiKey: { key: "sk_live_abcdefgh1234" },
		});

		expect((masked.apiKey as Record<string, unknown>).key).toBe("sk_****1234");
	});

	test("masks certificate privateKey only", () => {
		const masked = maskCredentialFields({
			certificate: {
				certificate: "-----BEGIN CERTIFICATE-----",
				privateKey: "-----BEGIN PRIVATE KEY-----",
			},
		});

		const cert = masked.certificate as Record<string, unknown>;
		expect(cert.privateKey).toBe("****");
		expect(cert.certificate).toBe("-----BEGIN CERTIFICATE-----");
	});

	test("masks identity ssn, passportNumber and licenseNumber", () => {
		const masked = maskCredentialFields({
			identity: {
				firstName: "Ada",
				ssn: "123-45-6789",
				passportNumber: "X1234567",
				licenseNumber: "D9876543",
			},
		});

		const identity = masked.identity as Record<string, unknown>;
		expect(identity.ssn).toBe("****");
		expect(identity.passportNumber).toBe("****");
		expect(identity.licenseNumber).toBe("****");
		expect(identity.firstName).toBe("Ada");
	});

	test("is idempotent over an already-API-masked credential", () => {
		// This masker re-runs on responses the API has already masked;
		// identifying forms (prefix + last 4) must survive the second pass.
		const apiMasked = {
			login: { username: "bot@acme.io", password: "****" },
			card: { number: "****1234", code: "****" },
			apiKey: { key: "sk_****1234" },
		};

		const masked = maskCredentialFields(apiMasked);

		expect((masked.login as Record<string, unknown>).password).toBe("****");
		expect((masked.card as Record<string, unknown>).number).toBe("****1234");
		expect((masked.apiKey as Record<string, unknown>).key).toBe("sk_****1234");
	});

	test("does not mutate the input credential", () => {
		const input = {
			login: { username: "bot@acme.io", password: "hunter2" },
			oauthToken: { refreshToken: "1//refresh-secret" },
		};

		maskCredentialFields(input);

		expect(input.login.password).toBe("hunter2");
		expect(input.oauthToken.refreshToken).toBe("1//refresh-secret");
	});

	test("passes through credentials with no maskable content", () => {
		const masked = maskCredentialFields({
			id: "cred_2",
			type: "login",
			name: "Just a name",
		});

		expect(masked).toEqual({
			id: "cred_2",
			type: "login",
			name: "Just a name",
		});
	});

	// Never-see: a secure_note body IS the secret (the fill flow stores the
	// human-typed value here) and hidden custom fields are secret by type. An
	// agent must not read them back verbatim.
	test("masks a secure_note body", () => {
		const masked = maskCredentialFields({
			id: "cred_3",
			type: "secure_note",
			notes: "recovery-code 8f3a-1c2d",
		});

		expect(masked.notes).toBe("****");
	});

	test("masks hidden custom fields but leaves text fields", () => {
		const masked = maskCredentialFields({
			id: "cred_4",
			type: "login",
			fields: [
				{ name: "pin", value: "1234", type: "hidden" },
				{ name: "env", value: "prod", type: "text" },
			],
		});

		const fields = masked.fields as Array<Record<string, unknown>>;
		expect(fields[0].value).toBe("****");
		expect(fields[1].value).toBe("prod");
	});
});
