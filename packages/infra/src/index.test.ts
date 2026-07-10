/**
 * @hrb/infra tests — Template.fromStack assertions (WAF association, S3
 * non-public, CSP header values, GSI definitions) + full-template snapshots.
 *
 * The app assembly mirrors bin/hrb.ts but with a fixed config and inline
 * Lambda code (apiCode/mcpCode overrides) so templates are deterministic
 * (no asset hashes from dist/ bundles).
 */
import { describe, expect, test } from "bun:test";
import { App, aws_lambda as lambda } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import type { HrbInfraConfig } from "./config.ts";
import { buildContentCsp, CONTENT_X_ROBOTS_TAG } from "./content-csp.ts";
import { PLACEHOLDER_HANDLER_CODE } from "./lambda-code.ts";
import { PACKAGE_NAME } from "./index.ts";
import { HrbAppStack } from "./stacks/app-stack.ts";
import {
  APP_VIEWER_REQUEST_CODE,
  CONTENT_VIEWER_REQUEST_CODE,
  HrbCdnStack,
} from "./stacks/cdn-stack.ts";
import { HrbEdgeStack } from "./stacks/edge-stack.ts";
import { HrbStatefulStack } from "./stacks/stateful-stack.ts";

const TEST_CONFIG: HrbInfraConfig = {
  account: "111111111111",
  region: "ap-northeast-1",
  allowedCidrs: ["10.0.0.0/8", "192.0.2.0/24"],
  domain: undefined,
  appDomain: undefined,
  contentDomain: undefined,
  googleClientId: "test-google-client-id.apps.googleusercontent.com",
  googleClientSecretSsmParam: "/hrb/google-client-secret",
  cognitoDomainPrefix: "hrb-test",
  originVerifySecret: "test-origin-verify-secret",
  wafRateLimit: 1234,
  contentBaseUrl: "https://content.invalid",
};

interface SynthResult {
  edge: Template;
  stateful: Template;
  app: Template;
  cdn: Template;
}

function synthAll(): SynthResult {
  const app = new App();
  const config = TEST_CONFIG;
  const env = { account: config.account, region: config.region };

  const edge = new HrbEdgeStack(app, "HrbEdgeStack", {
    env: { account: config.account, region: "us-east-1" },
    crossRegionReferences: true,
    config,
  });
  const stateful = new HrbStatefulStack(app, "HrbStatefulStack", { env, config });
  const appStack = new HrbAppStack(app, "HrbAppStack", {
    env,
    config,
    reportsTable: stateful.reportsTable,
    searchTable: stateful.searchTable,
    contentBucket: stateful.contentBucket,
    stagingBucket: stateful.stagingBucket,
    userPool: stateful.userPool,
    spaClient: stateful.spaClient,
    apiCode: lambda.Code.fromInline(PLACEHOLDER_HANDLER_CODE),
    mcpCode: lambda.Code.fromInline(PLACEHOLDER_HANDLER_CODE),
  });
  const cdn = new HrbCdnStack(app, "HrbCdnStack", {
    env,
    crossRegionReferences: true,
    config,
    appBucketName: stateful.appBucket.bucketName,
    contentBucketName: stateful.contentBucket.bucketName,
    httpApiDomain: appStack.httpApiDomain,
    appWebAclArn: edge.appWebAclArn,
    contentWebAclArn: edge.contentWebAclArn,
  });

  return {
    edge: Template.fromStack(edge),
    stateful: Template.fromStack(stateful),
    app: Template.fromStack(appStack),
    cdn: Template.fromStack(cdn),
  };
}

const t = synthAll();

test("@hrb/infra exports package name", () => {
  expect(PACKAGE_NAME).toBe("@hrb/infra");
});

// ---- HrbEdgeStack (WAF, us-east-1) ----

describe("HrbEdgeStack", () => {
  test("two CLOUDFRONT-scoped WebACLs with default Block", () => {
    t.edge.resourceCountIs("AWS::WAFv2::WebACL", 2);
    t.edge.allResourcesProperties("AWS::WAFv2::WebACL", {
      Scope: "CLOUDFRONT",
      DefaultAction: { Block: {} },
    });
  });

  test("IPSet carries the allowedCidrs context", () => {
    t.edge.hasResourceProperties("AWS::WAFv2::IPSet", {
      Scope: "CLOUDFRONT",
      IPAddressVersion: "IPV4",
      Addresses: TEST_CONFIG.allowedCidrs,
    });
  });

  test("every ACL has rate-limit rule (priority 0) + IPSet allow rule (priority 1)", () => {
    t.edge.allResourcesProperties("AWS::WAFv2::WebACL", {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: "rate-limit",
          Priority: 0,
          Action: { Block: {} },
          Statement: {
            RateBasedStatement: { Limit: TEST_CONFIG.wafRateLimit, AggregateKeyType: "IP" },
          },
        }),
        Match.objectLike({
          Name: "allow-internal-cidrs",
          Priority: 1,
          Action: { Allow: {} },
          Statement: { IPSetReferenceStatement: Match.objectLike({}) },
        }),
      ]),
    });
  });
});

// ---- HrbStatefulStack (DynamoDB / S3 / Cognito) ----

describe("HrbStatefulStack", () => {
  test("hrb-reports table defines GSI1 and GSI2", () => {
    t.stateful.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "hrb-reports",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "GSI1",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        }),
        Match.objectLike({
          IndexName: "GSI2",
          KeySchema: [
            { AttributeName: "gsi2pk", KeyType: "HASH" },
            { AttributeName: "gsi2sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        }),
      ]),
    });
  });

  test("hrb-search inverted index table (pk=token, sk=reportId)", () => {
    t.stateful.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "hrb-search",
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
  });

  test("all three buckets block public access and enforce SSL", () => {
    t.stateful.resourceCountIs("AWS::S3::Bucket", 3);
    t.stateful.allResourcesProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    // enforceSSL adds a deny-insecure-transport statement to each bucket policy.
    const policies = t.stateful.findResources("AWS::S3::BucketPolicy");
    expect(Object.keys(policies).length).toBe(3);
    for (const policy of Object.values(policies)) {
      const statements = (policy as any).Properties.PolicyDocument.Statement as any[];
      expect(
        statements.some(
          (s) => s.Effect === "Deny" && s.Condition?.Bool?.["aws:SecureTransport"] === "false",
        ),
      ).toBe(true);
    }
  });

  test("content bucket is versioned", () => {
    t.stateful.hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
    });
  });

  test("staging bucket lifecycle: staging/ 1 day, quarantine/ 30 days", () => {
    t.stateful.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: "staging/", ExpirationInDays: 1, Status: "Enabled" }),
          Match.objectLike({ Prefix: "quarantine/", ExpirationInDays: 30, Status: "Enabled" }),
        ]),
      },
    });
  });

  test("Cognito: Google IdP with SSM-secure secret, admin group, PKCE SPA client", () => {
    t.stateful.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderType: "Google",
      ProviderDetails: Match.objectLike({
        client_id: TEST_CONFIG.googleClientId,
        client_secret: Match.stringLikeRegexp("resolve:ssm-secure:/hrb/google-client-secret"),
      }),
    });
    t.stateful.hasResourceProperties("AWS::Cognito::UserPoolGroup", {
      GroupName: "admin",
    });
    t.stateful.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      SupportedIdentityProviders: ["Google"],
    });
  });
});

// ---- HrbAppStack (Lambdas / HTTP API / schedules) ----

describe("HrbAppStack", () => {
  test("api and mcp Lambdas run Node 22", () => {
    t.app.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "hrb-api",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
    });
    t.app.hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "hrb-mcp",
      Runtime: "nodejs22.x",
      Handler: "index.handler",
    });
  });

  test("HTTP API routes /api/* and /mcp to Lambda integrations", () => {
    t.app.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /api/{proxy+}",
    });
    t.app.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "ANY /mcp" });
    t.app.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "ANY /mcp/{proxy+}",
    });
  });

  test("daily domain-feed and weekly rescan schedules exist", () => {
    t.app.hasResourceProperties("AWS::Events::Rule", {
      Name: "hrb-daily-domain-feed",
      ScheduleExpression: "cron(0 3 * * ? *)",
    });
    t.app.hasResourceProperties("AWS::Events::Rule", {
      Name: "hrb-weekly-rescan",
      ScheduleExpression: "cron(0 4 ? * SUN *)",
    });
  });
});

// ---- HrbCdnStack (CloudFront x2 / headers / functions) ----

describe("HrbCdnStack", () => {
  test("both distributions are WAF-associated", () => {
    t.cdn.resourceCountIs("AWS::CloudFront::Distribution", 2);
    t.cdn.allResourcesProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({ WebACLId: Match.anyValue() }),
    });
  });

  test("content response headers policy: CSP / nosniff / no-referrer / X-Robots-Tag", () => {
    const csp = buildContentCsp();
    // Spot-check the security-critical directives derived from the plan.
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).not.toContain("unsafe-eval");

    t.cdn.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: { ContentSecurityPolicy: csp, Override: true },
          ContentTypeOptions: { Override: true },
          ReferrerPolicy: { ReferrerPolicy: "no-referrer", Override: true },
        }),
        CustomHeadersConfig: {
          Items: [{ Header: "X-Robots-Tag", Value: CONTENT_X_ROBOTS_TAG, Override: true }],
        },
      }),
    });
  });

  test("app distribution proxies /api/* and /mcp with x-origin-verify header", () => {
    t.cdn.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: "/api/*" }),
          Match.objectLike({ PathPattern: "/mcp" }),
          Match.objectLike({ PathPattern: "/mcp/*" }),
        ]),
      }),
    });
    t.cdn.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([
          Match.objectLike({
            OriginCustomHeaders: [
              { HeaderName: "x-origin-verify", HeaderValue: TEST_CONFIG.originVerifySecret },
            ],
          }),
        ]),
      }),
    });
  });

  test("two CloudFront Functions are deployed (content routing + SPA fallback)", () => {
    t.cdn.resourceCountIs("AWS::CloudFront::Function", 2);
  });
});

// ---- CloudFront Function logic (evaluated as plain JS) ----

type CfRequest = { uri: string };
type CfResult = CfRequest | { statusCode: number; statusDescription: string };

/**
 * Test-only evaluation of CloudFront Function source. `code` is always one of
 * the compile-time constants exported by cdn-stack.ts (never runtime or user
 * input), so building a Function from it is safe here.
 */
function runCfFunction(code: string, uri: string): CfResult {
  const fn = new Function(`${code}; return handler;`)() as (event: {
    request: CfRequest;
  }) => CfResult;
  return fn({ request: { uri } });
}

describe("content viewer-request function", () => {
  test("serves /r/<id>/ as reports/<id>/index.html", () => {
    expect(runCfFunction(CONTENT_VIEWER_REQUEST_CODE, "/r/abc123/")).toEqual({
      uri: "/reports/abc123/index.html",
    });
    expect(runCfFunction(CONTENT_VIEWER_REQUEST_CODE, "/r/abc123/assets/app.css")).toEqual({
      uri: "/reports/abc123/assets/app.css",
    });
  });

  test("404s dot-prefixed keys (hides .extracted.txt)", () => {
    expect(runCfFunction(CONTENT_VIEWER_REQUEST_CODE, "/r/abc123/.extracted.txt")).toEqual({
      statusCode: 404,
      statusDescription: "Not Found",
    });
    expect(runCfFunction(CONTENT_VIEWER_REQUEST_CODE, "/r/abc123/.hidden/x.html")).toEqual({
      statusCode: 404,
      statusDescription: "Not Found",
    });
  });

  test("404s everything outside /r/*", () => {
    expect(runCfFunction(CONTENT_VIEWER_REQUEST_CODE, "/reports/abc123/index.html")).toEqual({
      statusCode: 404,
      statusDescription: "Not Found",
    });
    expect(runCfFunction(CONTENT_VIEWER_REQUEST_CODE, "/")).toEqual({
      statusCode: 404,
      statusDescription: "Not Found",
    });
  });
});

describe("app viewer-request function", () => {
  test("rewrites extensionless SPA routes to /index.html, keeps assets", () => {
    expect(runCfFunction(APP_VIEWER_REQUEST_CODE, "/reports/abc123")).toEqual({
      uri: "/index.html",
    });
    expect(runCfFunction(APP_VIEWER_REQUEST_CODE, "/assets/app-1234.js")).toEqual({
      uri: "/assets/app-1234.js",
    });
  });
});

// ---- Snapshots ----

describe("template snapshots", () => {
  test("HrbEdgeStack", () => {
    expect(t.edge.toJSON()).toMatchSnapshot();
  });
  test("HrbStatefulStack", () => {
    expect(t.stateful.toJSON()).toMatchSnapshot();
  });
  test("HrbAppStack", () => {
    expect(t.app.toJSON()).toMatchSnapshot();
  });
  test("HrbCdnStack", () => {
    expect(t.cdn.toJSON()).toMatchSnapshot();
  });
});
