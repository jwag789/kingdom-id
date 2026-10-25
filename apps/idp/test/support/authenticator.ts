import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

const b64url = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | Buffer | string) => createHash("sha256").update(b).digest();

// Authenticator data flags (WebAuthn §6.1).
const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

/**
 * A software WebAuthn authenticator that produces real attestations and
 * assertions (P-256, "none" attestation), so the server's verification runs
 * unmodified in tests. Holds one discoverable credential, like a passkey.
 */
export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly cosePublicKey: Uint8Array;
  private signCount = 0;
  userHandle: string | undefined;

  constructor(
    private readonly origin: string,
    private readonly opts: { synced?: boolean; userVerification?: boolean } = {},
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    // COSE_Key for ES256: kty EC2 (2), alg -7, crv P-256 (1), x, y.
    this.cosePublicKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
  }

  get id() {
    return b64url(this.credentialId);
  }

  create(options: PublicKeyCredentialCreationOptionsJSON): RegistrationResponseJSON {
    this.userHandle = options.user.id;
    const clientDataJSON = JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false });
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      this.header(options.rp.id!, AT),
      Buffer.alloc(16), // AAGUID: all zeros, as many software authenticators report
      idLength,
      this.credentialId,
      Buffer.from(this.cosePublicKey),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(authData)],
      ]) as never,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(Buffer.from(clientDataJSON)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  get(
    options: PublicKeyCredentialRequestOptionsJSON,
    overrides: { origin?: string; userHandle?: string } = {},
  ): AuthenticationResponseJSON {
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: overrides.origin ?? this.origin, crossOrigin: false }),
    );
    const authData = this.header(options.rpId!, 0);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: overrides.userHandle ?? this.userHandle,
      },
    };
  }

  /** Rewinds the signature counter, as a cloned authenticator would. */
  rewindCounter() {
    this.signCount = Math.max(0, this.signCount - 2);
  }

  private header(rpId: string, extraFlags: number) {
    let flags = UP | extraFlags;
    if (this.opts.userVerification !== false) flags |= UV;
    if (this.opts.synced) flags |= BE | BS;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(++this.signCount);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), count]);
  }
}
