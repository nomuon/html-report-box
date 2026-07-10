/**
 * createAwsContext — assemble every AWS adapter + ReportService from the
 * Lambda environment contract defined in HrbAppStack (`serviceEnv`):
 *
 *   REPORTS_TABLE_NAME / SEARCH_TABLE_NAME      DynamoDB tables
 *   CONTENT_BUCKET / STAGING_BUCKET             S3 buckets
 *   USER_POOL_ID / USER_POOL_CLIENT_ID          Cognito (auth + user admin)
 *   COGNITO_DOMAIN                              Hosted UI domain (GET /config)
 *   CONTENT_BASE_URL                            content origin for /r/<id>/
 *   CONTENT_DISTRIBUTION_ID                     CloudFront (optional, static)
 *   CONTENT_DISTRIBUTION_ID_PARAM               ...or SSM param via options.resolveParameter
 *   DOMAIN_BLOCKLIST_BUCKET / DOMAIN_BLOCKLIST_KEY  S3 domain blocklist (optional)
 *
 * SDK clients, the JWT verifier and the presign function are all injectable
 * so unit tests never touch the network. The default SecurityScanner fails
 * closed until @hrb/scanner is wired in by the api package.
 *
 * Portable (Node 22 / Lambda); no Bun-only APIs.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DomainError } from "../errors.ts";
import { ReportService } from "../report-service.ts";
import type {
  DomainReputation,
  ScanResult,
  SecurityScanner,
  ZipExtractor,
} from "../ports.ts";
import { CognitoAuthVerifier, regionFromUserPoolId } from "./auth.ts";
import type { JwtVerifierLike } from "./auth.ts";
import { CloudFrontInvalidator } from "./cdn.ts";
import { S3DomainReputation } from "./domain-reputation.ts";
import { S3ObjectStorage } from "./object-storage.ts";
import type { PresignPostFn } from "./object-storage.ts";
import { DynamoReportRepository } from "./repository.ts";
import { DynamoSearchIndex } from "./search-index.ts";
import { CognitoUserAdmin } from "./user-admin.ts";
import type { CommandClient } from "./types.ts";

/** Fails closed: uploads cannot bypass scanning by misconfiguration. */
export class UnconfiguredScanner implements SecurityScanner {
  async scan(): Promise<ScanResult> {
    throw new DomainError("internal", "security scanner is not configured");
  }
}

/** Used when no blocklist bucket/key is configured. */
export class NoDomainReputation implements DomainReputation {
  async isMalicious(_host: string): Promise<boolean> {
    return false;
  }
}

export interface AwsEnv {
  REPORTS_TABLE_NAME?: string;
  SEARCH_TABLE_NAME?: string;
  CONTENT_BUCKET?: string;
  STAGING_BUCKET?: string;
  USER_POOL_ID?: string;
  USER_POOL_CLIENT_ID?: string;
  COGNITO_DOMAIN?: string;
  CONTENT_BASE_URL?: string;
  CONTENT_DISTRIBUTION_ID?: string;
  CONTENT_DISTRIBUTION_ID_PARAM?: string;
  DOMAIN_BLOCKLIST_BUCKET?: string;
  DOMAIN_BLOCKLIST_KEY?: string;
  AWS_REGION?: string;
  [key: string]: string | undefined;
}

export interface AwsContextOptions {
  /** Wire @hrb/scanner here; defaults to a fail-closed scanner. */
  scanner?: SecurityScanner;
  zipExtractor?: ZipExtractor;
  dailyUploadLimit?: number;
  presignedExpirySeconds?: number;
  now?: () => Date;
  newId?: () => string;
  /** Inject SDK clients (tests / custom endpoints). */
  clients?: {
    dynamo?: CommandClient;
    s3?: CommandClient;
    cloudfront?: CommandClient;
    cognito?: CommandClient;
  };
  /** Resolves CONTENT_DISTRIBUTION_ID_PARAM at runtime (e.g. SSM GetParameter). */
  resolveParameter?: (name: string) => Promise<string | undefined>;
  presignPost?: PresignPostFn;
  /** Injectable JWT verifier (tests). */
  jwtVerifier?: JwtVerifierLike;
}

export interface AwsContext {
  repo: DynamoReportRepository;
  searchIndex: DynamoSearchIndex;
  storage: S3ObjectStorage;
  auth: CognitoAuthVerifier;
  cdn: CloudFrontInvalidator;
  userAdmin: CognitoUserAdmin;
  domainReputation: DomainReputation;
  scanner: SecurityScanner;
  service: ReportService;
  /** Convenience passthroughs matching @hrb/api's AppContext. */
  contentBaseUrl: string;
  dailyUploadLimit?: number;
}

function requireEnv(env: AwsEnv, name: keyof AwsEnv & string): string {
  const value = env[name];
  if (!value) {
    throw new DomainError("internal", `missing required environment variable: ${name}`);
  }
  return value;
}

export function createAwsContext(env: AwsEnv, options: AwsContextOptions = {}): AwsContext {
  const reportsTable = requireEnv(env, "REPORTS_TABLE_NAME");
  const searchTable = requireEnv(env, "SEARCH_TABLE_NAME");
  const contentBucket = requireEnv(env, "CONTENT_BUCKET");
  const stagingBucket = requireEnv(env, "STAGING_BUCKET");
  const userPoolId = requireEnv(env, "USER_POOL_ID");
  const clientId = requireEnv(env, "USER_POOL_CLIENT_ID");
  const contentBaseUrl = requireEnv(env, "CONTENT_BASE_URL");
  const region = env.AWS_REGION ?? regionFromUserPoolId(userPoolId);

  const dynamo =
    options.clients?.dynamo ??
    DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  const s3 = options.clients?.s3 ?? new S3Client({ region });
  const cloudfront = options.clients?.cloudfront ?? new CloudFrontClient({ region });
  const cognito = options.clients?.cognito ?? new CognitoIdentityProviderClient({ region });

  const repo = new DynamoReportRepository({
    client: dynamo,
    tableName: reportsTable,
    ...(options.dailyUploadLimit !== undefined
      ? { dailyUploadLimit: options.dailyUploadLimit }
      : {}),
  });
  const searchIndex = new DynamoSearchIndex({ client: dynamo, tableName: searchTable });
  const storage = new S3ObjectStorage({
    client: s3,
    stagingBucket,
    contentBucket,
    ...(options.presignPost ? { presignPost: options.presignPost } : {}),
  });

  const auth = new CognitoAuthVerifier({
    userPoolId,
    clientId,
    region,
    // Hosted UI domain is only needed by GET /config; empty string keeps the
    // adapter constructible when the env var is not yet provisioned.
    domain: env.COGNITO_DOMAIN ?? "",
    ...(options.jwtVerifier ? { verifier: options.jwtVerifier } : {}),
  });
  const userAdmin = new CognitoUserAdmin({ client: cognito, userPoolId });

  const distributionIdParam = env.CONTENT_DISTRIBUTION_ID_PARAM;
  const resolveParameter = options.resolveParameter;
  const cdn = new CloudFrontInvalidator({
    client: cloudfront,
    ...(env.CONTENT_DISTRIBUTION_ID ? { distributionId: env.CONTENT_DISTRIBUTION_ID } : {}),
    ...(distributionIdParam && resolveParameter
      ? { resolveDistributionId: () => resolveParameter(distributionIdParam) }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  const domainReputation: DomainReputation =
    env.DOMAIN_BLOCKLIST_BUCKET && env.DOMAIN_BLOCKLIST_KEY
      ? new S3DomainReputation({
          client: s3,
          bucket: env.DOMAIN_BLOCKLIST_BUCKET,
          key: env.DOMAIN_BLOCKLIST_KEY,
        })
      : new NoDomainReputation();

  const scanner = options.scanner ?? new UnconfiguredScanner();

  const service = new ReportService({
    repo,
    search: searchIndex,
    storage,
    scanner,
    cdn,
    contentBaseUrl,
    ...(options.zipExtractor ? { zipExtractor: options.zipExtractor } : {}),
    ...(options.dailyUploadLimit !== undefined
      ? { dailyUploadLimit: options.dailyUploadLimit }
      : {}),
    ...(options.presignedExpirySeconds !== undefined
      ? { presignedExpirySeconds: options.presignedExpirySeconds }
      : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.newId ? { newId: options.newId } : {}),
  });

  return {
    repo,
    searchIndex,
    storage,
    auth,
    cdn,
    userAdmin,
    domainReputation,
    scanner,
    service,
    contentBaseUrl,
    ...(options.dailyUploadLimit !== undefined
      ? { dailyUploadLimit: options.dailyUploadLimit }
      : {}),
  };
}
