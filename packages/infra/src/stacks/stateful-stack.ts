/**
 * HrbStatefulStack — DynamoDB (hrb-reports + GSI1/GSI2, hrb-search),
 * S3 x3 (app / content[versioned] / staging[lifecycle]), Cognito UserPool
 * (Google IdP, admin group, SPA PKCE client).
 */
import {
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
  aws_cognito as cognito,
  aws_dynamodb as dynamodb,
  aws_iam as iam,
  aws_s3 as s3,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { HrbInfraConfig } from "../config.ts";

/** Staging keys live under this prefix and expire after 1 day. */
export const STAGING_PREFIX = "staging/";
/** Blocked-upload specimens are copied under this prefix and kept 30 days. */
export const QUARANTINE_PREFIX = "quarantine/";

export interface HrbStatefulStackProps extends StackProps {
  config: HrbInfraConfig;
}

export class HrbStatefulStack extends Stack {
  readonly reportsTable: dynamodb.Table;
  readonly searchTable: dynamodb.Table;
  readonly appBucket: s3.Bucket;
  readonly contentBucket: s3.Bucket;
  readonly stagingBucket: s3.Bucket;
  readonly userPool: cognito.UserPool;
  readonly spaClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: HrbStatefulStackProps) {
    super(scope, id, props);
    const { config } = props;

    // ---- DynamoDB ----

    // hrb-reports: pk=R#<id>, sk=META|TOKENS (+ flag/counter items).
    // GSI1 = sparse published list (gsi1pk="PUB", gsi1sk=updatedAt desc scan).
    // GSI2 = per-owner list (gsi2pk=ownerSub, gsi2sk=updatedAt).
    this.reportsTable = new dynamodb.Table(this, "ReportsTable", {
      tableName: "hrb-reports",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.reportsTable.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    this.reportsTable.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "gsi2pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi2sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // hrb-search: inverted index. pk=token, sk=reportId, attrs {w, u}.
    this.searchTable = new dynamodb.Table(this, "SearchTable", {
      tableName: "hrb-search",
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- S3 ----

    const bucketDefaults = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    } satisfies s3.BucketProps;

    // SPA assets (Distribution A default origin).
    this.appBucket = new s3.Bucket(this, "AppBucket", {
      ...bucketDefaults,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Published report content: reports/<id>/... (Distribution B origin).
    // Versioned for audit / takedown forensics.
    this.contentBucket = new s3.Bucket(this, "ContentBucket", {
      ...bucketDefaults,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Staging: presigned-POST target. staging/* expires in 1 day,
    // quarantine/* (blocked specimens) kept 30 days.
    this.stagingBucket = new s3.Bucket(this, "StagingBucket", {
      ...bucketDefaults,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          id: "expire-staging-1d",
          prefix: STAGING_PREFIX,
          expiration: Duration.days(1),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
        {
          id: "expire-quarantine-30d",
          prefix: QUARANTINE_PREFIX,
          expiration: Duration.days(30),
        },
      ],
    });

    // CloudFront OAC read access for app/content buckets. The distributions
    // live in HrbCdnStack; referencing their ARNs here would create a stack
    // cycle (stateful -> cdn -> app -> stateful), so we scope by SourceAccount
    // instead and HrbCdnStack imports the buckets by name.
    // TODO(post-deploy hardening): tighten Condition to the two distribution
    // ARNs once the stacks are split or ARNs are pinned via context.
    for (const bucket of [this.appBucket, this.contentBucket]) {
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "AllowCloudFrontOacRead",
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
          actions: ["s3:GetObject"],
          resources: [bucket.arnForObjects("*")],
          conditions: { StringEquals: { "aws:SourceAccount": this.account } },
        }),
      );
    }

    // ---- Cognito ----

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "hrb-users",
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.userPool.addDomain("HostedDomain", {
      cognitoDomain: { domainPrefix: config.cognitoDomainPrefix },
    });

    // Google IdP. Client secret is referenced from SSM SecureString, never
    // embedded in the template.
    // NOTE: CloudFormation restricts {{resolve:ssm-secure}} to a fixed list of
    // resource properties; if Cognito IdP rejects it at deploy time, switch to
    // Secrets Manager (SecretValue.secretsManager) — synth is unaffected.
    const googleIdp = new cognito.UserPoolIdentityProviderGoogle(this, "GoogleIdp", {
      userPool: this.userPool,
      clientId: config.googleClientId,
      clientSecretValue: SecretValue.ssmSecure(config.googleClientSecretSsmParam),
      scopes: ["openid", "email", "profile"],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        fullname: cognito.ProviderAttribute.GOOGLE_NAME,
      },
    });

    const callbackUrls = [
      ...(config.appDomain ? [`https://${config.appDomain}/auth/callback`] : []),
      "http://localhost:5173/auth/callback",
    ];
    const logoutUrls = [
      ...(config.appDomain ? [`https://${config.appDomain}/`] : []),
      "http://localhost:5173/",
    ];

    // SPA client: public client (no secret) => authorization code + PKCE.
    this.spaClient = this.userPool.addClient("SpaClient", {
      userPoolClientName: "hrb-spa",
      generateSecret: false,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.GOOGLE],
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls,
      },
    });
    this.spaClient.node.addDependency(googleIdp);

    new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      userPoolId: this.userPool.userPoolId,
      groupName: "admin",
      description: "HTML Report Box administrators (approve/reject/takedown)",
    });
  }
}
