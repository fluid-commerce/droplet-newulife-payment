/**
 * Storage port for callback verification tokens.
 *
 * Deliberately narrow: this package owns one table and nothing else.
 * Installation and company storage stay app-owned.
 */

export interface StoredRegistration {
  /** Fluid's `cbr_` registration uuid. */
  uuid: string;
  /** droplet_installation_uuid (`dri_`) this registration belongs to. */
  dri: string;
  /** Which callback definition this registration serves. */
  definitionName: string;
  /** sha256 of the `cvt_` token. Never the token itself. */
  tokenDigest: string;
  url: string;
}

export interface CallbackTokenStore {
  /** Locate a registration by the digest of a presented token. Must be an indexed lookup. */
  findByTokenDigest(digest: string): Promise<StoredRegistration | null>;

  upsert(registration: StoredRegistration): Promise<void>;
  deleteForInstallation(dri: string): Promise<void>;
}
