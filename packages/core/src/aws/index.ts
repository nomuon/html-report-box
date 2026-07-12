/**
 * @hrb/core/aws — AWS adapters for the core ports (S6).
 * DynamoDB (reports repository + search index), S3 (staging/content storage,
 * domain blocklist), Cognito (auth verifier + user admin), CloudFront
 * (invalidation) and the createAwsContext(env) factory.
 *
 * Everything here is portable (Node 22 / Lambda); no Bun-only APIs.
 */
export type { CommandClient } from "./types.ts";
export { decodeKeyCursor, encodeKeyCursor } from "./cursor.ts";
export {
  DynamoReportRepository,
  type DynamoReportRepositoryOptions,
  metaToItem,
  itemToMeta,
  reportPk,
  quotaPk,
  quotaSk,
  SK_META,
  SK_TOKENS,
  SK_UPLOAD,
  FLAG_SK_PREFIX,
  GSI1_NAME,
  GSI2_NAME,
  GSI1_PUBLISHED_PK,
} from "./repository.ts";
export { DynamoSearchIndex, type DynamoSearchIndexOptions } from "./search-index.ts";
export {
  DynamoApiKeyStore,
  type DynamoApiKeyStoreOptions,
  apiKeyHashPk,
  apiKeyOwnerPk,
  APIKEY_SK,
  APIKEY_OWNER_SK_PREFIX,
} from "./api-keys.ts";
export {
  S3ObjectStorage,
  type S3ObjectStorageOptions,
  type PresignPostFn,
  type PresignPostParams,
  DELETE_OBJECTS_CHUNK,
} from "./object-storage.ts";
export {
  CognitoAuthVerifier,
  type CognitoAuthVerifierOptions,
  type CognitoIdTokenPayload,
  type JwtVerifierLike,
  regionFromUserPoolId,
  COGNITO_ADMIN_GROUP,
  GROUPS_CLAIM,
} from "./auth.ts";
export { CognitoUserAdmin, type CognitoUserAdminOptions } from "./user-admin.ts";
export { CloudFrontInvalidator, type CloudFrontInvalidatorOptions } from "./cdn.ts";
export {
  S3DomainReputation,
  type S3DomainReputationOptions,
  DEFAULT_BLOCKLIST_TTL_MS,
} from "./domain-reputation.ts";
export {
  createAwsContext,
  UnconfiguredScanner,
  NoDomainReputation,
  type AwsContext,
  type AwsContextOptions,
  type AwsEnv,
} from "./context.ts";
