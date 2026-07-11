/**
 * Local adapter wiring for APP_MODE=local (api dev server, seed, tests).
 * Local-only module — may use Bun APIs; never bundled for Lambda.
 */
import type { AuthVerifier, SecurityScanner, SessionAuth, UserAdmin, ZipExtractor } from "../ports.ts";
import { ReportService } from "../report-service.ts";
import { DevAuthVerifier } from "./auth.ts";
import { GoogleAuthVerifier } from "./google-auth.ts";
import type { GoogleIdTokenVerifier } from "./google-auth.ts";
import { LocalObjectStorage } from "./object-storage.ts";
import { LocalReportRepository } from "./repository.ts";
import { LocalSearchIndex } from "./search-index.ts";
import { LocalUserAdmin, NoopCdnInvalidator, PassthroughScanner, StubDomainReputation } from "./stubs.ts";

export { DEV_USERS, DEV_USER_HEADER, DevAuthVerifier, getDevUser } from "./auth.ts";
export {
  GoogleAuthVerifier,
  createGoogleIdTokenVerifier,
  type GoogleAuthOptions,
  type GoogleIdTokenPayload,
  type GoogleIdTokenVerifier,
} from "./google-auth.ts";
export { JsonStore } from "./json-store.ts";
export { LocalObjectStorage } from "./object-storage.ts";
export { LocalReportRepository } from "./repository.ts";
export { LocalSearchIndex } from "./search-index.ts";
export { LocalUserAdmin, NoopCdnInvalidator, PassthroughScanner, StubDomainReputation } from "./stubs.ts";

export interface LocalContextOptions {
  /** Directory for JSON state + objects (default: .local-data). */
  dataDir?: string;
  /** Origin serving uploaded content in dev (default: http://localhost:3000). */
  contentBaseUrl?: string;
  /** Replace the pass-through scanner (e.g. with @hrb/scanner). */
  scanner?: SecurityScanner;
  zipExtractor?: ZipExtractor;
  dailyUploadLimit?: number;
  now?: () => Date;
  newId?: () => string;
  /**
   * Enables real Google login (GIS) instead of the dev-user header. The dev
   * server passes this through from GOOGLE_CLIENT_ID / HRB_ADMIN_EMAILS.
   */
  googleAuth?: {
    clientId: string;
    adminEmails?: string[];
    verifyIdToken?: GoogleIdTokenVerifier;
  };
}

export interface LocalContext {
  repo: LocalReportRepository;
  searchIndex: LocalSearchIndex;
  storage: LocalObjectStorage;
  auth: AuthVerifier;
  /** Present in google mode: login/logout endpoints plug into this. */
  sessionAuth?: SessionAuth;
  cdn: NoopCdnInvalidator;
  userAdmin: UserAdmin;
  domainReputation: StubDomainReputation;
  scanner: SecurityScanner;
  service: ReportService;
}

export function createLocalContext(options: LocalContextOptions = {}): LocalContext {
  const dataDir = options.dataDir ?? ".local-data";
  const repo = new LocalReportRepository(dataDir);
  const searchIndex = new LocalSearchIndex(dataDir);
  const storage = new LocalObjectStorage(dataDir);
  const googleAuth = options.googleAuth
    ? new GoogleAuthVerifier({ ...options.googleAuth, dataDir, ...(options.now ? { now: options.now } : {}) })
    : null;
  const auth = googleAuth ?? new DevAuthVerifier();
  const cdn = new NoopCdnInvalidator();
  const userAdmin = googleAuth ? googleAuth.userAdmin() : new LocalUserAdmin();
  const domainReputation = new StubDomainReputation();
  const scanner = options.scanner ?? new PassthroughScanner();

  const service = new ReportService({
    repo,
    search: searchIndex,
    storage,
    scanner,
    cdn,
    contentBaseUrl: options.contentBaseUrl ?? "http://localhost:3000",
    ...(options.zipExtractor ? { zipExtractor: options.zipExtractor } : {}),
    ...(options.dailyUploadLimit !== undefined
      ? { dailyUploadLimit: options.dailyUploadLimit }
      : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.newId ? { newId: options.newId } : {}),
  });

  return {
    repo,
    searchIndex,
    storage,
    auth,
    ...(googleAuth ? { sessionAuth: googleAuth } : {}),
    cdn,
    userAdmin,
    domainReputation,
    scanner,
    service,
  };
}
